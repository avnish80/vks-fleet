/**
 * Health from inside a workload cluster, read through a Headlamp context with
 * the user's own credentials. Summaries only; the full detail is one click
 * away in Headlamp's own views of that cluster.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { matchesSelector } from './selector';
import { parseQuantity } from './quantity';
import {
  DeploymentIssue,
  EventInfo,
  NodeUse,
  PodIssue,
  PodUse,
  SandboxFailure,
  StuckObject,
  Utilisation,
  WorkloadChecks,
  WorkloadHealth,
} from './types';

/**
 * Usage against allocatable per node, the busiest pods, and user pods that
 * request nothing (the usual cause of overcommitted nodes). From metrics-server.
 */
export function utilisation(nodes: any[], nodeMetrics: any[], podMetrics: any[], pods: any[]): Utilisation | undefined {
  if (!nodeMetrics.length) return undefined;
  const usage = new Map(nodeMetrics.map(m => [m?.metadata?.name, m?.usage ?? {}]));
  const nodeUse: NodeUse[] = nodes
    .filter(n => usage.has(n?.metadata?.name))
    .map(n => {
      const u = usage.get(n.metadata.name) ?? {};
      const cpuUsed = parseQuantity(u.cpu) ?? 0;
      const memUsed = parseQuantity(u.memory) ?? 0;
      const cpuAllocatable = parseQuantity(n?.status?.allocatable?.cpu) ?? 0;
      const memAllocatable = parseQuantity(n?.status?.allocatable?.memory) ?? 0;
      return {
        name: n.metadata.name,
        cpuUsed,
        cpuAllocatable,
        memUsed,
        memAllocatable,
        cpuPct: cpuAllocatable ? Math.round((cpuUsed / cpuAllocatable) * 100) : 0,
        memPct: memAllocatable ? Math.round((memUsed / memAllocatable) * 100) : 0,
      };
    })
    .sort((a, b) => Math.max(b.cpuPct, b.memPct) - Math.max(a.cpuPct, a.memPct));
  const sum = (f: (n: NodeUse) => number) => nodeUse.reduce((x, n) => x + f(n), 0);
  const nodeOf = new Map(pods.map(p => [`${p?.metadata?.namespace}/${p?.metadata?.name}`, p?.spec?.nodeName]));
  const podUse: PodUse[] = podMetrics.map(m => {
    const containers: any[] = m?.containers ?? [];
    const key = `${m?.metadata?.namespace}/${m?.metadata?.name}`;
    return {
      namespace: m?.metadata?.namespace ?? '',
      name: m?.metadata?.name ?? '',
      node: nodeOf.get(key),
      cpu: containers.reduce((x, c) => x + (parseQuantity(c?.usage?.cpu) ?? 0), 0),
      mem: containers.reduce((x, c) => x + (parseQuantity(c?.usage?.memory) ?? 0), 0),
    };
  });
  const podsWithoutRequests = pods
    .filter(p => !isPlatformNamespace(p?.metadata?.namespace ?? '') && p?.status?.phase === 'Running')
    .filter(p => (p?.spec?.containers ?? []).some((c: any) => !c?.resources?.requests?.cpu || !c?.resources?.requests?.memory))
    .map(p => `${p.metadata.namespace}/${p.metadata.name}`);
  return {
    nodes: nodeUse,
    cpuPct: sum(n => n.cpuAllocatable) ? Math.round((sum(n => n.cpuUsed) / sum(n => n.cpuAllocatable)) * 100) : 0,
    memPct: sum(n => n.memAllocatable) ? Math.round((sum(n => n.memUsed) / sum(n => n.memAllocatable)) * 100) : 0,
    topByCpu: [...podUse].sort((a, b) => b.cpu - a.cpu).slice(0, 8),
    topByMemory: [...podUse].sort((a, b) => b.mem - a.mem).slice(0, 8),
    podsWithoutRequests,
  };
}

/** Things stuck longer than this are reported. */
export const STUCK_OBJECT_MS = 5 * 60 * 1000;

const olderThan = (ts: string | undefined, now: Date, ms: number) => !!ts && now.getTime() - new Date(ts).getTime() > ms;

export function pendingClaims(pvcs: any[], now: Date): StuckObject[] {
  return pvcs
    .filter(p => p?.status?.phase === 'Pending' && olderThan(p?.metadata?.creationTimestamp, now, STUCK_OBJECT_MS))
    .map(p => ({
      namespace: p?.metadata?.namespace ?? '',
      name: p?.metadata?.name ?? '',
      since: p?.metadata?.creationTimestamp,
      detail: p?.spec?.storageClassName ? `storage class ${p.spec.storageClassName}` : 'no storage class',
    }));
}

export function pendingLoadBalancers(services: any[], now: Date): StuckObject[] {
  return services
    .filter(
      s =>
        s?.spec?.type === 'LoadBalancer' &&
        !(s?.status?.loadBalancer?.ingress ?? []).length &&
        olderThan(s?.metadata?.creationTimestamp, now, STUCK_OBJECT_MS)
    )
    .map(s => ({ namespace: s?.metadata?.namespace ?? '', name: s?.metadata?.name ?? '', since: s?.metadata?.creationTimestamp }));
}

/** CoreDNS deployment availability (kube-system/coredns). */
export function dnsAvailability(deployments: any[]): { available: number; desired: number } | undefined {
  const d = deployments.find(x => x?.metadata?.namespace === 'kube-system' && x?.metadata?.name === 'coredns');
  if (!d) return undefined;
  return {
    desired: typeof d?.spec?.replicas === 'number' ? d.spec.replicas : 1,
    available: typeof d?.status?.availableReplicas === 'number' ? d.status.availableReplicas : 0,
  };
}

export const POD_PAGE = 1000;
const LIST_CAP = 50;
const PENDING_GRACE_MS = 5 * 60 * 1000;
export const WARNING_WINDOW_MS = 60 * 60 * 1000;

const BAD_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
]);

export function summarizeNodes(nodes: any[]): { ready: number; total: number } {
  const ready = nodes.filter(n =>
    (n?.status?.conditions ?? []).some((c: any) => c?.type === 'Ready' && c?.status === 'True')
  ).length;
  return { ready, total: nodes.length };
}

export function podIssues(pods: any[], now: Date): PodIssue[] {
  const out: PodIssue[] = [];
  for (const p of pods) {
    const phase: string = p?.status?.phase ?? 'Unknown';
    if (phase === 'Succeeded') continue;
    const statuses: any[] = [
      ...(p?.status?.initContainerStatuses ?? []),
      ...(p?.status?.containerStatuses ?? []),
    ];
    const waiting = statuses.map(s => s?.state?.waiting?.reason).find(r => BAD_WAITING.has(r));
    let reason: string | undefined = waiting;
    if (!reason && phase === 'Failed') reason = p?.status?.reason || 'Failed';
    if (!reason && phase === 'Unknown') reason = 'Unknown';
    if (!reason && phase === 'Pending') {
      const created = p?.metadata?.creationTimestamp;
      if (created && now.getTime() - new Date(created).getTime() > PENDING_GRACE_MS) {
        const sched = (p?.status?.conditions ?? []).find((c: any) => c?.type === 'PodScheduled');
        reason = sched?.status === 'False' ? sched.reason || 'Unschedulable' : 'Pending';
      }
    }
    if (reason) {
      out.push({
        namespace: p?.metadata?.namespace ?? '',
        name: p?.metadata?.name ?? '',
        reason,
        node: p?.spec?.nodeName || undefined,
      });
    }
  }
  return out;
}

export function deploymentIssues(deployments: any[]): DeploymentIssue[] {
  return deployments
    .map(d => ({
      namespace: d?.metadata?.namespace ?? '',
      name: d?.metadata?.name ?? '',
      desired: typeof d?.spec?.replicas === 'number' ? d.spec.replicas : 1,
      available: typeof d?.status?.availableReplicas === 'number' ? d.status.availableReplicas : 0,
    }))
    .filter(d => d.desired > 0 && d.available < d.desired);
}

export function eventTime(e: any): string | undefined {
  return (
    e?.lastTimestamp || e?.series?.lastObservedTime || e?.eventTime || e?.metadata?.creationTimestamp || undefined
  );
}

export function toEventInfo(e: any): EventInfo {
  const obj = e?.involvedObject ?? e?.regarding ?? {};
  return {
    host: e?.source?.host ?? e?.reportingInstance ?? e?.deprecatedSource?.host,
    type: e?.type,
    namespace: e?.metadata?.namespace,
    object: [obj.kind, obj.name].filter(Boolean).join('/'),
    reason: e?.reason,
    message: e?.message ?? e?.note,
    lastSeen: eventTime(e),
    count: typeof e?.count === 'number' ? e.count : e?.series?.count,
  };
}

export function recentEvents(events: any[], now: Date, windowMs = WARNING_WINDOW_MS): EventInfo[] {
  return events
    .map(toEventInfo)
    .filter(e => e.lastSeen && now.getTime() - new Date(e.lastSeen).getTime() <= windowMs)
    .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''));
}

/** Namespaces owned by the platform (VKS, Kubernetes, CNI, packages): excluded from workload checks. */
const PLATFORM_NS = [
  /^kube-/,
  /^vmware-system/,
  /^tkg-system/,
  /^tanzu-/,
  /^pinniped/,
  /^secretgen/,
  /^kapp-controller/,
  /^cert-manager$/,
  /^calico/,
  /^multus/,
  /^antrea/,
  /^velero$/,
];

export function isPlatformNamespace(ns: string): boolean {
  return PLATFORM_NS.some(r => r.test(ns));
}

function imageTag(image: string): string | undefined {
  if (image.includes('@sha256:')) return 'digest';
  const last = image.split('/').pop() ?? image;
  const i = last.lastIndexOf(':');
  return i >= 0 ? last.slice(i + 1) : undefined;
}

/**
 * Best-practice observations about user workloads: privileged pods, missing
 * limits, :latest images, replicated deployments without a PDB, single
 * replicas, and whether a backup tool is installed.
 */
export function workloadChecks(pods: any[], deployments: any[], pdbs: any[] | undefined): WorkloadChecks {
  const userPods = pods.filter(p => !isPlatformNamespace(p?.metadata?.namespace ?? '') && p?.status?.phase !== 'Succeeded');
  const userDeps = deployments.filter(d => !isPlatformNamespace(d?.metadata?.namespace ?? ''));
  const id = (o: any) => `${o?.metadata?.namespace}/${o?.metadata?.name}`;
  const containers = (p: any): any[] => [...(p?.spec?.containers ?? []), ...(p?.spec?.initContainers ?? [])];

  const privilegedPods = userPods.filter(p => containers(p).some(c => c?.securityContext?.privileged === true)).map(id);
  const podsWithoutLimits = userPods
    .filter(p => (p?.spec?.containers ?? []).some((c: any) => !c?.resources?.limits || Object.keys(c.resources.limits).length === 0))
    .map(id);
  const latestImages = Array.from(
    new Set(
      userPods.flatMap(p =>
        containers(p)
          .map(c => String(c?.image ?? ''))
          .filter(img => {
            const tag = imageTag(img);
            return img && (tag === undefined || tag === 'latest');
          })
      )
    )
  );
  const replicas = (d: any) => (typeof d?.spec?.replicas === 'number' ? d.spec.replicas : 1);
  const protectedBy = (d: any) =>
    (pdbs ?? []).some(
      b =>
        b?.metadata?.namespace === d?.metadata?.namespace &&
        matchesSelector(b?.spec?.selector, d?.spec?.template?.metadata?.labels ?? {})
    );
  const unprotectedDeployments = pdbs ? userDeps.filter(d => replicas(d) > 1 && !protectedBy(d)).map(id) : [];
  const singleReplicaDeployments = userDeps.filter(d => replicas(d) === 1).map(id);
  const backup = deployments.some(d => /velero/i.test(d?.metadata?.name ?? '') || d?.metadata?.namespace === 'velero');
  return {
    privilegedPods,
    podsWithoutLimits,
    latestImages,
    unprotectedDeployments,
    singleReplicaDeployments,
    backup,
    podsChecked: userPods.length,
    deploymentsChecked: userDeps.length,
  };
}

/** Trims a CNI error to the part that says what went wrong. */
export function sandboxError(message: string): string {
  const m = message.replace(/\s+/g, ' ');
  const markers = ['failed (add): ', 'error adding container to network', 'desc = '];
  for (const k of markers) {
    const i = m.lastIndexOf(k);
    if (i >= 0) {
      const rest = m.slice(i + (k.endsWith(' ') ? k.length : 0)).replace(/':?\s*StdinData.*$/, '').trim();
      if (rest) return rest.length > 220 ? `${rest.slice(0, 217)}...` : rest;
    }
  }
  return m.length > 220 ? `${m.slice(0, 217)}...` : m;
}

/** FailedCreatePodSandBox warnings grouped by the node that reported them. */
export function sandboxFailures(events: EventInfo[]): SandboxFailure[] {
  const byNode = new Map<string, { pods: Set<string>; attempts: number; latest?: EventInfo }>();
  for (const e of events) {
    if (e.reason !== 'FailedCreatePodSandBox') continue;
    const node = e.host ?? 'unknown node';
    const g = byNode.get(node) ?? { pods: new Set<string>(), attempts: 0 };
    g.pods.add(`${e.namespace}/${e.object}`);
    g.attempts += e.count ?? 1;
    if (!g.latest || (e.lastSeen ?? '') > (g.latest.lastSeen ?? '')) g.latest = e;
    byNode.set(node, g);
  }
  return Array.from(byNode.entries())
    .map(([node, g]) => ({ node, pods: g.pods.size, attempts: g.attempts, error: sandboxError(g.latest?.message ?? '') }))
    .sort((a, b) => b.attempts - a.attempts);
}

function emptyHealth(status: WorkloadHealth['status'], contextName?: string, error?: string): WorkloadHealth {
  return {
    status,
    contextName,
    error,
    podIssues: [],
    podIssueCount: 0,
    deploymentIssues: [],
    recentWarnings: [],
    recentWarningCount: 0,
    sandboxFailures: [],
    partial: [],
  };
}

export function noContextHealth(): WorkloadHealth {
  return emptyHealth('no-context');
}

export async function fetchWorkloadHealth(
  client: SupervisorClient,
  contextName: string,
  now: Date = new Date()
): Promise<WorkloadHealth> {
  const parts = [
    'version',
    'nodes',
    'pods',
    'deployments',
    'events',
    'poddisruptionbudgets',
    'persistentvolumeclaims',
    'services',
    'node metrics',
    'pod metrics',
  ] as const;
  const settled = await Promise.allSettled([
    client.get<any>('/version'),
    client.get<any>('/api/v1/nodes'),
    client.get<any>(`/api/v1/pods?limit=${POD_PAGE}`),
    client.get<any>('/apis/apps/v1/deployments'),
    client.get<any>('/api/v1/events?fieldSelector=type%3DWarning&limit=500'),
    client.get<any>('/apis/policy/v1/poddisruptionbudgets'),
    client.get<any>('/api/v1/persistentvolumeclaims'),
    client.get<any>('/api/v1/services'),
    client.get<any>('/apis/metrics.k8s.io/v1beta1/nodes'),
    client.get<any>('/apis/metrics.k8s.io/v1beta1/pods'),
  ]);

  const rejected = settled
    .map((r, i) => ({ r, part: parts[i] }))
    .filter((x): x is { r: PromiseRejectedResult; part: (typeof parts)[number] } => x.r.status === 'rejected');

  // Classify by the parts that carry health data; the version endpoint is
  // readable by almost anyone and says nothing about access to workloads.
  const optionalParts = new Set(['version', 'poddisruptionbudgets', 'persistentvolumeclaims', 'services', 'node metrics', 'pod metrics']);
  const substantive = rejected.filter(x => !optionalParts.has(x.part));
  if (substantive.length === parts.length - optionalParts.size) {
    const statuses = substantive.map(x => statusOf(x.r.reason));
    if (statuses.includes(401)) {
      return emptyHealth('expired', contextName, 'Sign-in to this cluster has expired. Log in again.');
    }
    if (statuses.every(s => s === 403)) {
      return emptyHealth('no-access', contextName, "Your account can't read this cluster.");
    }
    return emptyHealth('unreachable', contextName, describeError(substantive[0].r.reason));
  }

  const value = (i: number) => (settled[i].status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<any>).value : undefined);
  const health = emptyHealth('ok', contextName);
  health.partial = rejected.map(x => `${x.part}: ${describeError(x.r.reason)}`);
  health.serverVersion = value(0)?.gitVersion;

  const nodes = value(1)?.items;
  if (Array.isArray(nodes)) health.nodes = summarizeNodes(nodes);

  const podList = value(2);
  if (Array.isArray(podList?.items)) {
    const issues = podIssues(podList.items, now);
    health.podCount = podList.items.length;
    health.podsTruncated = !!podList?.metadata?.continue;
    health.podIssueCount = issues.length;
    health.podIssues = issues.slice(0, LIST_CAP);
  }

  const deps = value(3)?.items;
  if (Array.isArray(deps)) health.deploymentIssues = deploymentIssues(deps).slice(0, LIST_CAP);

  const events = value(4)?.items;
  if (Array.isArray(events)) {
    const recent = recentEvents(events, now);
    health.recentWarningCount = recent.length;
    health.recentWarnings = recent.slice(0, LIST_CAP);
    health.sandboxFailures = sandboxFailures(recent);
  }

  const pdbItems = value(5)?.items;
  if (Array.isArray(podList?.items) && Array.isArray(deps)) {
    health.checks = workloadChecks(podList.items, deps, Array.isArray(pdbItems) ? pdbItems : undefined);
  }

  const pvcs = value(6)?.items;
  if (Array.isArray(pvcs)) health.pendingClaims = pendingClaims(pvcs, now);
  const svcs = value(7)?.items;
  if (Array.isArray(svcs)) health.pendingLoadBalancers = pendingLoadBalancers(svcs, now);
  if (Array.isArray(deps)) health.dns = dnsAvailability(deps);
  const nodeMetrics = value(8)?.items;
  if (Array.isArray(nodes) && Array.isArray(nodeMetrics)) {
    health.utilisation = utilisation(nodes, nodeMetrics, value(9)?.items ?? [], podList?.items ?? []);
  }
  // metrics-server not installed is normal; don't list it as unreadable.
  health.partial = health.partial.filter(p => !/^(node|pod) metrics:/.test(p) || !/\(404\)/.test(p));

  const nodesShort = !!health.nodes && health.nodes.ready < health.nodes.total;
  if (nodesShort || health.podIssueCount > 0 || health.deploymentIssues.length > 0) {
    health.status = 'issues';
  }
  return health;
}
