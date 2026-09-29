/**
 * Change impact analysis: before an upgrade, a pool scale or a VM class
 * change, what will happen and whether it's safe to start.
 *
 * Built on the pieces the plugin already has (the action plans and their
 * checks, the namespace capacity impact, the drain/PDB logic, deprecated APIs
 * in live traffic, Supervisor health), plus a blast radius read from the
 * cluster itself: which nodes get replaced or removed, what moves, and what
 * would have a brief outage or not come back.
 */
import { ActionPlan, blocked, Check, scalePlan, upgradePlan } from './actions';
import { describeError, SupervisorClient } from './api/client';
import { classSize, Delta, quotaLines, upgradeSurge } from './headroom';
import { Configured, NamespaceLimits } from './limits';
import { NodePod, nodePods } from './machine';
import { apiName, DeprecatedApi, removedBy } from './observability';
import { isVksManaged } from './packages';
import { impact, ImpactRow } from './provision';
import { FleetCluster, NodePool, VmClassInfo } from './types';

export type ChangeSpec =
  | { kind: 'upgrade'; target: string; moveClass?: boolean }
  | { kind: 'scale'; pool: string; replicas: number }
  | { kind: 'vmclass'; pool: string; vmClass: string };

export type Area = 'Change' | 'Capacity' | 'Disruption' | 'APIs' | 'Health' | 'Packages';
export const AREAS: Area[] = ['Change', 'Health', 'Capacity', 'Disruption', 'APIs', 'Packages'];

export interface PreflightCheck {
  area: Area;
  level: 'ok' | 'warn' | 'block';
  text: string;
}

export interface BlastRadius {
  /** Worker nodes replaced (upgrade, VM class) or that may be removed (scale down). */
  nodes: string[];
  /** Control-plane nodes replaced too (their static pods are recreated with them). */
  controlPlane: number;
  /** For a scale down: how many of `nodes` go (the Machine deletion policy picks which). */
  removing?: number;
  pods: number;
  workloads: number;
  namespaces: number;
  /** Workloads with a single running pod: a brief outage while it moves. */
  singleReplica: string[];
  /** Pods with no controller: evicted and not recreated. */
  unmanaged: string[];
  blockingPdbs: string[];
  pinned: string[];
}

export interface Preflight {
  title: string;
  checks: PreflightCheck[];
  blast?: BlastRadius;
  /** Namespace capacity: while the change runs, and after. */
  capacity: { during?: ImpactRow[]; after?: ImpactRow[] };
  verdict: 'go' | 'caution' | 'stop';
  recommendation: string;
  /** The change itself, for the action dialog (when the plugin can make it). */
  plan?: ActionPlan;
}

/** The workload cluster, as the pre-flight needs it: pods by node, PDBs, packages. */
export interface LiveCluster {
  nodes: Map<string, NodePod[]>;
  packages: Array<{ name: string; vks: boolean }>;
  error?: string;
}

export async function fetchLive(client: SupervisorClient): Promise<LiveCluster> {
  try {
    const [pods, pdbs] = await Promise.all([
      client.get<{ items?: any[] }>('/api/v1/pods'),
      client.get<{ items?: any[] }>('/apis/policy/v1/poddisruptionbudgets').catch(() => ({ items: [] })),
    ]);
    const byNode = new Map<string, any[]>();
    for (const p of pods?.items ?? []) {
      const n = p?.spec?.nodeName;
      if (n) byNode.set(n, [...(byNode.get(n) ?? []), p]);
    }
    const nodes = new Map<string, NodePod[]>(Array.from(byNode.entries()).map(([n, ps]) => [n, nodePods(ps, pdbs?.items ?? [], n)]));
    let packages: LiveCluster['packages'] = [];
    try {
      const pk = await client.get<{ items?: any[] }>('/apis/packaging.carvel.dev/v1alpha1/packageinstalls');
      packages = (pk?.items ?? []).map(p => ({ name: String(p?.spec?.packageRef?.refName ?? p?.metadata?.name ?? '').replace(/\.(tanzu\.vmware\.com|vmware\.com)$/, ''), vks: isVksManaged(p) }));
    } catch {
      /* no kapp-controller or no access: packages are skipped */
    }
    return { nodes, packages };
  } catch (err) {
    return { nodes: new Map(), packages: [], error: describeError(err) };
  }
}

export interface PreflightInput {
  cluster: FleetCluster;
  change: ChangeSpec;
  releases: string[];
  vmClasses: VmClassInfo[];
  limits?: NamespaceLimits;
  configured?: Configured;
  deprecated?: DeprecatedApi[];
  live?: LiveCluster;
  supervisorScore?: number;
  /** Controllers whose leases stopped renewing. */
  staleControllers?: string[];
}

const nodeOf = (_c: FleetCluster, m: FleetCluster['machines'][number]) => m.nodeName ?? m.name;
const fromChecks = (area: Area, checks: Check[]): PreflightCheck[] => checks.map(c => ({ area, level: c.level, text: c.text }));
const poolClass = (c: FleetCluster, p: NodePool) => p.vmClass ?? c.machines.find(m => m.pool === p.name)?.vm?.className;

const STATIC = /^(etcd|kube-apiserver|kube-controller-manager|kube-scheduler)-/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function blastRadius(c: FleetCluster, affected: string[], live: LiveCluster, removing?: number): BlastRadius {
  const cp = new Set(c.machines.filter(m => m.role === 'control-plane').map(m => nodeOf(c, m)));
  const workers = affected.filter(n => !cp.has(n));
  const all = Array.from(live.nodes.values()).flat();
  // Control-plane nodes are replaced by the control plane's own rollout; their static pods come back with them.
  const moving = workers
    .flatMap(n => live.nodes.get(n) ?? [])
    .filter(p => !p.daemonSet && !(p.namespace === 'kube-system' && STATIC.test(p.name)) && (p.phase === 'Running' || p.phase === 'Pending'));
  const runningByOwner = new Map<string, number>();
  for (const p of all) if (p.owner && !p.daemonSet && p.phase === 'Running') runningByOwner.set(`${p.namespace}/${p.owner}`, (runningByOwner.get(`${p.namespace}/${p.owner}`) ?? 0) + 1);
  const owners = new Set(moving.filter(p => p.owner).map(p => `${p.namespace}/${p.owner}`));
  return {
    nodes: workers,
    controlPlane: affected.filter(n => cp.has(n)).length,
    removing,
    pods: moving.length,
    workloads: owners.size,
    namespaces: new Set(moving.map(p => p.namespace)).size,
    singleReplica: Array.from(owners).filter(o => (runningByOwner.get(o) ?? 0) === 1).sort(),
    unmanaged: moving.filter(p => !p.owner).map(p => `${p.namespace}/${p.name}`),
    blockingPdbs: Array.from(new Set(moving.map(p => p.blockingPdb && `${p.namespace}/${p.blockingPdb}`).filter((x): x is string => !!x))),
    pinned: moving.filter(p => p.pinned).map(p => `${p.namespace}/${p.name} (${p.pinned})`),
  };
}

export function preflight(i: PreflightInput): Preflight {
  const c = i.cluster;
  const checks: PreflightCheck[] = [];
  const capacity: Preflight['capacity'] = {};
  const lines = quotaLines(c.quota);
  let affected: string[] = [];
  let removing: number | undefined;
  let plan: ActionPlan | undefined;
  let title = '';

  /* ---- the change itself ---- */
  if (i.change.kind === 'upgrade') {
    const ch = i.change;
    title = `Upgrade ${c.name} ${c.kubernetesVersion ?? '?'} → ${ch.target}`;
    // PDBs are checked below from the live cluster, with the pods they hold.
    plan = upgradePlan(c, ch.target, ch.moveClass && c.classUpdate ? c.classUpdate : null, { available: i.releases, blockingPdbs: [] });
    checks.push(...fromChecks('Change', plan.checks.filter(x => !/PodDisruptionBudget|PDB/i.test(x.text))));
    affected = c.machines.map(m => nodeOf(c, m));
    const surge = upgradeSurge(c, i.vmClasses);
    const during = impact(surge, i.configured, i.limits, lines);
    capacity.during = during.rows;
    checks.push(...fromChecks('Capacity', during.checks.map(x => ({ ...x, text: `While it runs (one extra VM per node pool, rolling): ${x.text}` }))));
    if (surge.unknown.length) checks.push({ area: 'Capacity', level: 'warn', text: `Size unknown for ${surge.unknown.join(', ')} (VM class not found in ${c.namespace}); the temporary capacity is underestimated.` });
    const removed = (i.deprecated ?? []).filter(d => removedBy(d, ch.target));
    if (i.deprecated) {
      checks.push(
        removed.length
          ? { area: 'APIs', level: 'warn', text: `Still in use and removed by ${ch.target}: ${removed.map(apiName).join(', ')}. Update whatever calls them first.` }
          : { area: 'APIs', level: 'ok', text: i.deprecated.length ? `No API in use is removed by ${ch.target}.` : 'No deprecated APIs in use.' }
      );
    } else {
      checks.push({ area: 'APIs', level: 'warn', text: 'Deprecated API use unknown (needs the cluster\u2019s Prometheus): check with kubectl-deprecations or pluto before a minor upgrade.' });
    }
    if (i.live && !i.live.error && i.live.packages.length) {
      const yours = i.live.packages.filter(p => !p.vks).map(p => p.name);
      checks.push({ area: 'Packages', level: 'ok', text: `${plural(i.live.packages.length - yours.length, 'VKS-managed package')} move${i.live.packages.length - yours.length === 1 ? 's' : ''} with the release.` });
      if (yours.length) checks.push({ area: 'Packages', level: 'warn', text: `Packages you manage, to check against ${ch.target}: ${yours.join(', ')}.` });
    }
  } else if (i.change.kind === 'scale') {
    const ch = i.change;
    const pool = c.nodePools.find(p => p.name === ch.pool);
    title = `Scale ${c.name} pool ${ch.pool} ${pool?.desired ?? '?'} → ${ch.replicas}`;
    if (!pool) {
      checks.push({ area: 'Change', level: 'block', text: `Pool ${ch.pool} not found in ${c.name}.` });
    } else {
      plan = scalePlan(c, pool, ch.replicas);
      checks.push(...fromChecks('Change', plan.checks));
      const cur = pool.desired ?? pool.ready;
      const size = classSize(i.vmClasses, c.namespace, poolClass(c, pool));
      const poolNodes = c.machines.filter(m => m.pool === pool.name).map(m => nodeOf(c, m));
      if (ch.replicas > cur) {
        const add: Delta = { cpus: (size?.cpus ?? 0) * (ch.replicas - cur), memoryBytes: (size?.memoryBytes ?? 0) * (ch.replicas - cur) };
        const after = impact(add, i.configured, i.limits, lines);
        capacity.after = after.rows;
        checks.push(...fromChecks('Capacity', after.checks));
        if (!size) checks.push({ area: 'Capacity', level: 'warn', text: `VM class ${poolClass(c, pool) ?? '?'} not found in ${c.namespace}: the added capacity is unknown.` });
      } else if (ch.replicas < cur) {
        affected = poolNodes;
        removing = cur - ch.replicas;
        checks.push({ area: 'Capacity', level: 'ok', text: `Frees ${cur - ch.replicas} VM${cur - ch.replicas === 1 ? '' : 's'} of ${poolClass(c, pool) ?? 'this class'}.` });
        if (ch.replicas <= 1) checks.push({ area: 'Disruption', level: 'warn', text: `${ch.replicas === 0 ? 'No nodes' : 'A single node'} left in ${pool.name}: no room to move pods during node repair or the next upgrade.` });
      }
    }
  } else {
    const ch = i.change;
    const pool = c.nodePools.find(p => p.name === ch.pool);
    const from = pool ? poolClass(c, pool) : undefined;
    title = `Change ${c.name} pool ${ch.pool} VM class ${from ?? '?'} → ${ch.vmClass}`;
    const to = classSize(i.vmClasses, c.namespace, ch.vmClass);
    const was = classSize(i.vmClasses, c.namespace, from);
    if (!pool) checks.push({ area: 'Change', level: 'block', text: `Pool ${ch.pool} not found in ${c.name}.` });
    else if (from === ch.vmClass) checks.push({ area: 'Change', level: 'block', text: `Pool ${ch.pool} already uses ${ch.vmClass}.` });
    else if (!i.vmClasses.some(v => v.name === ch.vmClass && v.namespace === c.namespace)) checks.push({ area: 'Change', level: 'block', text: `VM class ${ch.vmClass} isn't available in ${c.namespace}; a vSphere administrator adds it to the namespace first.` });
    else checks.push({ area: 'Change', level: 'ok', text: `Every node in ${ch.pool} is replaced, one at a time, with a ${ch.vmClass} VM (${to?.cpus ?? '?'} vCPU, ${to?.memoryBytes ? `${Math.round(to.memoryBytes / 2 ** 30)} GiB` : '?'}). Made in the cluster's spec (or its GitOps source); the plugin checks it, it doesn't apply it.` });
    if (to?.reserved) checks.push({ area: 'Capacity', level: 'warn', text: `${ch.vmClass} is guaranteed: its memory is reserved, and power-on fails if the namespace can't reserve it.` });
    if (pool) {
      affected = c.machines.filter(m => m.pool === pool.name).map(m => nodeOf(c, m));
      const n = pool.desired ?? pool.ready;
      if (to) {
        const during = impact({ cpus: to.cpus ?? 0, memoryBytes: to.memoryBytes ?? 0, reservedBytes: to.reserved ? to.memoryBytes : 0 }, i.configured, i.limits, lines);
        capacity.during = during.rows;
        checks.push(...fromChecks('Capacity', during.checks.map(x => ({ ...x, text: `While it runs (one extra ${ch.vmClass} VM): ${x.text}` }))));
      }
      if (to && was) {
        const add: Delta = { cpus: ((to.cpus ?? 0) - (was.cpus ?? 0)) * n, memoryBytes: ((to.memoryBytes ?? 0) - (was.memoryBytes ?? 0)) * n };
        const after = impact(add, i.configured, i.limits, lines);
        capacity.after = after.rows;
        checks.push(...fromChecks('Capacity', after.checks.map(x => ({ ...x, text: `Afterwards: ${x.text}` }))));
      }
    }
  }

  /* ---- health gates ---- */
  if (c.paused) checks.push({ area: 'Health', level: 'block', text: 'The cluster is paused: Cluster API ignores changes until it is resumed.' });
  if (c.upgrading) checks.push({ area: 'Health', level: 'block', text: 'An upgrade is already rolling: wait for it to finish.' });
  const said = (re: RegExp) => checks.some(x => x.area === 'Change' && re.test(x.text));
  const stuck = c.machines.filter(m => m.deletingSince);
  if (stuck.length && !said(/deleting/i)) checks.push({ area: 'Health', level: 'block', text: `${stuck.length} node${stuck.length === 1 ? ' is' : 's are'} stuck deleting (${stuck.map(m => m.name).join(', ')}): a new rollout queues behind it. Resolve that first (Investigate).` });
  if (i.staleControllers?.length) checks.push({ area: 'Health', level: 'block', text: `Controllers not renewing their leases on the Supervisor: ${i.staleControllers.join(', ')}. Nothing would be reconciled.` });
  if (c.health !== 'healthy' && !stuck.length && !said(/degraded|unhealthy|failed/i)) checks.push({ area: 'Health', level: 'warn', text: `The cluster is ${c.health}${c.issues.length ? `: ${c.issues.slice(0, 2).join('; ')}` : ''}.` });
  if (i.supervisorScore !== undefined) checks.push(i.supervisorScore < 70 ? { area: 'Health', level: 'warn', text: `Supervisor health is ${i.supervisorScore}/100: look at Supervisor health before changing clusters.` } : { area: 'Health', level: 'ok', text: `Supervisor health ${i.supervisorScore}/100.` });
  if (c.health === 'healthy' && !stuck.length && !c.paused && !c.upgrading) checks.push({ area: 'Health', level: 'ok', text: 'Cluster healthy, not paused, no rollout in progress.' });

  /* ---- blast radius ---- */
  let blast: BlastRadius | undefined;
  if (affected.length) {
    if (!i.live || i.live.error) {
      checks.push({ area: 'Disruption', level: 'warn', text: `Couldn't read the cluster${i.live?.error ? ` (${i.live.error})` : ''}: sign in to see which pods move and what would block a drain.` });
    } else {
      blast = blastRadius(c, affected, i.live, removing);
      const up = removing ? 'up to ' : '';
      checks.push({
        area: 'Disruption',
        level: 'ok',
        text: `${removing ? `${removing} of ${blast.nodes.length} nodes go (the deletion policy picks which)` : `${plural(blast.nodes.length, 'worker node')} replaced one at a time${blast.controlPlane ? `, after the control plane (${plural(blast.controlPlane, 'node')})` : ''}`}: ${up}${plural(blast.pods, 'pod')} in ${plural(blast.workloads, 'workload')} across ${plural(blast.namespaces, 'namespace')} ${blast.pods === 1 ? 'moves' : 'move'}.`,
      });
      if (blast.blockingPdbs.length) checks.push({ area: 'Disruption', level: 'warn', text: `PodDisruptionBudgets allowing no disruptions now: ${blast.blockingPdbs.join(', ')}. Drains wait on them, and the rollout stalls until the node drain timeout.` });
      if (blast.singleReplica.length) checks.push({ area: 'Disruption', level: 'warn', text: `Single-replica workloads with a brief outage while they move: ${blast.singleReplica.slice(0, 6).join(', ')}${blast.singleReplica.length > 6 ? ` and ${blast.singleReplica.length - 6} more` : ''}.` });
      if (blast.unmanaged.length) checks.push({ area: 'Disruption', level: 'warn', text: `Pods with no controller are evicted and not recreated: ${blast.unmanaged.slice(0, 5).join(', ')}${blast.unmanaged.length > 5 ? '…' : ''}.` });
      if (blast.pinned.length) checks.push({ area: 'Disruption', level: 'warn', text: `Pinned to a node, so they can't move: ${blast.pinned.slice(0, 4).join('; ')}.` });
    }
  }

  const blocks = checks.filter(x => x.level === 'block');
  const warns = checks.filter(x => x.level === 'warn');
  const verdict: Preflight['verdict'] = blocks.length ? 'stop' : warns.length ? 'caution' : 'go';
  const areas = (xs: PreflightCheck[]) => Array.from(new Set(xs.map(x => x.area.toLowerCase()))).join(', ');
  const recommendation =
    verdict === 'stop'
      ? `Don't start yet: resolve ${blocks.length} blocker${blocks.length === 1 ? '' : 's'} (${areas(blocks)}).`
      : verdict === 'caution'
      ? `Can go ahead, after reviewing ${warns.length} warning${warns.length === 1 ? '' : 's'} (${areas(warns)}).`
      : 'Clear to go.';
  if (plan && verdict === 'stop' && !blocked(plan)) plan = { ...plan, checks: [...plan.checks, ...blocks.filter(b => b.area !== 'Change').map(b => ({ level: 'block' as const, text: b.text }))] };
  return { title, checks, blast, capacity, verdict, recommendation, plan };
}
