/**
 * Upgrade planner: which clusters can move to which version, how ready each
 * is (the same checks as the single-cluster upgrade, plus headroom for the
 * rolling upgrade), and waves: a canary first, then the rest, each wave
 * starting only when the previous one has finished healthy.
 */
import { blocked, Check, upgradePlan, upgradeProgress } from './actions';
import { fits, quotaLines, upgradeSurge } from './headroom';
import { formatBytes } from './quantity';
import { upgradeTargets } from './releases';
import { Configured, NamespaceLimits, overcommit } from './limits';
import { FleetCluster, VmClassInfo } from './types';

export interface PlanEntry {
  /** 1-based wave; 0 means not in the plan. */
  wave: number;
  target: string;
  moveClass: boolean;
}

export interface Readiness {
  level: 'ready' | 'warnings' | 'blocked' | 'nothing';
  checks: Check[];
}

export function readiness(
  c: FleetCluster,
  entry: PlanEntry | undefined,
  available: string[],
  classes: VmClassInfo[],
  blockingPdbs?: string[],
  limits?: NamespaceLimits,
  configured?: Configured
): Readiness {
  if (!entry || !entry.target) {
    return { level: 'nothing', checks: [{ level: 'ok', text: 'No newer release to move to.' }] };
  }
  const plan = upgradePlan(c, entry.target, entry.moveClass && c.classUpdate ? c.classUpdate : null, {
    available,
    blockingPdbs,
    pdbCheck: blockingPdbs ? undefined : 'sign in to the cluster to check them.',
  });
  const checks = [...plan.checks];
  const surge = upgradeSurge(c, classes);
  const lines = quotaLines(c.quota);
  if (lines.length && (surge.cpus || surge.memoryBytes)) {
    const tight = fits(lines, surge).filter(f => !f.fits);
    checks.push(
      tight.length
        ? {
            level: 'warn',
            text: `The rolling upgrade needs about ${surge.cpus} vCPU and ${formatBytes(surge.memoryBytes)} more while it runs; quota ${tight
              .map(t => t.resource)
              .join(', ')} ${tight.length === 1 ? "doesn't" : "don't"} have that free.`,
          }
        : { level: 'ok', text: `Quota has room for the upgrade's extra ${surge.cpus} vCPU and ${formatBytes(surge.memoryBytes)}.` }
    );
  }
  if (limits?.memoryLimitBytes && configured && surge.memoryBytes) {
    const during = overcommit(configured.memoryBytes + surge.memoryBytes, limits.memoryLimitBytes)!;
    checks.push(
      during > 4
        ? {
            level: 'warn',
            text: `While it runs, memory in ${c.namespace} is ${during.toFixed(1)}× the namespace limit (${formatBytes(limits.memoryLimitBytes)}); new nodes may start slowly under load.`,
          }
        : { level: 'ok', text: `Memory stays within ${during.toFixed(1)}× the namespace limit while it runs.` }
    );
  }
  return {
    level: blocked(plan) ? 'blocked' : checks.some(x => x.level === 'warn') ? 'warnings' : 'ready',
    checks,
  };
}

/** Default target: the next minor if offered, else the newest patch. */
export function defaultTarget(c: FleetCluster, available: string[]): string {
  return upgradeTargets(c.kubernetesVersion, available)[0] ?? '';
}

/**
 * Suggested waves: the smallest upgradable cluster first as a canary, then
 * the rest. Clusters with nothing to upgrade to stay out of the plan.
 */
export function suggestWaves(clusters: FleetCluster[], availableFor: (c: FleetCluster) => string[]): Map<string, PlanEntry> {
  const plan = new Map<string, PlanEntry>();
  const candidates = clusters
    .map(c => ({ c, target: defaultTarget(c, availableFor(c)) }))
    .filter(x => x.target)
    .sort((a, b) => a.c.machines.length - b.c.machines.length || a.c.name.localeCompare(b.c.name));
  candidates.forEach((x, i) => plan.set(x.c.key, { wave: i === 0 ? 1 : 2, target: x.target, moveClass: false }));
  for (const c of clusters) if (!plan.has(c.key)) plan.set(c.key, { wave: 0, target: '', moveClass: false });
  return plan;
}

export type ClusterRunState = 'waiting' | 'upgrading' | 'done' | 'failed';

/** Where one cluster is against its planned target. */
export function runState(c: FleetCluster, target: string): ClusterRunState {
  const onTarget = (c.kubernetesVersion ?? '').replace(/^v/, '') === target.replace(/^v/, '');
  if (!onTarget) return 'waiting';
  const p = upgradeProgress(c);
  const rolled = !!p && p.controlPlane.updated === p.controlPlane.total && p.pools.every(x => x.updated === x.total);
  if (c.health === 'failed') return 'failed';
  if (c.upgrading || !rolled) return 'upgrading';
  return c.health === 'healthy' ? 'done' : 'upgrading';
}

export type WaveState = 'empty' | 'not-started' | 'running' | 'done' | 'failed';

export function waveState(members: Array<{ c: FleetCluster; entry: PlanEntry }>): WaveState {
  if (!members.length) return 'empty';
  const states = members.map(m => runState(m.c, m.entry.target));
  if (states.some(s => s === 'failed')) return 'failed';
  if (states.every(s => s === 'done')) return 'done';
  if (states.every(s => s === 'waiting')) return 'not-started';
  return 'running';
}

/** A wave may start when every earlier non-empty wave is done. */
export function canStart(wave: number, states: Map<number, WaveState>): { ok: boolean; reason?: string } {
  for (let w = 1; w < wave; w++) {
    const s = states.get(w);
    if (s && s !== 'empty' && s !== 'done') {
      return { ok: false, reason: `Wave ${w} hasn't finished healthy yet (${s.replace('-', ' ')}).` };
    }
  }
  return { ok: true };
}
