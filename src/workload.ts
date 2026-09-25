/**
 * Health from inside a workload cluster, read through a Headlamp context with
 * the user's own credentials. Summaries only; the full detail is one click
 * away in Headlamp's own views of that cluster.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { DeploymentIssue, EventInfo, PodIssue, SandboxFailure, WorkloadHealth } from './types';

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
      out.push({ namespace: p?.metadata?.namespace ?? '', name: p?.metadata?.name ?? '', reason });
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
  const parts = ['version', 'nodes', 'pods', 'deployments', 'events'] as const;
  const settled = await Promise.allSettled([
    client.get<any>('/version'),
    client.get<any>('/api/v1/nodes'),
    client.get<any>(`/api/v1/pods?limit=${POD_PAGE}`),
    client.get<any>('/apis/apps/v1/deployments'),
    client.get<any>('/api/v1/events?fieldSelector=type%3DWarning&limit=500'),
  ]);

  const rejected = settled
    .map((r, i) => ({ r, part: parts[i] }))
    .filter((x): x is { r: PromiseRejectedResult; part: (typeof parts)[number] } => x.r.status === 'rejected');

  // Classify by the parts that carry health data; the version endpoint is
  // readable by almost anyone and says nothing about access to workloads.
  const substantive = rejected.filter(x => x.part !== 'version');
  if (substantive.length === parts.length - 1) {
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

  const nodesShort = !!health.nodes && health.nodes.ready < health.nodes.total;
  if (nodesShort || health.podIssueCount > 0 || health.deploymentIssues.length > 0) {
    health.status = 'issues';
  }
  return health;
}
