/**
 * Operator actions as plain data: what will happen, the checks that decide
 * whether it's safe, and the exact writes to the Supervisor. No Headlamp or
 * React here, so every rule is testable and reviewable on its own.
 *
 * Every action is previewed with a server-side dry run, runs with the
 * signed-in user's identity, and stamps the Cluster with what was done and why.
 */
import { WriteRequest } from './api/client';
import { upgradeKind } from './releases';
import { FleetCluster, MachineInfo, NodePool, ServiceVm } from './types';

export const ACTION_ANNOTATION = 'vks-fleet/last-action';
/** The one Machine change VKS lets users make: asks the MachineHealthCheck to replace the machine. */
export const REMEDIATE_ANNOTATION = 'cluster.x-k8s.io/remediate-machine';
const CAPI_PAUSED_ANNOTATION = 'cluster.x-k8s.io/paused';

const CAPI = '/apis/cluster.x-k8s.io/v1beta1';
const MERGE = 'application/merge-patch+json';
const JSON_PATCH = 'application/json-patch+json';

export type CheckLevel = 'ok' | 'warn' | 'block';

export interface Check {
  level: CheckLevel;
  text: string;
}

export interface ActionPlan {
  /** Stable identity of the action, for re-running the dry run when it changes. */
  id: string;
  title: string;
  /** What will happen, in one or two sentences. */
  summary: string;
  checks: Check[];
  /** A reason is recorded on the Cluster; required for risky actions. */
  reasonRequired: boolean;
  /** Text the user must type to confirm, for destructive actions. */
  confirmText?: string;
  applyLabel: string;
  requests: (reason: string, now?: Date) => WriteRequest[];
}

export function blocked(plan: ActionPlan): boolean {
  return plan.checks.some(c => c.level === 'block');
}

function clusterUrl(c: FleetCluster): string {
  return `${CAPI}/namespaces/${encodeURIComponent(c.namespace)}/clusters/${encodeURIComponent(c.name)}`;
}

function machineUrl(c: FleetCluster, m: MachineInfo): string {
  return `${CAPI}/namespaces/${encodeURIComponent(c.namespace)}/machines/${encodeURIComponent(m.name)}`;
}

export function stamp(action: string, reason: string, now: Date = new Date()): string {
  const r = reason.trim();
  return `${now.toISOString()} ${action}${r ? `: ${r}` : ''}`;
}

/** Records the action on the Cluster object. Merge patch, so it works whether or not annotations exist. */
function stampCluster(c: FleetCluster, action: string, reason: string, now?: Date): WriteRequest {
  return {
    method: 'PATCH',
    path: clusterUrl(c),
    contentType: MERGE,
    body: { metadata: { annotations: { [ACTION_ANNOTATION]: stamp(action, reason, now) } } },
  };
}

function nodeLabel(m: MachineInfo): string {
  return m.nodeName ?? m.name;
}

/* ---------------- Pause / resume ---------------- */

export function pausePlan(c: FleetCluster, pause: boolean): ActionPlan {
  const checks: Check[] = [];
  if (pause) {
    checks.push({
      level: 'ok',
      text: 'Nodes and workloads keep running. Only Supervisor-side changes and automatic repairs stop.',
    });
    if (c.upgrading) checks.push({ level: 'warn', text: 'An upgrade is in progress. Pausing stops it part-way until you resume.' });
    if (c.machines.some(m => m.deletingSince)) {
      checks.push({ level: 'warn', text: 'A machine is being deleted. Its deletion stops until you resume.' });
    }
    if (c.paused) checks.push({ level: 'block', text: 'The cluster is already paused.' });
  } else {
    if (!c.paused) checks.push({ level: 'block', text: 'The cluster is not paused.' });
    checks.push({
      level: 'ok',
      text: 'Pending changes, upgrades and repairs start applying again as soon as it resumes.',
    });
  }
  const action = pause ? 'paused' : 'resumed';
  return {
    id: `${c.key}#${action}`,
    title: pause ? `Pause ${c.name}` : `Resume ${c.name}`,
    summary: pause
      ? 'Stops the Supervisor from reconciling this cluster, for example during maintenance.'
      : 'Lets the Supervisor reconcile this cluster again.',
    checks,
    reasonRequired: pause,
    applyLabel: pause ? 'Pause' : 'Resume',
    requests: (reason, now) => [
      {
        method: 'PATCH',
        path: clusterUrl(c),
        contentType: MERGE,
        body: {
          metadata: {
            annotations: {
              [ACTION_ANNOTATION]: stamp(action, reason, now),
              // Resuming also clears the annotation form of pause; null removes the key.
              ...(pause ? {} : { [CAPI_PAUSED_ANNOTATION]: null }),
            },
          },
          spec: { paused: pause },
        },
      },
    ],
  };
}

/* ---------------- Scale a node pool ---------------- */

export function scalePlan(c: FleetCluster, pool: NodePool, replicas: number): ActionPlan {
  const checks: Check[] = [];
  const current = pool.desired;
  if (pool.topologyIndex === undefined) {
    checks.push({ level: 'block', text: "This pool isn't managed through the cluster's topology, so it can't be scaled here." });
  }
  if (pool.autoscaler) {
    checks.push({
      level: 'block',
      text: `The autoscaler manages this pool (${pool.autoscaler.min ?? '?'} to ${pool.autoscaler.max ?? '?'} nodes). Change its limits instead.`,
    });
  }
  if (!Number.isInteger(replicas) || replicas < 0) {
    checks.push({ level: 'block', text: 'Enter a whole number of nodes, 0 or more.' });
  } else if (current !== undefined && replicas === current) {
    checks.push({ level: 'block', text: `The pool already has ${current} node${current === 1 ? '' : 's'}.` });
  } else if (current !== undefined && replicas < current) {
    const n = current - replicas;
    checks.push({
      level: 'warn',
      text: `${n} node${n === 1 ? ' is' : 's are'} drained and deleted. Pods move to the remaining nodes, and PodDisruptionBudgets can slow this down.`,
    });
    if (replicas === 0) {
      checks.push({ level: 'warn', text: 'With 0 nodes, workloads that need this pool stop running.' });
    }
  } else if (current !== undefined && replicas > current) {
    const sample = c.machines.find(m => m.pool === pool.name && m.vm?.cpus !== undefined);
    const n = replicas - current;
    const size =
      sample?.vm?.cpus !== undefined && sample.vm.memoryBytes !== undefined
        ? ` (about ${n * sample.vm.cpus} vCPU and ${Math.round((n * sample.vm.memoryBytes) / 2 ** 30)} GiB more)`
        : '';
    checks.push({ level: 'ok', text: `${n} node${n === 1 ? ' is' : 's are'} added${size}.` });
  }
  if (c.paused) checks.push({ level: 'warn', text: 'The cluster is paused. The change applies when it resumes.' });
  if (current !== undefined && replicas < current && c.machines.some(m => m.pool === pool.name && m.deletingSince)) {
    checks.push({ level: 'warn', text: 'A machine in this pool is still being deleted. Scaling down may wait behind it.' });
  }

  const i = pool.topologyIndex ?? -1;
  const base = `/spec/topology/workers/machineDeployments/${i}`;
  return {
    id: `${c.key}#scale#${pool.name}#${replicas}`,
    title: `Scale ${pool.name}`,
    summary: `Sets node pool ${pool.name} to ${replicas} node${replicas === 1 ? '' : 's'}${
      current !== undefined ? ` (now ${current})` : ''
    }.`,
    checks,
    reasonRequired: false,
    confirmText: replicas === 0 ? c.name : undefined,
    applyLabel: 'Scale',
    requests: (reason, now) => [
      {
        method: 'PATCH',
        path: clusterUrl(c),
        contentType: JSON_PATCH,
        // "test" makes the patch fail if the pool moved in the list since the page loaded.
        body: [
          { op: 'test', path: `${base}/name`, value: pool.name },
          { op: 'add', path: `${base}/replicas`, value: replicas },
        ],
      },
      stampCluster(c, `scaled ${pool.name} to ${replicas}`, reason, now),
    ],
  };
}

/* ---------------- Replace a node ---------------- */

/**
 * Replaces a node. On VKS users may not edit Machines except for the
 * remediate-machine annotation, so machines covered by a MachineHealthCheck
 * are replaced through it: the health check drains, deletes and recreates the
 * node within its own safety limits. Machines no health check covers fall
 * back to deleting the Machine (the dry run shows whether that's allowed).
 */
export function replacePlan(c: FleetCluster, m: MachineInfo): ActionPlan {
  const checks: Check[] = [];
  const viaHealthCheck = m.healthChecked === true;
  if (m.deletingSince) checks.push({ level: 'block', text: 'This machine is already being deleted.' });
  if (c.paused) checks.push({ level: 'block', text: 'The cluster is paused, so nothing would replace the node. Resume it first.' });
  if (m.role === 'control-plane') {
    if ((c.controlPlane?.desired ?? 1) <= 1) {
      checks.push({
        level: 'block',
        text: "This is the only control-plane node. Replacing it takes the cluster's API down. Scale the control plane to 3 first.",
      });
    } else {
      checks.push({ level: 'warn', text: 'A control-plane node is replaced. The API stays up on the other control-plane nodes.' });
    }
  } else {
    const pool = c.nodePools.find(p => p.name === m.pool);
    if (pool?.desired !== undefined && pool.desired <= 1) {
      checks.push({
        level: 'warn',
        text: 'This is the only node in its pool. Workloads that need it are down until the replacement is ready.',
      });
    }
  }
  if (viaHealthCheck && c.healthCheck && !c.healthCheck.remediationAllowed) {
    checks.push({
      level: 'block',
      text: "Automatic repair has stopped on this cluster (too many unhealthy nodes), so the health check wouldn't act. Fix the cause first.",
    });
  }
  const others = c.machines.filter(x => x.name !== m.name && (x.deletingSince || x.ready === false));
  if (others.length) {
    checks.push({
      level: 'warn',
      text: `${others.length} other node${others.length === 1 ? ' is' : 's are'} already unhealthy or being deleted.`,
    });
  }
  checks.push(
    viaHealthCheck
      ? {
          level: 'ok',
          text: "The cluster's health check replaces it: the node is drained, its VM deleted and a new one created with the same settings.",
        }
      : {
          level: 'warn',
          text: 'No health check covers this machine, so the Machine is deleted directly. VKS may not allow that; the dry run will say.',
        }
  );
  const pool = c.nodePools.find(p => p.name === m.pool);
  if (pool?.nodeDrainTimeout) {
    checks.push({
      level: 'warn',
      text: `This pool has a drain timeout of ${pool.nodeDrainTimeout}, so pods that can't be evicted in time are stopped.`,
    });
  }
  return {
    id: `${c.key}#replace#${m.name}#${viaHealthCheck}`,
    title: `Replace node ${nodeLabel(m)}`,
    summary: viaHealthCheck
      ? 'Asks the cluster\'s health check to replace this node.'
      : 'Deletes this machine. Cluster API then builds a new node in its place.',
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Replace node',
    requests: (reason, now) => [
      stampCluster(c, `replaced node ${nodeLabel(m)}`, reason, now),
      viaHealthCheck
        ? {
            method: 'PATCH',
            path: machineUrl(c, m),
            contentType: MERGE,
            body: { metadata: { annotations: { [REMEDIATE_ANNOTATION]: '' } } },
          }
        : { method: 'DELETE', path: machineUrl(c, m) },
    ],
  };
}

/* ---------------- Drain timeout on a node pool ---------------- */

/** Go-style duration like "60s", "5m", "1h30m". Returns seconds, or undefined if invalid. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || text.trim() === '') return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

export type TimeoutKind = 'drain' | 'volume';

const TIMEOUT_FIELD: Record<TimeoutKind, 'nodeDrainTimeout' | 'nodeVolumeDetachTimeout'> = {
  drain: 'nodeDrainTimeout',
  volume: 'nodeVolumeDetachTimeout',
};

export function currentTimeout(pool: NodePool, kind: TimeoutKind): string | undefined {
  return kind === 'drain' ? pool.nodeDrainTimeout : pool.nodeVolumeDetachTimeout;
}

/**
 * Sets (or clears, with timeout null) how long Cluster API waits on a
 * deleting node in this pool: for the drain, or for its volumes to detach.
 * Written on the Cluster's topology, which Cluster API passes down to the
 * pool's existing machines, so it also unblocks a deletion that's already
 * stuck. Only writes to the Cluster, which VKS allows.
 */
export function timeoutPlan(c: FleetCluster, pool: NodePool, kind: TimeoutKind, timeout: string | null): ActionPlan {
  const checks: Check[] = [];
  const field = TIMEOUT_FIELD[kind];
  const existing = currentTimeout(pool, kind);
  const what = kind === 'drain' ? 'drain timeout' : 'volume-detach timeout';
  const seconds = timeout === null ? undefined : parseDuration(timeout);
  if (pool.topologyIndex === undefined) {
    checks.push({ level: 'block', text: "This pool isn't managed through the cluster's topology." });
  }
  if (timeout === null) {
    if (!existing) checks.push({ level: 'block', text: `This pool has no ${what} to clear.` });
    checks.push({
      level: 'ok',
      text:
        kind === 'drain'
          ? 'Drains go back to waiting until every pod has been evicted.'
          : 'Deletions go back to waiting until every volume has detached.',
    });
  } else if (seconds === undefined || seconds < 1) {
    checks.push({ level: 'block', text: 'Enter a duration such as 60s, 5m or 1h.' });
  } else {
    const stuck = c.machines.filter(m => m.pool === pool.name && m.deletingSince);
    checks.push(
      kind === 'drain'
        ? {
            level: 'warn',
            text: `After ${timeout}, pods still on a draining node are stopped without eviction, and PodDisruptionBudgets are ignored.`,
          }
        : {
            level: 'warn',
            text: `After ${timeout}, the VM is deleted even if volumes haven't detached cleanly. If a workload was still writing, data may be lost. Force-remove the stuck pod first if you can.`,
          }
    );
    if (stuck.length) {
      checks.push({
        level: 'ok',
        text: `${stuck.length} machine${stuck.length === 1 ? ' is' : 's are'} stuck deleting in this pool and will continue once the timeout has passed.`,
      });
    }
    checks.push({
      level: 'ok',
      text: 'Once the stuck deletion finishes, clear the timeout so this pool goes back to waiting normally.',
    });
  }
  const i = pool.topologyIndex ?? -1;
  const base = `/spec/topology/workers/machineDeployments/${i}`;
  const clearing = timeout === null;
  return {
    id: `${c.key}#timeout#${kind}#${pool.name}#${timeout ?? 'clear'}`,
    title: clearing ? `Clear ${what} on ${pool.name}` : `Set ${what} on ${pool.name}`,
    summary: clearing
      ? `Removes the ${what} (${existing ?? 'none'}) from node pool ${pool.name}.`
      : kind === 'drain'
      ? `Cluster API stops draining a node in ${pool.name} after ${timeout} and carries on deleting it.`
      : `Cluster API stops waiting for volumes to detach from a node in ${pool.name} after ${timeout} and deletes it.`,
    checks,
    reasonRequired: !clearing,
    confirmText: clearing ? undefined : c.name,
    applyLabel: clearing ? 'Clear timeout' : 'Set timeout',
    requests: (reason, now) => [
      {
        method: 'PATCH',
        path: clusterUrl(c),
        contentType: JSON_PATCH,
        body: [
          { op: 'test', path: `${base}/name`, value: pool.name },
          clearing ? { op: 'remove', path: `${base}/${field}` } : { op: 'add', path: `${base}/${field}`, value: timeout },
        ],
      },
      stampCluster(c, clearing ? `cleared ${what} on ${pool.name}` : `set ${what} ${timeout} on ${pool.name}`, reason, now),
    ],
  };
}

/* ---------------- Upgrade ---------------- */

export interface UpgradeContext {
  /** Releases the Supervisor offers, to confirm the target is one of them. */
  available: string[];
  /** PodDisruptionBudgets in the workload cluster that allow no disruptions right now, if known. */
  blockingPdbs?: string[];
  /** Why the PDB check couldn't run, if it couldn't. */
  pdbCheck?: string;
}

/**
 * Upgrades the cluster's Kubernetes version (and optionally its ClusterClass)
 * by changing the Cluster's topology. VKS then rolls the control plane first
 * and each node pool after it, one node at a time.
 */
export function upgradePlan(c: FleetCluster, target: string, newClass: string | null, ctx: UpgradeContext): ActionPlan {
  const checks: Check[] = [];
  const kind = upgradeKind(c.kubernetesVersion, target);
  const current = c.kubernetesVersion;

  if (!current) checks.push({ level: 'block', text: "The cluster's current version isn't known." });
  if (!target) checks.push({ level: 'block', text: 'Choose a version to upgrade to.' });
  else if (!ctx.available.includes(target)) {
    checks.push({ level: 'block', text: `${target} isn't one of the releases this Supervisor offers.` });
  }
  if (c.upgrading) checks.push({ level: 'block', text: 'An upgrade is already in progress. Let it finish first.' });
  if (c.paused) checks.push({ level: 'block', text: 'The cluster is paused. Resume it first.' });
  if (c.health === 'failed' || c.health === 'provisioning' || c.health === 'deleting') {
    checks.push({ level: 'block', text: `The cluster is ${c.health}. Upgrade a cluster that's up and settled.` });
  } else if (c.health !== 'healthy') {
    checks.push({ level: 'warn', text: `The cluster is ${c.health}. Check its findings before upgrading.` });
  }
  if (c.issues.length) {
    checks.push({ level: 'block', text: `Fix these first: ${c.issues.join('; ')}.` });
  }
  if (c.healthCheck && !c.healthCheck.remediationAllowed) {
    checks.push({ level: 'block', text: "Automatic node repair has stopped. Nodes that fail during the upgrade wouldn't be replaced." });
  }
  if (kind === 'minor') {
    checks.push({ level: 'ok', text: 'Minor-version upgrade: one step, as VKS requires.' });
  } else if (kind === 'patch') {
    checks.push({ level: 'ok', text: 'Patch upgrade within the same minor version.' });
  }
  if ((c.controlPlane?.desired ?? 0) === 1) {
    checks.push({
      level: 'warn',
      text: 'Single control-plane node: a new one is created before the old one is removed, but the API may be briefly unavailable during the switch.',
    });
  }
  for (const p of c.nodePools) {
    if (p.nodeDrainTimeout) {
      checks.push({
        level: 'warn',
        text: `Pool ${p.name} has a drain timeout of ${p.nodeDrainTimeout}: pods that can't be evicted in time are stopped during the rolling upgrade.`,
      });
    }
  }
  if (ctx.blockingPdbs && ctx.blockingPdbs.length) {
    checks.push({
      level: 'warn',
      text: `${ctx.blockingPdbs.length} PodDisruptionBudget${ctx.blockingPdbs.length === 1 ? ' allows' : 's allow'} no disruptions right now (${ctx.blockingPdbs
        .slice(0, 5)
        .join(', ')}${ctx.blockingPdbs.length > 5 ? ', …' : ''}). Node drains will wait on them.`,
    });
  } else if (ctx.blockingPdbs) {
    checks.push({ level: 'ok', text: 'No PodDisruptionBudget is blocking disruptions, so drains should flow.' });
  } else if (ctx.pdbCheck) {
    checks.push({ level: 'warn', text: `PodDisruptionBudgets not checked: ${ctx.pdbCheck}` });
  }
  const tightQuota = (c.quota ?? []).filter(q => (q.ratio ?? 0) >= 0.9);
  if (tightQuota.length) {
    checks.push({
      level: 'warn',
      text: `Namespace quota is nearly full (${tightQuota.map(q => q.resource).join(', ')}). The rolling upgrade adds a node temporarily and may not fit.`,
    });
  }
  if (newClass) {
    checks.push({
      level: 'warn',
      text: `The cluster also moves from ${c.clusterClass} to ${newClass}. VKS checks the class is compatible; the dry run shows whether it accepts the change.`,
    });
  }
  checks.push({
    level: 'ok',
    text: 'The control plane is upgraded first, then each node pool one node at a time. Progress shows on the cluster page and in the upgrade planner.',
  });

  const body: unknown[] = [
    { op: 'test', path: '/spec/topology/version', value: current },
    { op: 'replace', path: '/spec/topology/version', value: target },
  ];
  if (newClass && c.clusterClass) {
    body.push({ op: 'test', path: '/spec/topology/class', value: c.clusterClass });
    body.push({ op: 'replace', path: '/spec/topology/class', value: newClass });
  }

  return {
    id: `${c.key}#upgrade#${target}#${newClass ?? ''}#${(ctx.blockingPdbs ?? []).length}#${ctx.pdbCheck ?? ''}`,
    title: `Upgrade ${c.name}`,
    summary: target
      ? `From ${current ?? 'unknown'} to ${target}${newClass ? `, and to class ${newClass}` : ''}.`
      : 'Choose the version to upgrade to.',
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Upgrade',
    requests: (reason, now) => [
      { method: 'PATCH', path: clusterUrl(c), contentType: JSON_PATCH, body },
      stampCluster(c, `upgrade to ${target}${newClass ? ` (class ${newClass})` : ''}`, reason, now),
    ],
  };
}

export interface PoolProgress {
  name: string;
  updated: number;
  total: number;
}

/** How far a rolling upgrade has got: nodes already on the desired version, per group. */
export function upgradeProgress(c: FleetCluster): { controlPlane: PoolProgress; pools: PoolProgress[] } | undefined {
  const target = c.kubernetesVersion;
  if (!target) return undefined;
  const same = (v?: string) => (v ?? '').replace(/^v/, '') === target.replace(/^v/, '');
  const live = c.machines.filter(m => !m.deletingSince);
  const cp = live.filter(m => m.role === 'control-plane');
  const pools = c.nodePools.map(p => {
    const ms = live.filter(m => m.pool === p.name);
    return { name: p.name, updated: ms.filter(m => same(m.version)).length, total: ms.length };
  });
  return {
    controlPlane: { name: 'Control plane', updated: cp.filter(m => same(m.version)).length, total: cp.length },
    pools,
  };
}

/* ---------------- Baseline fixes ---------------- */

/** Grows the control plane (e.g. 1 → 3 for high availability) through the Cluster's topology. */
export function controlPlaneReplicasPlan(c: FleetCluster, replicas: number): ActionPlan {
  const current = c.controlPlane?.desired;
  const checks: Check[] = [];
  if (c.paused) checks.push({ level: 'block', text: 'The cluster is paused. Resume it first.' });
  if (c.upgrading) checks.push({ level: 'block', text: 'An upgrade is in progress. Let it finish first.' });
  if (current !== undefined && replicas <= current) checks.push({ level: 'block', text: `The control plane already has ${current} nodes.` });
  if (replicas % 2 === 0) checks.push({ level: 'block', text: 'Use an odd number of control-plane nodes (1, 3 or 5), so etcd keeps a majority.' });
  const cpClass = c.machines.find(m => m.role === 'control-plane')?.vm;
  if (current !== undefined && replicas > current) {
    const n = replicas - current;
    checks.push({
      level: 'warn',
      text: `Adds ${n} control-plane VM${n === 1 ? '' : 's'}${
        cpClass?.cpus !== undefined && cpClass.memoryBytes !== undefined
          ? ` (${n * cpClass.cpus} vCPU and ${Math.round((n * cpClass.memoryBytes) / 2 ** 30)} GiB)`
          : ''
      }. Check the Capacity page for quota.`,
    });
    checks.push({ level: 'ok', text: 'New nodes join one at a time; the API stays up throughout.' });
  }
  return {
    id: `${c.key}#cp#${replicas}`,
    title: `Grow the control plane of ${c.name}`,
    summary: `Sets the control plane to ${replicas} nodes${current !== undefined ? ` (now ${current})` : ''}, so the cluster API survives losing a node.`,
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Grow control plane',
    requests: (reason, now) => [
      { method: 'PATCH', path: clusterUrl(c), contentType: JSON_PATCH, body: [{ op: 'add', path: '/spec/topology/controlPlane/replicas', value: replicas }] },
      stampCluster(c, `control plane to ${replicas}`, reason, now),
    ],
  };
}

/** Turns on automatic certificate rotation through the "kubernetes" topology variable. */
export function certRotationPlan(c: FleetCluster, renewalDays = 90): ActionPlan {
  const checks: Check[] = [];
  if (c.paused) checks.push({ level: 'block', text: 'The cluster is paused. Resume it first.' });
  if (c.certificateRotation?.enabled) checks.push({ level: 'block', text: 'Certificate rotation is already on.' });
  if (!c.variableNames) checks.push({ level: 'block', text: "This cluster's topology variables aren't readable." });
  checks.push({ level: 'ok', text: `Control-plane certificates renew automatically ${renewalDays} days before they expire.` });
  checks.push({
    level: 'warn',
    text: "Changing the cluster's Kubernetes settings may roll the control-plane nodes, depending on the class. The dry run shows whether VKS accepts it.",
  });
  const i = c.variableNames?.indexOf('kubernetes') ?? -1;
  const rotation = { enabled: true, renewalDaysBeforeExpiry: renewalDays };
  const ops: unknown[] =
    i >= 0
      ? [
          { op: 'test', path: `/spec/topology/variables/${i}/name`, value: 'kubernetes' },
          c.certificateRotation
            ? { op: 'add', path: `/spec/topology/variables/${i}/value/certificateRotation/enabled`, value: true }
            : { op: 'add', path: `/spec/topology/variables/${i}/value/certificateRotation`, value: rotation },
        ]
      : [{ op: 'add', path: '/spec/topology/variables/-', value: { name: 'kubernetes', value: { certificateRotation: rotation } } }];
  return {
    id: `${c.key}#certrotation`,
    title: `Turn on certificate rotation for ${c.name}`,
    summary: 'Sets certificateRotation.enabled in the cluster\'s "kubernetes" variable.',
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Turn on rotation',
    requests: (reason, now) => [
      { method: 'PATCH', path: clusterUrl(c), contentType: JSON_PATCH, body: ops },
      stampCluster(c, 'certificate rotation on', reason, now),
    ],
  };
}

/* ---------------- VM Service VMs ---------------- */

const MERGE_PATCH = 'application/merge-patch+json';
const vmUrl = (vm: ServiceVm) =>
  `/apis/vmoperator.vmware.com/v1alpha5/namespaces/${encodeURIComponent(vm.namespace)}/virtualmachines/${encodeURIComponent(vm.name)}`;
const vmStamp = (text: string, reason: string, now: Date = new Date()) => ({
  'vks-fleet/last-action': JSON.stringify({ action: text, reason, at: now.toISOString() }),
});

function vmChecks(vm: ServiceVm): Check[] {
  const checks: Check[] = [];
  if (vm.cluster) checks.push({ level: 'block', text: `This VM is a node of cluster ${vm.cluster}; manage it through the cluster (Replace on the machine page).` });
  return checks;
}

export function vmPowerPlan(vm: ServiceVm, state: 'PoweredOn' | 'PoweredOff'): ActionPlan {
  const checks = vmChecks(vm);
  if (vm.power === state) checks.push({ level: 'block', text: `The VM is already ${state === 'PoweredOn' ? 'on' : 'off'}.` });
  if (state === 'PoweredOff') {
    checks.push({ level: 'warn', text: 'Anything the VM serves stops, including load balancers pointing at it.' });
    checks.push({ level: 'ok', text: 'Shuts down through the guest OS when VMware Tools answers (TrySoft), otherwise powers off.' });
  }
  const verb = state === 'PoweredOn' ? 'power on' : 'power off';
  return {
    id: `vm#${vm.namespace}/${vm.name}#${state}`,
    title: `${verb[0].toUpperCase()}${verb.slice(1)} ${vm.name}`,
    summary: `Sets the VM's power state to ${state}; VM Operator does the rest.`,
    checks,
    reasonRequired: state === 'PoweredOff',
    confirmText: state === 'PoweredOff' ? vm.name : undefined,
    applyLabel: verb[0].toUpperCase() + verb.slice(1),
    requests: (reason, now) => [
      { method: 'PATCH', path: vmUrl(vm), contentType: MERGE_PATCH, body: { metadata: { annotations: vmStamp(verb, reason, now) }, spec: { powerState: state } } },
    ],
  };
}

export function vmRestartPlan(vm: ServiceVm): ActionPlan {
  const checks = vmChecks(vm);
  if (vm.power !== 'PoweredOn') checks.push({ level: 'block', text: 'The VM is not powered on.' });
  checks.push({ level: 'warn', text: 'The VM restarts now; anything it serves is briefly unavailable.' });
  return {
    id: `vm#${vm.namespace}/${vm.name}#restart`,
    title: `Restart ${vm.name}`,
    summary: 'Asks VM Operator to restart the VM now (spec.nextRestartTime), through the guest OS when possible.',
    checks,
    reasonRequired: true,
    confirmText: vm.name,
    applyLabel: 'Restart',
    requests: (reason, now) => [
      { method: 'PATCH', path: vmUrl(vm), contentType: MERGE_PATCH, body: { metadata: { annotations: vmStamp('restart', reason, now) }, spec: { nextRestartTime: 'now' } } },
    ],
  };
}

export function vmSnapshotPlan(vm: ServiceVm, name: string): ActionPlan {
  const checks = vmChecks(vm);
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) checks.push({ level: 'block', text: 'Snapshot names use lower-case letters, digits and dashes.' });
  checks.push({ level: 'ok', text: 'A crash-consistent snapshot of the disks (without memory). It counts against the storage quota.' });
  checks.push({ level: 'warn', text: "Snapshots aren't backups, and old ones slow the VM down; delete them when done." });
  return {
    id: `vm#${vm.namespace}/${vm.name}#snapshot`,
    title: `Snapshot ${vm.name}`,
    summary: `Creates VirtualMachineSnapshot ${name}.`,
    checks,
    reasonRequired: true,
    applyLabel: 'Take snapshot',
    requests: reason => [
      {
        method: 'POST',
        path: `/apis/vmoperator.vmware.com/v1alpha5/namespaces/${encodeURIComponent(vm.namespace)}/virtualmachinesnapshots`,
        contentType: 'application/json',
        body: {
          apiVersion: 'vmoperator.vmware.com/v1alpha5',
          kind: 'VirtualMachineSnapshot',
          metadata: { name, namespace: vm.namespace },
          spec: { vmName: vm.name, description: reason },
        },
      },
    ],
  };
}

