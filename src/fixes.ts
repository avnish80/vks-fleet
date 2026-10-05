/**
 * Fix proposals: which problems the plugin can already fix through one of its
 * own guarded actions (checks, a server-side dry run, a confirmation), and what
 * the fleet would look like once those were applied.
 *
 * Nothing here changes anything: "simulate" only recomputes the picture. Pure
 * rules over issues and scorecards, so a future server-side aggregator (and
 * later, automation policies) can reuse the same mapping.
 */
import { BASELINE_PATH, clusterDeepLink, clusterPath, machinePath, SECURITY_ROUTE } from './routes';
import { FleetCluster, Issue, Scorecard, Severity } from './types';

export interface FixProposal {
  /** What the fix does, as a button label ("Replace the node"). */
  label: string;
  /** The page or dialog where the action is applied. */
  path: string;
}

/** The rule part of an issue id ("<supervisor>/<ns>/<cluster>#stuck-np-1" → "stuck-np-1"). */
export function issueRule(id: string): string {
  const at = id.indexOf('#');
  return at < 0 ? id : id.slice(at + 1);
}

/**
 * The fix the plugin has for an issue, if any. Only actions that exist today
 * and reliably clear the issue count: an upgrade is a planned change and a
 * package re-reconcile may not help, so neither is offered as a fix.
 */
export function issueFix(issue: Issue, cluster?: FleetCluster): FixProposal | undefined {
  if (!cluster) return undefined;
  const rule = issueRule(issue.id);
  if (rule.startsWith('stuck-node-')) return undefined;
  if (rule.startsWith('stuck-')) return { label: 'Unblock or replace the node', path: machinePath(cluster, rule.slice('stuck-'.length)) };
  if (rule.startsWith('vm-off-')) return { label: 'Replace the node', path: machinePath(cluster, rule.slice('vm-off-'.length)) };
  if (rule === 'paused') return { label: 'Resume the cluster', path: clusterDeepLink(cluster, { hash: 'summary', action: 'resume' }) };
  if (rule.startsWith('timeouts-')) {
    const pool = rule.slice('timeouts-'.length);
    return { label: 'Clear the leftover timeouts', path: clusterDeepLink(cluster, { hash: 'node-pools', focus: pool, action: 'timeouts', pool }) };
  }
  if (rule === 'certs' && cluster.certificateRotation?.enabled !== true) return { label: 'Turn on certificate rotation', path: BASELINE_PATH };
  if (rule === 'single-cp') return { label: 'Scale the control plane to 3', path: BASELINE_PATH };
  if (rule.startsWith('scan#sec-psa')) return { label: 'Set a Pod Security level', path: issue.primary?.path ?? SECURITY_ROUTE };
  return undefined;
}

/** Scorecard checks an existing action brings back to passing, with the action's name. */
export const FIXABLE_CHECKS: Record<string, string> = {
  'cp-ha': 'Scale the control plane to 3',
  certs: 'Turn on certificate rotation',
  'not-paused': 'Resume the cluster',
  timeouts: 'Clear the leftover timeouts',
  'pool-size': 'Scale single-node pools to 2',
};

const earned = (status: string) => (status === 'pass' ? 1 : status === 'warn' ? 0.5 : 0);

/** A cluster's score with every fixable check passing. Same arithmetic as the scorecard. */
export function simulatedScore(card: Scorecard): number {
  const evaluated = card.checks.filter(x => x.status !== 'unknown');
  const all = evaluated.reduce((n, x) => n + x.weight, 0);
  if (!all) return card.score;
  const got = evaluated.reduce((n, x) => n + x.weight * (FIXABLE_CHECKS[x.id] ? 1 : earned(x.status)), 0);
  return Math.round((got / all) * 100);
}

/** The fleet score: the average of the clusters' scores, as shown or with fixes simulated. */
export function fleetScore(cards: Scorecard[], simulate = false): number | undefined {
  if (!cards.length) return undefined;
  return Math.round(cards.reduce((n, c) => n + (simulate ? simulatedScore(c) : c.score), 0) / cards.length);
}

export interface ScoreDriver {
  /** Check id. */
  id: string;
  title: string;
  /** Points of the fleet score this check costs (the drivers add up to 100 minus the score, before rounding). */
  points: number;
  /** Clusters where it isn't passing. */
  clusters: number;
  /** Their keys, to link to each one's checks. */
  clusterKeys: string[];
  /** The action that fixes it, when the plugin has one. */
  fix?: string;
}

/** What holds the fleet score down: each check's cost in points, largest first. */
export function scoreDrivers(cards: Scorecard[]): ScoreDriver[] {
  const by = new Map<string, ScoreDriver>();
  for (const card of cards) {
    const evaluated = card.checks.filter(x => x.status !== 'unknown');
    const all = evaluated.reduce((n, x) => n + x.weight, 0);
    if (!all) continue;
    for (const x of evaluated) {
      const lost = x.weight * (1 - earned(x.status));
      if (!lost) continue;
      const d = by.get(x.id) ?? { id: x.id, title: x.title, points: 0, clusters: 0, clusterKeys: [], fix: FIXABLE_CHECKS[x.id] };
      d.points += ((lost / all) * 100) / cards.length;
      d.clusters += 1;
      d.clusterKeys.push(card.clusterKey);
      by.set(x.id, d);
    }
  }
  return Array.from(by.values())
    .map(d => ({ ...d, points: Math.round(d.points * 10) / 10 }))
    .filter(d => d.points > 0)
    .sort((a, b) => b.points - a.points || a.title.localeCompare(b.title));
}

/* ---------------- The cluster wall ---------------- */

/**
 * critical: a critical issue. warning: needs attention (an operational warning, or the Supervisor
 * doesn't report the cluster healthy). advisory: only posture and hygiene findings are open.
 */
export type TileState = 'critical' | 'warning' | 'advisory' | 'healthy' | 'fixed';
export type TileIcon = 'storage' | 'memory' | 'network' | 'node' | 'certificate' | 'lifecycle' | 'security' | 'alert' | 'ok';

export interface WallTile {
  key: string;
  name: string;
  fullName: string;
  tenantId: string;
  tenantName: string;
  state: TileState;
  icon: TileIcon;
  /** The worst open issue, or "Healthy". */
  line1: string;
  /** The fix that is ready, or what the cluster runs. */
  line2: string;
  /** Other open issues besides the one named. */
  more: number;
  path: string;
}

export function iconFor(issue: Issue): TileIcon {
  const rule = issueRule(issue.id);
  if (/^(pvc|attach-|scan#storage|backup)/.test(rule) || rule.includes('forecast') || rule.includes('org-quota')) return 'storage';
  if (/^hot-/.test(rule) || rule.includes('limits#mem')) return 'memory';
  if (/^(net-|lb$|dns$)/.test(rule)) return 'network';
  if (rule === 'certs' || rule.includes('sec-cert')) return 'certificate';
  if (/^(stuck-|vm-off-|repair-stopped|mhc-|single-cp|one-zone|unreachable|signin|pods$)/.test(rule)) return 'node';
  if (/^(behind|upgrade|class|packages|paused|timeouts-)/.test(rule)) return 'lifecycle';
  if (rule.startsWith('scan#sec-') || rule.includes('compliance') || rule.includes('vuln')) return 'security';
  return 'alert';
}

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

const ADVISORY = /^(scan#sec-|scan#storage-default|policy#|vulns#|deprecated-apis$|behind$|upgrade$|class$|single-cp$|one-zone$|timeouts-)/;

/**
 * Posture and hygiene: worth fixing, but nothing is failing or running out (a missing Pod Security
 * level, an older version, a single control plane, scanner and compliance findings). These don't
 * make a cluster "need attention" on their own.
 */
export function isAdvisory(issue: Issue): boolean {
  if (issue.severity !== 'warning') return false;
  const rule = issueRule(issue.id);
  return ADVISORY.test(rule) || rule.includes('compliance');
}

/** Sort key: critical, then warnings that need attention, then advisories. */
const urgency = (i: Issue) => RANK[i.severity] * 2 + (isAdvisory(i) ? 1 : 0);

/** An issue title without the cluster's own name in it: the tile already carries the name. */
export function tileTitle(title: string, clusterName: string): string {
  let t = title.split(` in ${clusterName}`).join('');
  while (t.includes(`${clusterName}-`)) t = t.split(`${clusterName}-`).join('');
  return t.trim();
}

/**
 * One tile per cluster: its worst open issue and whether a fix is ready. With
 * `simulate`, issues that have a fix are taken as fixed, so a tile shows what
 * would be left.
 */
export function wallTiles(clusters: FleetCluster[], issues: Issue[], simulate = false, short: (name: string) => string = n => n): WallTile[] {
  const byCluster = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.clusterKey || i.severity === 'info') continue;
    byCluster.set(i.clusterKey, [...(byCluster.get(i.clusterKey) ?? []), i]);
  }
  return clusters.map(c => {
    const open = (byCluster.get(c.key) ?? []).slice().sort((a, b) => urgency(a) - urgency(b));
    const left = simulate ? open.filter(i => !issueFix(i, c)) : open;
    const top = left[0];
    const base = { key: c.key, name: short(c.name), fullName: c.name, tenantId: c.tenantId, tenantName: c.tenantName, path: clusterPath(c) };
    const nodes = c.machines.length;
    const runs = [c.kubernetesVersion, nodes ? `${nodes} node${nodes === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ');
    // The Supervisor's own view counts too: a degraded cluster needs attention even with no issue listed.
    const unwell = c.health !== 'healthy';
    if (!top) {
      const fixed = simulate && open.length > 0;
      return {
        ...base,
        state: unwell ? ('warning' as const) : fixed ? ('fixed' as const) : ('healthy' as const),
        icon: unwell ? ('alert' as const) : ('ok' as const),
        line1: unwell ? `Reported ${c.health}` : fixed ? 'Fixed in simulation' : 'Healthy',
        line2: fixed ? `${open.length} fix${open.length === 1 ? '' : 'es'} applied` : runs,
        more: 0,
      };
    }
    const fix = issueFix(top, c);
    return {
      ...base,
      state: top.severity === 'critical' ? ('critical' as const) : unwell || !isAdvisory(top) ? ('warning' as const) : ('advisory' as const),
      icon: iconFor(top),
      line1: tileTitle(top.title, c.name),
      line2: fix ? `Fix ready: ${fix.label}` : 'Needs a decision',
      more: left.length - 1,
    };
  });
}

/** Clusters that need attention: a critical tile or a warning tile. Advisory-only clusters don't count. */
export function attentionCount(tiles: WallTile[]): number {
  return tiles.filter(t => t.state === 'critical' || t.state === 'warning').length;
}

/** The same count per org (tenant id). */
export function attentionByTenant(tiles: WallTile[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tiles) out.set(t.tenantId, (out.get(t.tenantId) ?? 0) + (t.state === 'critical' || t.state === 'warning' ? 1 : 0));
  return out;
}

/** The fix the plugin has for each open issue, by issue id. */
export function fixesByIssue(issues: Issue[], clusters: Map<string, FleetCluster>): Map<string, FixProposal> {
  const out = new Map<string, FixProposal>();
  for (const i of issues) {
    if (i.severity === 'info') continue;
    const fix = issueFix(i, i.clusterKey ? clusters.get(i.clusterKey) : undefined);
    if (fix) out.set(i.id, fix);
  }
  return out;
}

export interface FixCounts {
  /** Open issues that need action (critical and warning). */
  open: number;
  /** Of those, how many the plugin has a fix for. */
  fixable: number;
}

export function fixCounts(issues: Issue[], clusters: Map<string, FleetCluster>): FixCounts {
  return { open: issues.filter(i => i.severity !== 'info').length, fixable: fixesByIssue(issues, clusters).size };
}
