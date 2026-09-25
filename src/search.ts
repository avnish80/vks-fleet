/**
 * Fleet-wide search. Supervisor-side objects (clusters, pools, machines, IPs)
 * are searched from what the plugin already has; workload objects are looked
 * up live in every signed-in cluster. Queries:
 *   web            name or namespace contains "web" (and pod/workload images)
 *   app=web        label selector (sent to the API server)
 *   10.95.119.130  pod, service, node, machine or API endpoint IP
 *   kind:pod web   restrict to one kind
 */
import { describeError, SupervisorClient } from './api/client';
import { clusterPath, machinePath } from './routes';
import { FleetCluster } from './types';

export interface SearchHit {
  clusterKey: string;
  clusterName: string;
  where: 'supervisor' | 'cluster';
  kind: string;
  namespace?: string;
  name: string;
  /** Why it matched. */
  match: string;
  path: string;
}

export interface ParsedQuery {
  text: string;
  labelSelector?: string;
  ip?: string;
  kind?: string;
}

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

export function parseQuery(raw: string): ParsedQuery {
  let rest = raw.trim();
  let kind: string | undefined;
  const k = /(^|\s)kind:(\S+)/i.exec(rest);
  if (k) {
    kind = k[2].toLowerCase();
    rest = rest.replace(k[0], ' ').trim();
  }
  if (IP.test(rest)) return { text: '', ip: rest, kind };
  const labelish = /^[\w./-]+(=|!=|==)[\w.-]*(,[\w./-]+(=|!=|==)[\w.-]*)*$/;
  if (labelish.test(rest)) return { text: '', labelSelector: rest, kind };
  return { text: rest.toLowerCase(), kind };
}

interface KindSpec {
  kind: string;
  path: string;
  route: string;
  clusterScoped?: boolean;
}

export const SEARCH_KINDS: KindSpec[] = [
  { kind: 'Pod', path: '/api/v1/pods', route: 'pods' },
  { kind: 'Deployment', path: '/apis/apps/v1/deployments', route: 'deployments' },
  { kind: 'StatefulSet', path: '/apis/apps/v1/statefulsets', route: 'statefulsets' },
  { kind: 'DaemonSet', path: '/apis/apps/v1/daemonsets', route: 'daemonsets' },
  { kind: 'Service', path: '/api/v1/services', route: 'services' },
  { kind: 'Ingress', path: '/apis/networking.k8s.io/v1/ingresses', route: 'ingresses' },
  { kind: 'PersistentVolumeClaim', path: '/api/v1/persistentvolumeclaims', route: 'persistentvolumeclaims' },
  { kind: 'Namespace', path: '/api/v1/namespaces', route: 'namespaces', clusterScoped: true },
  { kind: 'Node', path: '/api/v1/nodes', route: 'nodes', clusterScoped: true },
];

const PER_KIND = 50;

function images(o: any): string[] {
  const spec = o?.spec?.template?.spec ?? o?.spec ?? {};
  return [...(spec.containers ?? []), ...(spec.initContainers ?? [])].map((c: any) => String(c?.image ?? '')).filter(Boolean);
}

function ips(o: any): string[] {
  return [
    o?.status?.podIP,
    ...(o?.status?.podIPs ?? []).map((x: any) => x?.ip),
    o?.spec?.clusterIP,
    ...(o?.spec?.clusterIPs ?? []),
    ...(o?.status?.loadBalancer?.ingress ?? []).map((x: any) => x?.ip),
    ...(o?.status?.addresses ?? []).map((x: any) => x?.address),
  ].filter(Boolean);
}

/** Why an object matches a query, or undefined. */
export function matchObject(o: any, q: ParsedQuery): string | undefined {
  if (q.ip) return ips(o).includes(q.ip) ? `IP ${q.ip}` : undefined;
  if (q.labelSelector) return `labels ${q.labelSelector}`; // the API server already filtered
  const name = String(o?.metadata?.name ?? '').toLowerCase();
  const ns = String(o?.metadata?.namespace ?? '').toLowerCase();
  if (!q.text) return undefined;
  if (name.includes(q.text)) return 'name';
  if (ns.includes(q.text)) return 'namespace';
  const img = images(o).find(i => i.toLowerCase().includes(q.text));
  return img ? `image ${img}` : undefined;
}

export function headlampObjectPath(contextName: string, route: string, namespace: string | undefined, name: string): string {
  const c = encodeURIComponent(contextName);
  return namespace
    ? `/c/${c}/${route}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
    : `/c/${c}/${route}/${encodeURIComponent(name)}`;
}

/** Searches one signed-in cluster live. */
export async function searchCluster(
  client: SupervisorClient,
  cluster: Pick<FleetCluster, 'key' | 'name'>,
  contextName: string,
  q: ParsedQuery
): Promise<{ hits: SearchHit[]; errors: string[] }> {
  const kinds = SEARCH_KINDS.filter(k => !q.kind || k.kind.toLowerCase().startsWith(q.kind));
  const query = q.labelSelector ? `?labelSelector=${encodeURIComponent(q.labelSelector)}` : '';
  const settled = await Promise.allSettled(kinds.map(k => client.get<{ items?: any[] }>(`${k.path}${query}`)));
  const hits: SearchHit[] = [];
  const errors: string[] = [];
  settled.forEach((r, i) => {
    const k = kinds[i];
    if (r.status === 'rejected') {
      errors.push(`${k.kind}: ${describeError(r.reason)}`);
      return;
    }
    let n = 0;
    for (const o of r.value?.items ?? []) {
      const why = matchObject(o, q);
      if (!why) continue;
      const ns = k.clusterScoped ? undefined : o?.metadata?.namespace;
      hits.push({
        clusterKey: cluster.key,
        clusterName: cluster.name,
        where: 'cluster',
        kind: k.kind,
        namespace: ns,
        name: o?.metadata?.name ?? '',
        match: why,
        path: headlampObjectPath(contextName, k.route, ns, o?.metadata?.name ?? ''),
      });
      if (++n >= PER_KIND) break;
    }
  });
  return { hits, errors };
}

/** Searches what the plugin already knows from the Supervisor. */
export function searchSupervisor(clusters: FleetCluster[], q: ParsedQuery): SearchHit[] {
  const hits: SearchHit[] = [];
  const wantKind = (k: string) => !q.kind || k.toLowerCase().startsWith(q.kind);
  const t = q.text;
  for (const c of clusters) {
    const base = { clusterKey: c.key, clusterName: c.name, where: 'supervisor' as const };
    if (wantKind('cluster')) {
      const why = q.ip
        ? c.endpoint?.host === q.ip
          ? `API endpoint ${q.ip}`
          : undefined
        : t && c.name.toLowerCase().includes(t)
        ? 'name'
        : t && c.namespace.toLowerCase().includes(t)
        ? 'namespace'
        : t && c.tenantName.toLowerCase().includes(t)
        ? `tenant ${c.tenantName}`
        : t && (c.kubernetesVersion ?? '').toLowerCase().includes(t)
        ? `version ${c.kubernetesVersion}`
        : undefined;
      if (why) hits.push({ ...base, kind: 'Cluster', namespace: c.namespace, name: c.name, match: why, path: clusterPath(c) });
    }
    if (wantKind('machine')) {
      for (const m of c.machines) {
        const why = q.ip
          ? m.internalIP === q.ip || m.vm?.ip === q.ip
            ? `IP ${q.ip}`
            : undefined
          : t && (m.name.toLowerCase().includes(t) || (m.nodeName ?? '').toLowerCase().includes(t))
          ? 'name'
          : undefined;
        if (why) hits.push({ ...base, kind: 'Machine', namespace: c.namespace, name: m.nodeName ?? m.name, match: why, path: machinePath(c, m.name) });
      }
    }
  }
  return hits;
}
