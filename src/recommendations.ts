/**
 * Recommendations: the step the plugin suggests for a problem it has no
 * guaranteed fix for. Between "Fix ready" (a guarded action that reliably
 * clears the issue, see fixes.ts) and "Needs a decision" (only the operator
 * can judge it) sits "Recommended": a specific next step that is a planned
 * change, or whose outcome isn't certain.
 *
 * A recommendation never changes anything: it leads to an action that already
 * exists (with its checks and dry run), a page, or a runbook. The same step
 * for many clusters is one recommendation. Pure rules over issues, scorecards
 * and backups, so a future server-side aggregator (and later, automation
 * policies) can reuse the same mapping.
 */
import { FIXABLE_CHECKS, issueFix, issueRule, scoreDrivers } from './fixes';
import { CLEANUP_PATH, clusterDeepLink, MACHINES_PATH, machinePath, PACKAGES_PATH, PREFLIGHT_PATH, SECURITY_ROUTE, SUPERVISOR_HEALTH_ROUTE, UPGRADES_PATH } from './routes';
import { BackupStatus, FleetCluster, Issue, Scorecard } from './types';

/** one-click: an existing action with a dry run. guided: a few steps on a page. window: a planned change that needs a change window. */
export type Effort = 'one-click' | 'guided' | 'window';

export const EFFORT_LABEL: Record<Effort, string> = { 'one-click': 'One click', guided: 'Guided', window: 'Change window' };

type RecKey =
  | 'upgrade'
  | 'cluster-class'
  | 'reconcile-packages'
  | 'update-packages'
  | 'fix-backups'
  | 'install-backups'
  | 'default-storageclass'
  | 'network-policy'
  | 'expand-volume'
  | 'node-capacity'
  | 'replace-node'
  | 'cleanup'
  | 'spread-zones'
  | 'node-repair';

interface Rule {
  /** The step for n clusters (or n items, for Supervisor-level steps). */
  title: (n: number) => string;
  /** The step on an issue's button. */
  label: string;
  why: string;
  effort: Effort;
  /** Best-practice checks this step brings back to passing (their points are the step's effect on the score). */
  checks?: string[];
  /** Where to do it for one cluster; otherwise the fleet page. */
  forCluster?: (c: FleetCluster) => string;
  fleet: string;
  /**
   * Whether "Simulate" counts it as done. An upgrade or a class change is a
   * project with its own planning, so neither is counted.
   */
  simulated: boolean;
}

const clusters = (n: number) => `${n} cluster${n === 1 ? '' : 's'}`;
/** The fleet page's Clusters tab, where every cluster is one row. */
const CLUSTERS_TAB = '/vks-fleet?tab=clusters';

const RULES: Record<RecKey, Rule> = {
  upgrade: {
    title: n => `Upgrade Kubernetes on ${clusters(n)}`,
    label: 'Plan the upgrade',
    why: 'A version behind the newest release misses fixes, and the gap grows with every release. The planner orders clusters in waves and runs a pre-flight first.',
    effort: 'window',
    checks: ['version'],
    fleet: UPGRADES_PATH,
    simulated: false,
  },
  'cluster-class': {
    title: n => `Move ${clusters(n)} to the current cluster class`,
    label: 'Plan the class change',
    why: 'An older cluster class misses the defaults and fixes of the current one. It changes with the next upgrade, or on its own from the planner.',
    effort: 'window',
    checks: ['class'],
    fleet: UPGRADES_PATH,
    simulated: false,
  },
  'reconcile-packages': {
    title: n => `Re-reconcile failing packages on ${clusters(n)}`,
    label: 'Re-reconcile',
    why: 'A package that failed once often succeeds on a fresh reconcile, once what it waited for is there. If it fails again, its runbook has the next steps.',
    effort: 'one-click',
    checks: ['packages-ok'],
    forCluster: c => clusterDeepLink(c, { hash: 'packages' }),
    fleet: PACKAGES_PATH,
    simulated: true,
  },
  'update-packages': {
    title: n => `Update packages on ${clusters(n)}`,
    label: 'Update packages',
    why: 'Newer versions of installed packages are available in the cluster\'s repository.',
    effort: 'guided',
    checks: ['packages-current'],
    forCluster: c => clusterDeepLink(c, { hash: 'packages' }),
    fleet: PACKAGES_PATH,
    simulated: true,
  },
  'fix-backups': {
    title: n => `Get backups running again on ${clusters(n)}`,
    label: 'Open backups',
    why: 'The latest backup failed, or none has succeeded within the window your baseline sets. Until one does, a restore would lose that time.',
    effort: 'guided',
    forCluster: c => clusterDeepLink(c, { hash: 'backups' }),
    fleet: CLUSTERS_TAB,
    simulated: true,
  },
  'install-backups': {
    title: n => `Install Velero and schedule backups on ${clusters(n)}`,
    label: 'Install Velero',
    why: 'These clusters have no backup tool, so nothing in them can be restored. Velero is a standard package; a schedule takes a few minutes to add.',
    effort: 'guided',
    forCluster: c => clusterDeepLink(c, { hash: 'packages' }),
    fleet: PACKAGES_PATH,
    simulated: true,
  },
  'default-storageclass': {
    title: n => `Set a default StorageClass on ${clusters(n)}`,
    label: 'Set a default',
    why: 'Without a default, a volume claim that names no class stays Pending, which surprises Helm charts and operators.',
    effort: 'guided',
    forCluster: c => clusterDeepLink(c, { hash: 'inside' }),
    fleet: CLUSTERS_TAB,
    simulated: true,
  },
  'network-policy': {
    title: n => `Add a default-deny network policy on ${clusters(n)}`,
    label: 'Add a policy',
    why: 'Namespaces without a network policy accept traffic from every pod in the cluster. A default-deny policy (applied after a dry run) makes each allowed path explicit.',
    effort: 'guided',
    fleet: SECURITY_ROUTE,
    simulated: true,
  },
  'expand-volume': {
    title: n => `Expand volumes that are filling up on ${clusters(n)}`,
    label: 'Open the forecast',
    why: 'At the rate of the last hours these volumes fill up within the forecast window, and the workloads writing to them stop when they do.',
    effort: 'window',
    forCluster: c => `/vks-fleet/observability?cluster=${encodeURIComponent(c.key)}`,
    fleet: '/vks-fleet/observability',
    simulated: true,
  },
  'node-capacity': {
    title: n => `Add node capacity on ${clusters(n)}`,
    label: 'Run a pre-flight',
    why: 'Nodes are near their limit, or forecast to run out. Scaling the pool out, or moving it to a larger VM class, gives the room back; the pre-flight shows what either would do first.',
    effort: 'window',
    fleet: PREFLIGHT_PATH,
    simulated: true,
  },
  'replace-node': {
    title: n => `Replace nodes whose disk is filling up on ${clusters(n)}`,
    label: 'Replace the node',
    why: 'Images, logs or emptyDir volumes are filling the node\'s disk; when it is full the kubelet starts evicting pods. A replaced node starts with a clean disk, and the action drains the old one first.',
    effort: 'one-click',
    forCluster: c => clusterDeepLink(c, { hash: 'machines' }),
    fleet: MACHINES_PATH,
    simulated: true,
  },
  cleanup: {
    title: n => `Clean up ${n} set${n === 1 ? '' : 's'} of leftovers`,
    label: 'Clean up',
    why: 'Objects left behind by deleted clusters and failed service pods hold quota and addresses, and clutter every list. Each clean-up runs as a dry run first.',
    effort: 'one-click',
    fleet: CLEANUP_PATH,
    simulated: true,
  },
  'spread-zones': {
    title: n => `Spread node pools across zones on ${clusters(n)}`,
    label: 'Open node pools',
    why: 'The Supervisor has several zones, but these clusters run in one, so a zone outage takes them down whole.',
    effort: 'window',
    checks: ['zones'],
    forCluster: c => clusterDeepLink(c, { hash: 'node-pools' }),
    fleet: CLUSTERS_TAB,
    simulated: true,
  },
  'node-repair': {
    title: n => `Turn on automatic node repair on ${clusters(n)}`,
    label: 'Open the cluster',
    why: 'Without a machine health check that is allowed to act, a node that stops answering stays broken until someone replaces it by hand.',
    effort: 'guided',
    checks: ['health-check'],
    forCluster: c => clusterDeepLink(c, { hash: 'checks' }),
    fleet: CLUSTERS_TAB,
    simulated: true,
  },
};

/** Leftover Supervisor service pods are cleaned up from Supervisor health; everything else from Cleanup. */
const serviceLeftovers = (issueId: string) => /^(svc|service)-leftovers$/.test(issueRule(issueId));

/** Which recommendation an open issue belongs to, by its rule. */
function keyForIssue(issue: Issue): RecKey | undefined {
  const rule = issueRule(issue.id);
  if (rule === 'behind') return 'upgrade';
  if (rule === 'packages') return 'reconcile-packages';
  if (rule === 'backup-failed' || rule === 'backup-stale') return 'fix-backups';
  if (rule === 'scan#storage-default') return 'default-storageclass';
  if (rule.startsWith('scan#sec-netpol')) return 'network-policy';
  if (rule.startsWith('forecast#volume')) return 'expand-volume';
  if (rule.startsWith('forecast#node disk#')) return 'replace-node';
  if (rule.startsWith('forecast#node memory#') || rule.startsWith('hot-')) return 'node-capacity';
  if (rule === 'cleanup' || rule.startsWith('cleanup-cluster-') || rule === 'svc-leftovers' || rule === 'service-leftovers') return 'cleanup';
  return undefined;
}

export interface IssueRecommendation {
  key: string;
  /** The step, as a button label. */
  label: string;
  path: string;
  effort: Effort;
  why: string;
  /** Whether "Simulate" counts it as done. */
  simulated: boolean;
}

/**
 * The recommended step for one issue, when the plugin has no guaranteed fix
 * for it (a fix always comes first) and it isn't only for information.
 */
export function issueRecommendation(issue: Issue, cluster?: FleetCluster): IssueRecommendation | undefined {
  if (issue.severity === 'info' || issueFix(issue, cluster)) return undefined;
  const key = keyForIssue(issue);
  if (!key) return undefined;
  const rule = RULES[key];
  // A node's own page, when the forecast names a node this cluster still has.
  const node = key === 'replace-node' ? issueRule(issue.id).slice('forecast#node disk#'.length) : undefined;
  const machine = node ? cluster?.machines.find(m => m.nodeName === node || m.name === node) : undefined;
  const path = machine && cluster ? machinePath(cluster, machine.name) : key === 'cleanup' && serviceLeftovers(issue.id) ? SUPERVISOR_HEALTH_ROUTE : cluster && rule.forCluster ? rule.forCluster(cluster) : rule.fleet;
  return { key, label: rule.label, path, effort: rule.effort, why: rule.why, simulated: rule.simulated };
}

export interface Recommendation {
  key: string;
  title: string;
  why: string;
  effort: Effort;
  /** Where to do it: the cluster's own page when there is one cluster, otherwise the fleet page. */
  path: string;
  /** The clusters it applies to, with where to do it for each. */
  clusters: Array<{ key: string; name: string; path: string }>;
  /** Open issues it would clear. */
  issueIds: string[];
  /** Whether one of them is critical, or about something running out. */
  urgent: boolean;
  /** Points of the fleet score it would bring back (0 when it touches no best-practice check). */
  points: number;
  /** Whether "Simulate" counts it as done. */
  simulated: boolean;
}

export interface RecommendationsInput {
  /** Open issues (silenced ones left out). */
  issues: Issue[];
  clusters: Map<string, FleetCluster>;
  /** Every cluster's scorecard. */
  cards: Scorecard[];
  /** Backups per cluster, for clusters signed in to. */
  backups?: Map<string, BackupStatus>;
  /** Display name for a cluster (shortened when names share a prefix). */
  short?: (name: string) => string;
}

const EFFORT_RANK: Record<Effort, number> = { 'one-click': 0, guided: 1, window: 2 };

/**
 * The fleet's recommendations, the ones to do first on top: anything urgent,
 * then by score points and issues cleared, the cheaper step first on a tie.
 */
export function recommendations(input: RecommendationsInput): Recommendation[] {
  const short = input.short ?? ((n: string) => n);
  const drivers = scoreDrivers(input.cards);
  type Draft = { clusterKeys: Set<string>; issueIds: string[]; urgent: boolean; items: number };
  const drafts = new Map<RecKey, Draft>();
  const draft = (key: RecKey) => {
    if (!drafts.has(key)) drafts.set(key, { clusterKeys: new Set(), issueIds: [], urgent: false, items: 0 });
    return drafts.get(key)!;
  };

  for (const issue of input.issues) {
    const cluster = issue.clusterKey ? input.clusters.get(issue.clusterKey) : undefined;
    const rec = issueRecommendation(issue, cluster);
    if (!rec) continue;
    const d = draft(rec.key as RecKey);
    d.issueIds.push(issue.id);
    d.items += 1;
    if (cluster) d.clusterKeys.add(cluster.key);
    if (issue.severity === 'critical' || issueRule(issue.id).startsWith('forecast#')) d.urgent = true;
  }
  // Best-practice checks that aren't passing and have a step (but no one-click fix): they cost score points.
  for (const [key, rule] of Object.entries(RULES) as Array<[RecKey, Rule]>) {
    for (const check of rule.checks ?? []) {
      if (FIXABLE_CHECKS[check]) continue;
      const driver = drivers.find(d => d.id === check);
      for (const k of driver?.clusterKeys ?? []) if (input.clusters.has(k)) draft(key).clusterKeys.add(k);
    }
  }
  // No backup tool at all raises no issue (nothing failed), but it is the first thing to put right.
  for (const [k, b] of input.backups ?? []) if (b.missing && input.clusters.has(k)) draft('install-backups').clusterKeys.add(k);

  const out: Recommendation[] = [];
  for (const [key, d] of drafts) {
    const rule = RULES[key];
    const list = Array.from(d.clusterKeys)
      .map(k => input.clusters.get(k)!)
      .map(c => ({ key: c.key, name: short(c.name), path: rule.forCluster ? rule.forCluster(c) : rule.fleet }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const n = list.length || d.items;
    if (!n) continue;
    const points = (rule.checks ?? []).filter(c => !FIXABLE_CHECKS[c]).reduce((sum, c) => sum + (drivers.find(x => x.id === c)?.points ?? 0), 0);
    out.push({
      key,
      title: rule.title(n),
      why: rule.why,
      effort: rule.effort,
      path: list.length === 1 ? list[0].path : key === 'cleanup' && d.issueIds.every(serviceLeftovers) ? SUPERVISOR_HEALTH_ROUTE : rule.fleet,
      clusters: list,
      issueIds: d.issueIds,
      urgent: d.urgent,
      points: Math.round(points * 10) / 10,
      simulated: rule.simulated,
    });
  }
  return out.sort(
    (a, b) => Number(b.urgent) - Number(a.urgent) || b.points - a.points || b.issueIds.length - a.issueIds.length || EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] || a.title.localeCompare(b.title)
  );
}

/** "clears 3 issues in 2 clusters · +4 points": what a recommendation would do, in a line. */
export function effectText(r: Recommendation): string {
  const parts: string[] = [];
  if (r.issueIds.length) parts.push(`clears ${r.issueIds.length} issue${r.issueIds.length === 1 ? '' : 's'}`);
  if (r.points > 0) parts.push(`+${r.points} point${r.points === 1 ? '' : 's'}`);
  if (!parts.length) parts.push('no open issue: a gap to close');
  return parts.join(' · ');
}

/** The best-practice checks the simulated recommendations bring back to passing. */
export function recommendedChecks(recs: Recommendation[]): Set<string> {
  const out = new Set<string>();
  for (const r of recs) if (r.simulated) for (const c of RULES[r.key as RecKey].checks ?? []) out.add(c);
  return out;
}

/** The recommended step for each open issue that has one, by issue id. */
export function recommendationsByIssue(issues: Issue[], clusters: Map<string, FleetCluster>): Map<string, IssueRecommendation> {
  const out = new Map<string, IssueRecommendation>();
  for (const i of issues) {
    const rec = issueRecommendation(i, i.clusterKey ? clusters.get(i.clusterKey) : undefined);
    if (rec) out.set(i.id, rec);
  }
  return out;
}

export interface TriageCounts {
  /** Open issues that need action (critical and warning). */
  open: number;
  fixable: number;
  recommended: number;
  /** The rest: only the operator can judge them. */
  decision: number;
}

/** How the open issues split: a fix is ready, a step is recommended, or it needs a decision. */
export function triage(issues: Issue[], clusters: Map<string, FleetCluster>): TriageCounts {
  const open = issues.filter(i => i.severity !== 'info');
  const fixable = open.filter(i => issueFix(i, i.clusterKey ? clusters.get(i.clusterKey) : undefined)).length;
  const recommended = recommendationsByIssue(open, clusters).size;
  return { open: open.length, fixable, recommended, decision: open.length - fixable - recommended };
}
