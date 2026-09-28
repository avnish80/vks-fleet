/**
 * Supervisor health, from what the Supervisor's API lets an administrator read
 * (its /readyz and /metrics are not exposed through its endpoint):
 *  - controllers alive: leader-election leases, renewed or stale;
 *  - Supervisor services: pods running, failing, and ProviderFailed vSphere
 *    Pods left behind next to a running replacement;
 *  - placement: every service on one ESXi host while others are Ready;
 *  - hosts and control-plane nodes;
 *  - reconcile backlog by kind, warning events by reason, responsiveness.
 */
import { describeError, statusOf, SupervisorClient, WriteRequest } from './api/client';
import { ActionPlan, Check } from './actions';
import { ClusterStats } from './api/limiter';
import { serviceName } from './supervisor';
import { EventInfo, Inventory, Issue, SupervisorResult } from './types';

/* ---------------- Controllers (leases) ---------------- */

export interface LeaseInfo {
  namespace: string;
  name: string;
  controller: string;
  holder?: string;
  /** The node (Supervisor control-plane VM) holding it. */
  holderNode?: string;
  renewedSecondsAgo?: number;
  durationSeconds: number;
  state: 'ok' | 'stale' | 'no-holder';
}

const CONTROLLERS: Array<[RegExp, string]> = [
  [/^controller-leader-election-capi$/, 'Cluster API'],
  [/^capv-controller-manager/, 'Cluster API provider for vSphere'],
  [/^kubeadm-bootstrap-manager/, 'kubeadm bootstrap'],
  [/^kubeadm-control-plane-manager/, 'kubeadm control plane'],
  [/runtime-extension/, 'Cluster API runtime extension'],
  [/tkg-controller/, 'VKS controller'],
  [/vmop|vm-operator|vmoperator/, 'VM Operator'],
  [/nsx/, 'NSX operator'],
  [/csi/, 'vSphere CSI'],
];

export function controllerName(lease: string): string {
  return CONTROLLERS.find(([re]) => re.test(lease))?.[1] ?? lease;
}

/** Stale: not renewed for four lease periods (and at least a minute). */
export function parseLeases(items: any[], now: Date): LeaseInfo[] {
  return items.map(l => {
    const holder: string | undefined = l?.spec?.holderIdentity || undefined;
    const duration = Number(l?.spec?.leaseDurationSeconds ?? 15);
    const renew = l?.spec?.renewTime ?? l?.spec?.acquireTime;
    const ago = renew ? Math.max(0, (now.getTime() - new Date(renew).getTime()) / 1000) : undefined;
    const state: LeaseInfo['state'] = !holder ? 'no-holder' : ago !== undefined && ago > Math.max(60, duration * 4) ? 'stale' : 'ok';
    return {
      namespace: l?.metadata?.namespace ?? '',
      name: l?.metadata?.name ?? '',
      controller: controllerName(l?.metadata?.name ?? ''),
      holder,
      holderNode: holder?.split('_')[0],
      renewedSecondsAgo: ago,
      durationSeconds: duration,
      state,
    };
  });
}

/* ---------------- Services ---------------- */

export interface ServicePod {
  name: string;
  host?: string;
  phase: string;
  reason?: string;
  ready: boolean;
  restarts: number;
  ageDays: number;
  owner?: string;
}

export interface ServiceState {
  namespace: string;
  name: string;
  running: ServicePod[];
  /** Failed or ProviderFailed pods whose owner has a running replacement: safe to delete. */
  leftovers: ServicePod[];
  /** Pods failing with no running replacement. */
  failing: ServicePod[];
  state: 'ok' | 'degraded' | 'down';
}

const isProviderFailed = (p: any) => p?.status?.reason === 'ProviderFailed' || p?.status?.phase === 'ProviderFailed';

function ownerOf(p: any): string | undefined {
  const refs: any[] = p?.metadata?.ownerReferences ?? [];
  const ref = refs.find(o => o?.controller) ?? refs[0];
  return ref ? ref.uid ?? `${ref.kind}/${ref.name}` : undefined;
}

export function analyseService(namespace: string, pods: any[], now: Date): ServiceState {
  const view = (p: any): ServicePod => ({
    name: p?.metadata?.name ?? '',
    host: p?.spec?.nodeName,
    phase: p?.status?.phase ?? 'Unknown',
    reason: p?.status?.reason,
    ready: (p?.status?.containerStatuses ?? []).length > 0 && (p.status.containerStatuses as any[]).every(c => c?.ready),
    restarts: (p?.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + Number(c?.restartCount ?? 0), 0),
    ageDays: p?.metadata?.creationTimestamp ? (now.getTime() - new Date(p.metadata.creationTimestamp).getTime()) / 86400e3 : 0,
    owner: ownerOf(p),
  });
  const all = pods.map(p => ({ raw: p, v: view(p) }));
  const running = all.filter(x => x.v.phase === 'Running' && !isProviderFailed(x.raw)).map(x => x.v);
  const runningOwners = new Set(running.map(r => r.owner).filter(Boolean));
  const bad = all.filter(x => isProviderFailed(x.raw) || x.v.phase === 'Failed' || (x.v.phase === 'Pending' && x.v.ageDays > 10 / 1440));
  const leftovers = bad.filter(x => x.v.owner && runningOwners.has(x.v.owner)).map(x => x.v);
  const failing = bad.filter(x => !(x.v.owner && runningOwners.has(x.v.owner))).map(x => x.v);
  const notReady = running.filter(r => !r.ready);
  return {
    namespace,
    name: serviceName(namespace),
    running,
    leftovers,
    failing,
    state: running.length === 0 && pods.length > 0 ? 'down' : failing.length || notReady.length ? 'degraded' : 'ok',
  };
}

/* ---------------- Hosts, placement, backlog, events ---------------- */

export interface NodeState {
  name: string;
  role: 'control-plane' | 'host' | 'other';
  ready: boolean;
  version?: string;
}

export function parseNodes(items: any[]): NodeState[] {
  return items.map(n => {
    const labels = n?.metadata?.labels ?? {};
    const role: NodeState['role'] =
      'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels
        ? 'control-plane'
        : 'node-role.kubernetes.io/agent' in labels || /-sph/.test(n?.status?.nodeInfo?.kubeletVersion ?? '')
        ? 'host'
        : 'other';
    return {
      name: n?.metadata?.name ?? '',
      role,
      ready: (n?.status?.conditions ?? []).some((c: any) => c?.type === 'Ready' && c?.status === 'True'),
      version: n?.status?.nodeInfo?.kubeletVersion,
    };
  });
}

export interface Placement {
  /** Hosts running Supervisor service pods, with how many. */
  byHost: Array<{ host: string; pods: number }>;
  readyHosts: number;
  /** Everything on one host while others are Ready. */
  concentrated?: string;
}

export function placement(services: ServiceState[], nodes: NodeState[]): Placement {
  const counts = new Map<string, number>();
  for (const s of services) for (const p of s.running) if (p.host && nodes.some(n => n.name === p.host && n.role === 'host')) counts.set(p.host, (counts.get(p.host) ?? 0) + 1);
  const byHost = Array.from(counts.entries()).map(([host, pods]) => ({ host, pods })).sort((a, b) => b.pods - a.pods);
  const readyHosts = nodes.filter(n => n.role === 'host' && n.ready).length;
  const total = byHost.reduce((n, h) => n + h.pods, 0);
  return { byHost, readyHosts, concentrated: byHost.length === 1 && readyHosts > 1 && total > 1 ? byHost[0].host : undefined };
}

export interface BacklogRow {
  kind: string;
  notReady: number;
  total: number;
  /** Oldest stuck one, when its age is known. */
  oldest?: { name: string; hours: number };
}

export function backlog(r: SupervisorResult, inv: Inventory | undefined, now: Date): BacklogRow[] {
  const hours = (t?: string) => (t ? (now.getTime() - new Date(t).getTime()) / 3600e3 : undefined);
  const oldestOf = (xs: Array<{ name: string; since?: string }>) =>
    xs
      .map(x => ({ name: x.name, hours: hours(x.since) }))
      .filter((x): x is { name: string; hours: number } => x.hours !== undefined)
      .sort((a, b) => b.hours - a.hours)[0];
  const clusters = r.clusters;
  const badClusters = clusters.filter(c => c.health !== 'healthy');
  const machines = clusters.flatMap(c => c.machines.map(m => ({ c, m })));
  const badMachines = machines.filter(({ m }) => m.phase !== 'Running' || !m.ready);
  const vms = (inv?.vms ?? []).filter(v => !v.cluster);
  const badVms = vms.filter(v => v.ready === false);
  const lbs = inv?.lbs ?? [];
  const nsx = inv?.nsx ?? [];
  const subnets = inv?.subnets ?? [];
  const volumes = inv?.volumes ?? [];
  const badVolumes = volumes.filter((v: any) => v?.phase && v.phase !== 'Bound');
  return [
    { kind: 'Clusters', total: clusters.length, notReady: badClusters.length, oldest: oldestOf(badClusters.map(c => ({ name: c.name, since: c.conditions?.find(x => x.type === 'Ready' && x.status !== 'True')?.lastTransitionTime }))) },
    { kind: 'Machines', total: machines.length, notReady: badMachines.length, oldest: oldestOf(badMachines.map(({ m }) => ({ name: m.name, since: m.deletingSince ?? m.createdAt }))) },
    { kind: 'VMs', total: vms.length, notReady: badVms.length, oldest: oldestOf(badVms.map(v => ({ name: v.name, since: v.createdAt }))) },
    { kind: 'Load balancers', total: lbs.length, notReady: lbs.filter(l => !l.vip).length },
    { kind: 'NSX objects', total: nsx.length, notReady: nsx.filter(x => x.ready === false).length },
    { kind: 'Subnets', total: subnets.length, notReady: subnets.filter(s => s.ready === false).length },
    { kind: 'Volumes', total: volumes.length, notReady: badVolumes.length },
  ].filter(b => b.total > 0);
}

export function eventsByReason(events: EventInfo[]): Array<{ reason: string; count: number; example?: string }> {
  const m = new Map<string, { count: number; example?: string }>();
  for (const e of events) {
    const k = e.reason ?? 'Unknown';
    const cur = m.get(k) ?? { count: 0, example: e.message ? `${e.object}: ${e.message}`.slice(0, 180) : e.object };
    cur.count += e.count ?? 1;
    m.set(k, cur);
  }
  return Array.from(m.entries()).map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count);
}

/* ---------------- All together ---------------- */

export interface SupervisorHealth {
  supervisorId: string;
  name: string;
  nodes: NodeState[];
  leases: LeaseInfo[];
  /** Namespaces whose leases couldn't be read (permissions). */
  leasesUnreadable: string[];
  services: ServiceState[];
  placement: Placement;
  backlog: BacklogRow[];
  events: Array<{ reason: string; count: number; example?: string }>;
  score: number;
  errors: string[];
}

/** Namespaces where the Supervisor's controllers keep their leases (those the account can read are used). */
export const LEASE_NAMESPACES = (namespaces: string[]) => [
  ...namespaces.filter(n => /^svc-tkg-/.test(n)),
  'vmware-system-vmop',
  'vmware-system-capw',
  'vmware-system-nsx',
  'vmware-system-csi',
  'kube-system',
];

export async function fetchSupervisorHealth(client: SupervisorClient, r: SupervisorResult, inv: Inventory | undefined, now: Date = new Date()): Promise<SupervisorHealth> {
  const errors: string[] = [];
  const get = async <T>(label: string, path: string): Promise<T | undefined> => {
    try {
      return await client.get<T>(path);
    } catch (err) {
      if (statusOf(err) !== 404) errors.push(`${label}: ${describeError(err)}`);
      return undefined;
    }
  };
  const nsList = ((await get<{ items?: any[] }>('Namespaces', '/api/v1/namespaces'))?.items ?? []).map(n => n?.metadata?.name as string).filter(Boolean);
  const nodes = parseNodes((await get<{ items?: any[] }>('Nodes', '/api/v1/nodes'))?.items ?? []);
  const svcNs = nsList.filter(n => n.startsWith('svc-')).sort();
  const services = (
    await Promise.all(
      svcNs.map(async ns => {
        const pods = await get<{ items?: any[] }>(`Service ${ns}`, `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`);
        return pods ? analyseService(ns, pods.items ?? [], now) : undefined;
      })
    )
  ).filter((s): s is ServiceState => !!s);
  const leasesUnreadable: string[] = [];
  const leases = (
    await Promise.all(
      LEASE_NAMESPACES(nsList)
        .filter(ns => nsList.includes(ns))
        .map(async ns => {
          try {
            return parseLeases((await client.get<{ items?: any[] }>(`/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/leases`))?.items ?? [], now);
          } catch (err) {
            if (statusOf(err) === 403) leasesUnreadable.push(ns);
            return [];
          }
        })
    )
  ).flat();
  const h: SupervisorHealth = {
    supervisorId: r.supervisor.id,
    name: r.supervisor.displayName ?? r.supervisor.id,
    nodes,
    leases,
    leasesUnreadable,
    services,
    placement: placement(services, nodes),
    backlog: backlog(r, inv, now),
    events: eventsByReason(r.events ?? []),
    score: 100,
    errors,
  };
  h.score = healthScore(h);
  return h;
}

/** 100 is healthy; each kind of problem takes points off, the serious ones most. */
export function healthScore(h: Pick<SupervisorHealth, 'nodes' | 'leases' | 'services' | 'placement' | 'backlog'>): number {
  let s = 100;
  s -= 40 * h.nodes.filter(n => n.role === 'control-plane' && !n.ready).length;
  s -= 10 * h.nodes.filter(n => n.role === 'host' && !n.ready).length;
  s -= 25 * h.leases.filter(l => l.state !== 'ok').length;
  s -= 20 * h.services.filter(x => x.state === 'down').length;
  s -= 5 * h.services.filter(x => x.state === 'degraded').length;
  s -= Math.min(10, 2 * h.services.reduce((n, x) => n + x.leftovers.length, 0));
  if (h.placement.concentrated) s -= 10;
  s -= Math.min(20, h.backlog.reduce((n, b) => n + b.notReady, 0));
  return Math.max(0, Math.round(s));
}

export function responsiveness(stats: ClusterStats | undefined): { avgMs?: number; slowestMs?: number; errorRate?: number } {
  if (!stats || !stats.requests) return {};
  return { avgMs: Math.round(stats.totalMs / stats.requests), slowestMs: stats.slowestMs, errorRate: stats.errors / stats.requests };
}

/* ---------------- Issues and the clean-up action ---------------- */

export const SUPERVISOR_HEALTH_PATH = '/vks-fleet/supervisor-health';

export function supervisorHealthIssues(h: SupervisorHealth, context: string, now: Date = new Date()): Issue[] {
  const out: Issue[] = [];
  const base = {
    supervisorId: h.supervisorId,
    affected: { clusters: [], tenants: [], nodes: [], pods: [] },
    links: [],
    findingIds: [],
    detectedAt: now.toISOString(),
    primary: { label: 'Supervisor health', path: SUPERVISOR_HEALTH_PATH },
  };
  for (const l of h.leases.filter(x => x.state !== 'ok')) {
    out.push({
      ...base,
      id: `${h.supervisorId}#lease#${l.namespace}/${l.name}`,
      severity: 'critical',
      title: l.state === 'stale' ? `${l.controller} on ${h.name} stopped renewing its lease ${Math.round((l.renewedSecondsAgo ?? 0) / 60)} min ago` : `${l.controller} on ${h.name} has no leader`,
      cause: 'Controllers hold a leader-election lease and renew it every few seconds. A stale lease means the controller is stuck or gone, even if its pod shows Running; nothing it manages is being reconciled.',
      evidence: [`Lease ${l.namespace}/${l.name}${l.holder ? `, held by ${l.holder}` : ''}`],
      fix: 'Check the Supervisor in vCenter (Workload Management) and the control-plane VM that holds the lease; the controller usually recovers when its pod restarts.',
      runbook: [{ title: 'The lease', commands: [`kubectl --context ${context} -n ${l.namespace} get lease ${l.name} -o yaml`] }],
    });
  }
  // Services down and nodes not Ready are already raised by the Supervisor's service and node checks; not repeated here.
  const leftovers = h.services.flatMap(s => s.leftovers.map(p => ({ s, p })));
  if (leftovers.length) {
    out.push({
      ...base,
      id: `${h.supervisorId}#service-leftovers`,
      severity: 'info',
      title: `${leftovers.length} failed Supervisor service pod${leftovers.length === 1 ? '' : 's'} left behind on ${h.name}`,
      cause: 'Each has a running replacement, so the services are fine; these are failed vSphere Pods (typically ProviderFailed after a host event) that nothing removes.',
      evidence: leftovers.slice(0, 6).map(({ s, p }) => `${s.name}: ${p.name} (${p.reason ?? p.phase}${p.host ? ` on ${p.host}` : ''}, ${Math.round(p.ageDays)} days old)`),
      fix: 'Clean them up (Supervisor health → Clean up), or delete them with kubectl.',
      runbook: [{ title: 'Delete the leftovers', commands: leftovers.map(({ s, p }) => `kubectl --context ${context} -n ${s.namespace} delete pod ${p.name}`) }],
    });
  }
  if (h.placement.concentrated) {
    out.push({
      ...base,
      id: `${h.supervisorId}#service-placement`,
      severity: 'warning',
      title: `Every Supervisor service pod on ${h.name} runs on ${h.placement.concentrated}`,
      cause: `${h.placement.readyHosts} ESXi hosts are Ready, but all service pods run on one: if it fails, every service stops at once. Pods rescheduled after a host problem stay where they landed.`,
      evidence: h.placement.byHost.map(x => `${x.host}: ${x.pods} pod${x.pods === 1 ? '' : 's'}`),
      fix: 'Spread them by deleting one service\u2019s running pod at a time (each restarts briefly and may land on another host), in a quiet period.',
    });
  }
  return out;
}

/** Deletes a Supervisor's leftover failed service pods; blocked for any that no longer has a running replacement. */
export function leftoverCleanupPlan(h: SupervisorHealth): ActionPlan {
  const items = h.services.flatMap(s => s.leftovers.map(p => ({ s, p })));
  const checks: Check[] = items.length
    ? [
        { level: 'ok', text: `Each of the ${items.length} pods has a running replacement from the same owner; the services keep running.` },
        { level: 'ok', text: 'Nothing is restarted: only the failed pods are removed.' },
      ]
    : [{ level: 'block', text: 'No leftover pods to clean up.' }];
  return {
    id: `sv-leftovers#${h.supervisorId}#${items.map(i => i.p.name).join(',')}`,
    title: `Clean up failed service pods on ${h.name}`,
    summary: items.map(i => `${i.s.name}: ${i.p.name}`).join('; '),
    checks,
    reasonRequired: false,
    applyLabel: 'Delete them',
    requests: (): WriteRequest[] => items.map(i => ({ method: 'DELETE', path: `/api/v1/namespaces/${encodeURIComponent(i.s.namespace)}/pods/${encodeURIComponent(i.p.name)}` })),
  };
}

/** Used by the Supervisor list and the fleet page: a one-line state. */
export const healthTone = (score: number) => (score >= 90 ? 'success' : score >= 70 ? 'warning' : 'error');
