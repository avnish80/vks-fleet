/**
 * Operator actions as plain data: what will happen, the checks that decide
 * whether it's safe, and the exact writes to the Supervisor. No Headlamp or
 * React here, so every rule is testable and reviewable on its own.
 *
 * Every action is previewed with a server-side dry run, runs with the
 * signed-in user's identity, and stamps the Cluster with what was done and why.
 */
import { WriteRequest } from './api/client';
import { FleetCluster, MachineInfo, NodePool } from './types';

export const ACTION_ANNOTATION = 'vks-fleet/last-action';
export const SKIP_DRAIN_ANNOTATION = 'machine.cluster.x-k8s.io/exclude-node-draining';
export const SKIP_VOLUME_WAIT_ANNOTATION = 'machine.cluster.x-k8s.io/exclude-wait-for-node-volume-detach';
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

export function replacePlan(c: FleetCluster, m: MachineInfo): ActionPlan {
  const checks: Check[] = [];
  if (m.deletingSince) checks.push({ level: 'block', text: 'This machine is already being deleted.' });
  if (c.paused) checks.push({ level: 'block', text: 'The cluster is paused, so nothing would create the replacement. Resume it first.' });
  if (m.role === 'control-plane') {
    if ((c.controlPlane?.desired ?? 1) <= 1) {
      checks.push({
        level: 'block',
        text: "This is the only control-plane node. Deleting it takes the cluster's API down. Scale the control plane to 3 first.",
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
  const others = c.machines.filter(x => x.name !== m.name && (x.deletingSince || x.ready === false));
  if (others.length) {
    checks.push({
      level: 'warn',
      text: `${others.length} other node${others.length === 1 ? ' is' : 's are'} already unhealthy or being deleted.`,
    });
  }
  if (c.healthCheck && !c.healthCheck.remediationAllowed) {
    checks.push({ level: 'warn', text: 'Automatic repair has stopped on this cluster. Find out why before replacing more nodes.' });
  }
  checks.push({
    level: 'ok',
    text: 'The node is drained, its VM deleted, and a replacement created with the same settings.',
  });
  return {
    id: `${c.key}#replace#${m.name}`,
    title: `Replace node ${nodeLabel(m)}`,
    summary: 'Deletes this machine. Cluster API then builds a new node in its place.',
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Replace node',
    requests: (reason, now) => [
      stampCluster(c, `replaced node ${nodeLabel(m)}`, reason, now),
      { method: 'DELETE', path: machineUrl(c, m) },
    ],
  };
}

/* ---------------- Skip drain on a stuck deletion ---------------- */

export function skipDrainPlan(c: FleetCluster, m: MachineInfo, skipVolumeWait: boolean): ActionPlan {
  const checks: Check[] = [];
  if (!m.deletingSince) {
    checks.push({ level: 'block', text: 'Only for machines that are already being deleted.' });
  }
  checks.push({
    level: 'warn',
    text: 'Pods still on the node are stopped without being evicted, and PodDisruptionBudgets are ignored. Their controllers recreate them elsewhere.',
  });
  if (skipVolumeWait) {
    checks.push({
      level: 'warn',
      text: "Not waiting for volumes to detach risks data corruption if a workload is still writing. Use this only if the volumes are known to be safe.",
    });
  }
  return {
    id: `${c.key}#skipdrain#${m.name}#${skipVolumeWait}`,
    title: `Skip drain for ${nodeLabel(m)}`,
    summary: 'Lets a stuck deletion finish by skipping the node drain. This is a break-glass action.',
    checks,
    reasonRequired: true,
    confirmText: c.name,
    applyLabel: 'Skip drain',
    requests: (reason, now) => {
      const value = stamp('skip drain', reason, now);
      return [
        {
          method: 'PATCH',
          path: machineUrl(c, m),
          contentType: MERGE,
          body: {
            metadata: {
              annotations: {
                [SKIP_DRAIN_ANNOTATION]: value,
                ...(skipVolumeWait ? { [SKIP_VOLUME_WAIT_ANNOTATION]: value } : {}),
              },
            },
          },
        },
        stampCluster(c, `skipped drain for ${nodeLabel(m)}`, reason, now),
      ];
    },
  };
}

/* ---------------- Drain timeout on a node pool ---------------- */

/** Go-style duration like "60s", "5m", "1h30m". Returns seconds, or undefined if invalid. */
export function parseDuration(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text.trim());
  if (!m || text.trim() === '') return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Sets (or clears, with timeout null) how long Cluster API keeps draining a
 * node in this pool before deleting it anyway. Written on the Cluster's
 * topology, which Cluster API passes down to the pool's existing machines,
 * so it also unblocks a deletion that's already stuck in drain.
 */
export function drainTimeoutPlan(c: FleetCluster, pool: NodePool, timeout: string | null): ActionPlan {
  const checks: Check[] = [];
  const seconds = timeout === null ? undefined : parseDuration(timeout);
  if (pool.topologyIndex === undefined) {
    checks.push({ level: 'block', text: "This pool isn't managed through the cluster's topology." });
  }
  if (timeout === null) {
    if (!pool.nodeDrainTimeout) checks.push({ level: 'block', text: 'This pool has no drain timeout to clear.' });
    checks.push({ level: 'ok', text: 'Drains go back to waiting until every pod has been evicted.' });
  } else if (seconds === undefined || seconds < 1) {
    checks.push({ level: 'block', text: 'Enter a duration such as 60s, 5m or 1h.' });
  } else {
    const stuck = c.machines.filter(m => m.pool === pool.name && m.deletingSince);
    checks.push({
      level: 'warn',
      text: `After ${timeout}, pods still on a draining node are stopped without eviction, and PodDisruptionBudgets are ignored.`,
    });
    if (stuck.length) {
      checks.push({
        level: 'ok',
        text: `${stuck.length} machine${stuck.length === 1 ? ' is' : 's are'} stuck deleting in this pool. Their drain stops once the timeout has passed.`,
      });
    }
    checks.push({
      level: 'ok',
      text: 'Once the stuck deletion finishes, clear the timeout again if this pool should normally wait for every pod.',
    });
  }
  const i = pool.topologyIndex ?? -1;
  const base = `/spec/topology/workers/machineDeployments/${i}`;
  const clearing = timeout === null;
  return {
    id: `${c.key}#draintimeout#${pool.name}#${timeout ?? 'clear'}`,
    title: clearing ? `Clear drain timeout on ${pool.name}` : `Set drain timeout on ${pool.name}`,
    summary: clearing
      ? `Removes the drain timeout (${pool.nodeDrainTimeout ?? 'none'}) from node pool ${pool.name}.`
      : `Cluster API stops draining a node in ${pool.name} after ${timeout} and deletes it anyway.`,
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
          clearing
            ? { op: 'remove', path: `${base}/nodeDrainTimeout` }
            : { op: 'add', path: `${base}/nodeDrainTimeout`, value: timeout },
        ],
      },
      stampCluster(c, clearing ? `cleared drain timeout on ${pool.name}` : `set drain timeout ${timeout} on ${pool.name}`, reason, now),
    ],
  };
}
