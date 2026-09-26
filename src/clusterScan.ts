/**
 * One read of each signed-in cluster for three views:
 *  - applications: Deployments, StatefulSets and DaemonSets outside platform
 *    namespaces, grouped by app name across clusters, with image drift;
 *  - security posture: Pod Security levels, privileged pods, cluster-admin
 *    grants to people, images from unapproved registries or on "latest",
 *    cert-manager certificates expiring or failing;
 *  - GitOps: Argo CD Applications and Flux Kustomizations / HelmReleases.
 * Anything not installed or not allowed is skipped.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { parseConditions } from './capi/v1beta1';
import { refusedPods } from './pss';
import { isPlatformNamespace } from './workload';

export interface AppWorkload {
  clusterKey: string;
  clusterName: string;
  namespace: string;
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  name: string;
  app: string;
  ready: number;
  desired: number;
  images: string[];
}

export type SecurityKind = 'psa' | 'privileged' | 'cluster-admin' | 'wildcard' | 'secrets' | 'registry' | 'latest' | 'root' | 'netpol' | 'exposed' | 'cert';

export const SECURITY_KIND_LABEL: Record<SecurityKind, string> = {
  psa: 'Pod Security',
  privileged: 'Privileged pods',
  'cluster-admin': 'cluster-admin',
  wildcard: 'Wildcard RBAC',
  secrets: 'Secret readers',
  registry: 'Registries',
  latest: '"latest" images',
  root: 'Root',
  netpol: 'Network policies',
  exposed: 'Exposed services',
  cert: 'Certificates',
};

/** One user namespace's security posture, for the Pod Security and network actions. */
export interface NamespacePosture {
  name: string;
  enforce?: string;
  warn?: string;
  pods: number;
  netpols: number;
  exposed: string[];
  /** Running pods each level would refuse (on restart or when created), with reasons. */
  refused: { baseline: Array<{ pod: string; reasons: string[] }>; restricted: Array<{ pod: string; reasons: string[] }> };
}

export interface SecurityFinding {
  clusterKey: string;
  clusterName: string;
  kind: SecurityKind;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  objects: string[];
}

export interface GitOpsApp {
  clusterKey: string;
  clusterName: string;
  tool: 'Argo CD' | 'Flux';
  kind: string;
  namespace: string;
  name: string;
  sync?: string;
  health?: string;
  ready?: boolean;
  suspended?: boolean;
  message?: string;
  revision?: string;
}

export interface ClusterScan {
  clusterKey: string;
  clusterName: string;
  contextName: string;
  workloads: AppWorkload[];
  security: SecurityFinding[];
  gitops: GitOpsApp[];
  namespaces: NamespacePosture[];
  errors: string[];
}

/* ---------------- images ---------------- */

export function parseImage(image: string): { registry: string; repo: string; tag: string } {
  const [nameAndTag, digest] = image.split('@');
  const slash = nameAndTag.lastIndexOf('/');
  const colon = nameAndTag.lastIndexOf(':');
  const hasTag = colon > slash;
  const name = hasTag ? nameAndTag.slice(0, colon) : nameAndTag;
  const tag = digest ? `@${digest.slice(0, 19)}` : hasTag ? nameAndTag.slice(colon + 1) : 'latest';
  const first = name.split('/')[0];
  const registry = name.includes('/') && (/[.:]/.test(first) || first === 'localhost') ? first : 'docker.io';
  return { registry, repo: name, tag };
}

function containerImages(spec: any): string[] {
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c: any) => String(c?.image ?? '')).filter(Boolean);
}

/* ---------------- workloads and apps ---------------- */

export function parseWorkloads(clusterKey: string, clusterName: string, kind: AppWorkload['kind'], items: any[]): AppWorkload[] {
  return items
    .filter(o => !isPlatformNamespace(o?.metadata?.namespace ?? ''))
    .map(o => {
      const labels = { ...(o?.spec?.template?.metadata?.labels ?? {}), ...(o?.metadata?.labels ?? {}) };
      const desired =
        kind === 'DaemonSet' ? o?.status?.desiredNumberScheduled ?? 0 : typeof o?.spec?.replicas === 'number' ? o.spec.replicas : 1;
      const ready = kind === 'DaemonSet' ? o?.status?.numberReady ?? 0 : o?.status?.readyReplicas ?? 0;
      return {
        clusterKey,
        clusterName,
        namespace: o?.metadata?.namespace ?? '',
        kind,
        name: o?.metadata?.name ?? '',
        app: labels['app.kubernetes.io/name'] ?? labels.app ?? labels['k8s-app'] ?? o?.metadata?.name ?? '',
        ready,
        desired,
        images: containerImages(o?.spec?.template?.spec),
      };
    });
}

export interface AppGroup {
  app: string;
  workloads: AppWorkload[];
  clusters: string[];
  namespaces: string[];
  ready: number;
  desired: number;
  /** repo → tags seen, for repos running more than one version across the fleet. */
  drift: Array<{ repo: string; tags: string[] }>;
  images: string[];
}

export function groupApps(workloads: AppWorkload[]): AppGroup[] {
  const by = new Map<string, AppWorkload[]>();
  for (const w of workloads) by.set(w.app, [...(by.get(w.app) ?? []), w]);
  return Array.from(by.entries())
    .map(([app, ws]) => {
      const tags = new Map<string, Set<string>>();
      for (const w of ws) for (const img of w.images) {
        const p = parseImage(img);
        tags.set(p.repo, (tags.get(p.repo) ?? new Set()).add(p.tag));
      }
      return {
        app,
        workloads: ws,
        clusters: Array.from(new Set(ws.map(w => w.clusterName))).sort(),
        namespaces: Array.from(new Set(ws.map(w => w.namespace))).sort(),
        ready: ws.reduce((n, w) => n + w.ready, 0),
        desired: ws.reduce((n, w) => n + w.desired, 0),
        drift: Array.from(tags.entries())
          .filter(([, t]) => t.size > 1)
          .map(([repo, t]) => ({ repo, tags: Array.from(t).sort() })),
        images: Array.from(new Set(ws.flatMap(w => w.images))).sort(),
      };
    })
    .sort((a, b) => b.clusters.length - a.clusters.length || a.app.localeCompare(b.app));
}

/* ---------------- security ---------------- */

const SYSTEM_SUBJECT = /^system:|^vmware-system|^kube-|^wcp:/;

export function securityFindings(
  clusterKey: string,
  clusterName: string,
  input: { namespaces: any[]; pods: any[]; bindings: any[]; certificates: any[]; networkPolicies?: any[]; services?: any[]; clusterRoles?: any[] },
  allowedRegistries: string[],
  now: Date
): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const f = (kind: SecurityKind, severity: SecurityFinding['severity'], title: string, detail: string, objects: string[]) =>
    objects.length && out.push({ clusterKey, clusterName, kind, severity, title, detail, objects });

  const userNs = input.namespaces.filter(n => !isPlatformNamespace(n?.metadata?.name ?? '') && n?.metadata?.name !== 'default');
  const level = (n: any) => n?.metadata?.labels?.['pod-security.kubernetes.io/enforce'];
  f('psa', 'warning', 'Namespaces that allow privileged pods', 'Pod Security is set to "privileged", so nothing stops a pod from taking over its node.',
    userNs.filter(n => level(n) === 'privileged').map(n => n.metadata.name));
  f('psa', 'info', 'Namespaces without a Pod Security level', 'No "pod-security.kubernetes.io/enforce" label, so the cluster default applies.',
    userNs.filter(n => !level(n)).map(n => n.metadata.name));

  const userPods = input.pods.filter(p => !isPlatformNamespace(p?.metadata?.namespace ?? '') && p?.status?.phase !== 'Succeeded');
  const risky = userPods.filter(p => {
    const s = p?.spec ?? {};
    return (
      s.hostNetwork || s.hostPID || s.hostIPC ||
      (s.volumes ?? []).some((v: any) => v?.hostPath) ||
      [...(s.containers ?? []), ...(s.initContainers ?? [])].some((c: any) => c?.securityContext?.privileged)
    );
  });
  f('privileged', 'warning', 'Privileged or host-level pods', 'Privileged containers, host networking/PID/IPC or hostPath volumes give a pod access to its node.',
    risky.map(p => `${p.metadata.namespace}/${p.metadata.name}`));

  const admins = input.bindings
    .filter(b => b?.roleRef?.name === 'cluster-admin')
    .flatMap(b => (b?.subjects ?? []).map((s: any) => ({ b, s })))
    .filter(({ s }) => !SYSTEM_SUBJECT.test(String(s?.name ?? '')) && !(s?.kind === 'ServiceAccount' && isPlatformNamespace(s?.namespace ?? '')))
    .map(({ b, s }) => `${s.kind} ${s.kind === 'ServiceAccount' ? `${s.namespace}/` : ''}${s.name} (via ${b.metadata.name})`);
  f('cluster-admin', 'warning', 'cluster-admin granted to people or apps', 'Full control of the cluster. Prefer namespaced roles.', Array.from(new Set(admins)));

  // Other cluster roles granting everything, or reading Secrets cluster-wide, bound to people or apps.
  const roles = new Map((input.clusterRoles ?? []).map(r => [r?.metadata?.name, r]));
  const grants = (roleName: string, test: (rule: any) => boolean) => (roles.get(roleName)?.rules ?? []).some(test);
  const wildcard = (rule: any) => (rule?.verbs ?? []).includes('*') && (rule?.resources ?? []).includes('*');
  const readsSecrets = (rule: any) =>
    ((rule?.resources ?? []).includes('secrets') || (rule?.resources ?? []).includes('*')) &&
    (rule?.verbs ?? []).some((v: string) => ['get', 'list', 'watch', '*'].includes(v)) &&
    ((rule?.apiGroups ?? []).includes('') || (rule?.apiGroups ?? []).includes('*'));
  const human = (b: any) =>
    (b?.subjects ?? [])
      .filter((s: any) => !SYSTEM_SUBJECT.test(String(s?.name ?? '')) && !(s?.kind === 'ServiceAccount' && isPlatformNamespace(s?.namespace ?? '')))
      .map((s: any) => `${s.kind} ${s.kind === 'ServiceAccount' ? `${s.namespace}/` : ''}${s.name} (via ${b.metadata.name} → ${b.roleRef.name})`);
  const otherBindings = input.bindings.filter(b => b?.roleRef?.kind === 'ClusterRole' && b?.roleRef?.name !== 'cluster-admin' && !SYSTEM_SUBJECT.test(b?.roleRef?.name ?? ''));
  f('wildcard', 'warning', 'Roles that allow everything, bound to people or apps', 'A cluster role with verbs * on resources * is cluster-admin by another name.',
    Array.from(new Set(otherBindings.filter(b => grants(b.roleRef.name, wildcard)).flatMap(human))));
  f('secrets', 'warning', 'People or apps that can read every Secret', 'Reading Secrets cluster-wide exposes every password and token in the cluster.',
    Array.from(new Set(otherBindings.filter(b => grants(b.roleRef.name, readsSecrets) && !grants(b.roleRef.name, wildcard)).flatMap(human))));

  const images = Array.from(new Set(userPods.flatMap(p => containerImages(p.spec).map(i => ({ i, p: `${p.metadata.namespace}/${p.metadata.name}` }))).map(x => JSON.stringify(x)))).map(
    x => JSON.parse(x) as { i: string; p: string }
  );
  if (allowedRegistries.length) {
    const bad = images.filter(({ i }) => !allowedRegistries.some(r => i.startsWith(`${r.replace(/\/$/, '')}/`) || parseImage(i).registry === r));
    f('registry', 'warning', 'Images from registries not on the allowed list', `Allowed: ${allowedRegistries.join(', ')}.`, Array.from(new Set(bad.map(b => `${b.i} (${b.p})`))));
  }
  const mayBeRoot = userPods.filter(p => {
    const psc = p?.spec?.securityContext ?? {};
    return (p?.spec?.containers ?? []).some((c: any) => {
      const sc = c?.securityContext ?? {};
      const nonRoot = sc.runAsNonRoot === true || (psc.runAsNonRoot === true && sc.runAsNonRoot !== false);
      const uid = sc.runAsUser ?? psc.runAsUser;
      return !nonRoot && (uid === undefined || uid === 0);
    });
  });
  f('root', 'info', 'Pods that may run as root', 'No runAsNonRoot or non-zero runAsUser, so they run as whatever user the image says (often root).',
    mayBeRoot.map(p => `${p.metadata.namespace}/${p.metadata.name}`));

  const podNs = new Set(userPods.map(p => p.metadata.namespace));
  const withPolicy = new Set((input.networkPolicies ?? []).map(n => n?.metadata?.namespace));
  f('netpol', 'info', 'Namespaces without a NetworkPolicy', 'Any pod in the cluster can reach the pods here.',
    Array.from(podNs).filter(ns => !withPolicy.has(ns)).sort());
  const exposed = (input.services ?? []).filter(
    s => !isPlatformNamespace(s?.metadata?.namespace ?? '') && (s?.spec?.type === 'LoadBalancer' || s?.spec?.type === 'NodePort')
  );
  f('exposed', 'info', 'Services reachable from outside the cluster', 'LoadBalancer and NodePort services; make sure each is meant to be public.',
    exposed.map(s => `${s.metadata.namespace}/${s.metadata.name} (${s.spec.type}${s?.status?.loadBalancer?.ingress?.[0]?.ip ? ` ${s.status.loadBalancer.ingress[0].ip}` : ''}: ${(s.spec.ports ?? []).map((p: any) => p.port).join(',')})`));

  const latest = images.filter(({ i }) => !i.includes('@') && parseImage(i).tag === 'latest');
  f('latest', 'info', 'Images on "latest" or without a tag', 'The version can change on any restart, and rollbacks are guesswork.', Array.from(new Set(latest.map(l => `${l.i} (${l.p})`))));

  for (const c of input.certificates) {
    const name = `${c?.metadata?.namespace}/${c?.metadata?.name}`;
    const notAfter = c?.status?.notAfter;
    const ready = parseConditions(c?.status?.conditions).find(x => x.type === 'Ready');
    const days = notAfter ? Math.floor((new Date(notAfter).getTime() - now.getTime()) / 86400000) : undefined;
    if (ready?.status === 'False') {
      f('cert', 'warning', `Certificate ${name} is not ready`, ready.message ?? 'cert-manager could not issue or renew it.', [name]);
    } else if (days !== undefined && days <= 21) {
      f('cert', days <= 7 ? 'critical' : 'warning', `Certificate ${name} expires in ${days} day${days === 1 ? '' : 's'}`,
        'cert-manager normally renews well before this; check why it has not.', [name]);
    }
  }
  return out;
}

export function namespacePosture(namespaces: any[], pods: any[], networkPolicies: any[], services: any[]): NamespacePosture[] {
  return namespaces
    .filter(n => !isPlatformNamespace(n?.metadata?.name ?? '') && !['default', 'kube-public', 'kube-node-lease'].includes(n?.metadata?.name))
    .map(n => {
      const name = n.metadata.name;
      const running = pods
        .filter(p => p?.metadata?.namespace === name && p?.status?.phase !== 'Succeeded' && p?.status?.phase !== 'Failed')
        .map(p => ({ name: p.metadata.name, spec: p.spec }));
      const labels = n?.metadata?.labels ?? {};
      return {
        name,
        enforce: labels['pod-security.kubernetes.io/enforce'],
        warn: labels['pod-security.kubernetes.io/warn'],
        pods: running.length,
        netpols: networkPolicies.filter(x => x?.metadata?.namespace === name).length,
        exposed: services
          .filter(s => s?.metadata?.namespace === name && (s?.spec?.type === 'LoadBalancer' || s?.spec?.type === 'NodePort'))
          .map(s => s.metadata.name),
        refused: { baseline: refusedPods(running, 'baseline'), restricted: refusedPods(running, 'restricted') },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- GitOps ---------------- */

export function parseArgo(clusterKey: string, clusterName: string, apps: any[]): GitOpsApp[] {
  return apps.map(a => ({
    clusterKey,
    clusterName,
    tool: 'Argo CD' as const,
    kind: 'Application',
    namespace: a?.metadata?.namespace ?? '',
    name: a?.metadata?.name ?? '',
    sync: a?.status?.sync?.status,
    health: a?.status?.health?.status,
    ready: a?.status?.sync?.status === 'Synced' && a?.status?.health?.status === 'Healthy',
    message: a?.status?.operationState?.message ?? a?.status?.conditions?.[0]?.message,
    revision: String(a?.status?.sync?.revision ?? '').slice(0, 12) || undefined,
  }));
}

export function parseFlux(clusterKey: string, clusterName: string, kind: string, items: any[]): GitOpsApp[] {
  return items.map(o => {
    const ready = parseConditions(o?.status?.conditions).find(c => c.type === 'Ready');
    return {
      clusterKey,
      clusterName,
      tool: 'Flux' as const,
      kind,
      namespace: o?.metadata?.namespace ?? '',
      name: o?.metadata?.name ?? '',
      ready: ready ? ready.status === 'True' : undefined,
      suspended: o?.spec?.suspend === true,
      message: ready?.message,
      revision: String(o?.status?.lastAppliedRevision ?? o?.status?.lastAttemptedRevision ?? '').slice(0, 24) || undefined,
    };
  });
}

/* ---------------- fetch ---------------- */

async function firstServed(client: SupervisorClient, paths: string[]): Promise<any[] | undefined> {
  for (const p of paths) {
    try {
      return (await client.get<{ items?: any[] }>(p))?.items ?? [];
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
  return undefined;
}

export async function fetchClusterScan(
  client: SupervisorClient,
  clusterKey: string,
  clusterName: string,
  contextName: string,
  allowedRegistries: string[],
  now: Date = new Date()
): Promise<ClusterScan> {
  const errors: string[] = [];
  const read = async (label: string, paths: string[]) => {
    try {
      return await firstServed(client, paths);
    } catch (err) {
      errors.push(`${label}: ${describeError(err)}`);
      return undefined;
    }
  };
  const [deps, sts, dss, pods, nss, crbs, certs, argo, ks, hrs, netpols, svcs, croles] = await Promise.all([
    read('Deployments', ['/apis/apps/v1/deployments']),
    read('StatefulSets', ['/apis/apps/v1/statefulsets']),
    read('DaemonSets', ['/apis/apps/v1/daemonsets']),
    read('Pods', ['/api/v1/pods']),
    read('Namespaces', ['/api/v1/namespaces']),
    read('Cluster role bindings', ['/apis/rbac.authorization.k8s.io/v1/clusterrolebindings']),
    read('Certificates', ['/apis/cert-manager.io/v1/certificates']),
    read('Argo CD', ['/apis/argoproj.io/v1alpha1/applications']),
    read('Flux Kustomizations', ['/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations', '/apis/kustomize.toolkit.fluxcd.io/v1beta2/kustomizations']),
    read('Flux HelmReleases', ['/apis/helm.toolkit.fluxcd.io/v2/helmreleases', '/apis/helm.toolkit.fluxcd.io/v2beta2/helmreleases', '/apis/helm.toolkit.fluxcd.io/v2beta1/helmreleases']),
    read('Network policies', ['/apis/networking.k8s.io/v1/networkpolicies']),
    read('Services', ['/api/v1/services']),
    read('Cluster roles', ['/apis/rbac.authorization.k8s.io/v1/clusterroles']),
  ]);
  return {
    clusterKey,
    clusterName,
    contextName,
    workloads: [
      ...parseWorkloads(clusterKey, clusterName, 'Deployment', deps ?? []),
      ...parseWorkloads(clusterKey, clusterName, 'StatefulSet', sts ?? []),
      ...parseWorkloads(clusterKey, clusterName, 'DaemonSet', dss ?? []),
    ],
    security: securityFindings(
      clusterKey,
      clusterName,
      { namespaces: nss ?? [], pods: pods ?? [], bindings: crbs ?? [], certificates: certs ?? [], networkPolicies: netpols ?? [], services: svcs ?? [], clusterRoles: croles ?? [] },
      allowedRegistries,
      now
    ),
    gitops: [
      ...parseArgo(clusterKey, clusterName, argo ?? []),
      ...parseFlux(clusterKey, clusterName, 'Kustomization', ks ?? []),
      ...parseFlux(clusterKey, clusterName, 'HelmRelease', hrs ?? []),
    ],
    namespaces: namespacePosture(nss ?? [], pods ?? [], netpols ?? [], svcs ?? []),
    errors,
  };
}
