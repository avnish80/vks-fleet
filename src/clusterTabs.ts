/**
 * The cluster page's tabs. Every section keeps its anchor (issues, checks and
 * other pages link to "#backups", "?focus=<machine>" and so on), so the tab
 * to open follows from the link. Pure, so it can be tested.
 */
export type ClusterTab = 'overview' | 'workloads' | 'nodes' | 'packages' | 'history';

export const CLUSTER_TABS: { id: ClusterTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'workloads', label: 'Workloads' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'packages', label: 'Packages and backups' },
  { id: 'history', label: 'Access and history' },
];

/** Which tab each section (its anchor) is on. */
export const SECTION_TAB: Record<string, ClusterTab> = {
  summary: 'overview',
  anatomy: 'overview',
  checks: 'overview',
  scorecard: 'overview',
  inside: 'workloads',
  utilisation: 'workloads',
  'node-pools': 'nodes',
  machines: 'nodes',
  quota: 'nodes',
  packages: 'packages',
  addons: 'packages',
  backups: 'packages',
  access: 'history',
  troubleshoot: 'history',
  conditions: 'history',
  events: 'history',
  audit: 'history',
  timeline: 'history',
};

/**
 * The tab a link opens: its section's, or, for a link that points at a row
 * (?focus=), the tab that row is on. Undefined when the link names neither,
 * so the tab the reader is on stays.
 */
export function clusterTabOf(search: string, hash: string, rows: { machines: string[]; pools: string[] } = { machines: [], pools: [] }): ClusterTab | undefined {
  const q = new URLSearchParams(search);
  const focus = q.get('focus');
  if (focus === 'certificates') return 'overview';
  if (focus && (rows.machines.includes(focus) || rows.pools.includes(focus))) return 'nodes';
  const section = hash.replace(/^#/, '');
  if (section && SECTION_TAB[section]) return SECTION_TAB[section];
  if (q.get('day')) return 'history';
  const action = q.get('action');
  if (action === 'scale' || action === 'timeouts') return 'nodes';
  return undefined;
}
