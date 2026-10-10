/**
 * The fleet dashboard: one number, one status and one line of reason per
 * block, each opening the page that owns the detail. The blocks only
 * summarise what those pages already compute; nothing is counted twice with
 * different rules.
 *
 * Pure functions over plain data, so they can be tested and reused.
 */
import { ScoreDriver, WallTile, iconFor, tileTitle } from './fixes';
import { HorizonItem, inWords, NowItem } from './fleetHero';
import { BASELINE_PATH, CAPACITY_PATH, FLEET_PATH, NETWORK_PATH, PACKAGES_PATH, SECURITY_ROUTE, SUPERVISOR_HEALTH_ROUTE, UPGRADES_PATH } from './routes';
import { Issue } from './types';

export type FleetTab = 'dashboard' | 'clusters' | 'issues';

/** The fleet page on one of its tabs (the dashboard is the page itself). */
export function fleetTabPath(tab: FleetTab, hash?: string): string {
  return `${FLEET_PATH}${tab === 'dashboard' ? '' : `?tab=${tab}`}${hash ? `#${hash}` : ''}`;
}

/**
 * Which tab a fleet-page address opens: `?tab=` when given; otherwise links
 * that filter clusters or point at a section (older links, bookmarks) still
 * land where that section now lives.
 */
export function tabFromLocation(search: string, hash: string): FleetTab {
  const p = new URLSearchParams(search);
  const tab = p.get('tab');
  if (tab === 'clusters' || tab === 'issues') return tab;
  if (tab === 'dashboard') return 'dashboard';
  if (hash === '#issues' || hash === '#next-30-days') return 'issues';
  if (hash === '#clusters' || hash === '#scorecard') return 'clusters';
  if (['health', 'version', 'attention', 'upgradable'].some(k => p.has(k))) return 'clusters';
  return 'dashboard';
}

/** ok: nothing to do. warn: worth a look. bad: something is failing or about to. none: no judgement (or no data). */
export type BlockTone = 'ok' | 'warn' | 'bad' | 'none';

export interface DashboardBlock {
  id: 'clusters' | 'supervisor' | 'capacity' | 'next30' | 'lifecycle' | 'security' | 'governance' | 'network';
  label: string;
  /** The headline figure, as shown. */
  value: string;
  /** Small text after the figure ("of 12", "vCPU"). */
  unit?: string;
  tone: BlockTone;
  /** One line: why the figure is what it is. */
  reason: string;
  /** The page that owns the detail. */
  path: string;
  /** The figure as a number, for the history (absent when there is none). */
  n?: number;
}

export interface BlocksInput {
  /** One tile per cluster, as the wall shows them (not simulated). */
  tiles: WallTile[];
  supervisor: {
    /** False when this account can't read the Supervisor's own health (a tenant). */
    visible: boolean;
    /** The lowest Supervisor score; undefined while loading. */
    score?: number;
    /** Controllers whose lease stopped renewing. */
    staleControllers: number;
  };
  capacity: {
    /** The node closest to full, when utilisation can be read. */
    busiest?: { cluster: string; node: string; pct: number; what: 'memory' | 'CPU' };
    cpus: number;
    /** Node memory, already formatted ("104 GiB"). */
    memoryText: string;
  };
  /** What expires or runs out in the next 30 days, soonest first. */
  horizon: HorizonItem[];
  now: number;
  lifecycle: {
    /** Packages failing to reconcile; undefined when no cluster is signed in. */
    failing?: number;
    /** Packages at different versions across clusters. */
    drift?: number;
    upgrading: number;
    upgradable: number;
  };
  /** Open issues (silenced ones left out). */
  issues: Issue[];
  governance: {
    /** Average match against the baseline, when one is set. */
    baselinePct?: number;
    /** Clusters whose backups could be read, and how many of those have a successful one. */
    backupsKnown: number;
    backedUp: number;
  };
  /** The fullest subnet, when the network inventory is loaded. */
  subnet?: { name: string; pct: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const scoreTone = (s: number): BlockTone => (s >= 90 ? 'ok' : s >= 70 ? 'warn' : 'bad');

function clustersBlock(tiles: WallTile[]): DashboardBlock {
  const critical = tiles.filter(t => t.state === 'critical').length;
  const attention = critical + tiles.filter(t => t.state === 'warning').length;
  const advisory = tiles.filter(t => t.state === 'advisory').length;
  return {
    id: 'clusters',
    label: 'Clusters',
    value: String(attention),
    unit: `of ${tiles.length}`,
    tone: critical ? 'bad' : attention ? 'warn' : 'ok',
    reason: !tiles.length ? 'No clusters yet' : attention ? `need${attention === 1 ? 's' : ''} attention${critical ? `, ${critical} critical` : ''}` : advisory ? `need attention; ${advisory} advisory only` : 'need attention',
    path: fleetTabPath('clusters'),
    n: attention,
  };
}

function supervisorBlock(s: BlocksInput['supervisor']): DashboardBlock {
  const base = { id: 'supervisor' as const, label: 'Supervisor', path: SUPERVISOR_HEALTH_ROUTE };
  if (!s.visible) return { ...base, value: '—', tone: 'none', reason: 'Not visible to this account' };
  if (s.score === undefined) return { ...base, value: '…', tone: 'none', reason: 'Reading its health' };
  return {
    ...base,
    value: String(s.score),
    unit: 'of 100',
    tone: s.staleControllers ? 'bad' : scoreTone(s.score),
    reason: s.staleControllers ? `${plural(s.staleControllers, 'controller', 'controllers')} not renewing` : 'Controllers renewing',
    n: s.score,
  };
}

function capacityBlock(c: BlocksInput['capacity'], horizon: HorizonItem[], now: number): DashboardBlock {
  const base = { id: 'capacity' as const, label: 'Capacity', path: CAPACITY_PATH };
  // Something running out is the headline: how long is left, and what it is.
  const runsOut = horizon.find(h => h.kind === 'capacity');
  if (runsOut) {
    const left = inWords(runsOut.at, now).replace(/^in (about )?/, '');
    return { ...base, value: left, unit: left === 'now' ? undefined : 'until full', tone: runsOut.tone === 'error' ? 'bad' : 'warn', reason: runsOut.text, n: Math.max(0, Math.round(((runsOut.at - now) / 86400e3) * 10) / 10) };
  }
  if (c.busiest) {
    const pct = c.busiest.pct;
    return { ...base, value: `${pct}%`, unit: c.busiest.what, tone: pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : 'ok', reason: `Busiest node: ${c.busiest.cluster} ${c.busiest.node}`, n: pct };
  }
  if (!c.cpus) return { ...base, value: '—', tone: 'none', reason: 'No node capacity reported yet' };
  return { ...base, value: String(c.cpus), unit: 'vCPU', tone: 'none', reason: `${c.memoryText} of node memory; sign in to clusters for usage`, n: c.cpus };
}

/** "2 certificates expiring, 1 running out": what the next 30 days hold, by kind. */
function horizonKinds(items: HorizonItem[]): string {
  const certs = items.filter(h => h.kind === 'certificate').length;
  const out = items.filter(h => h.kind === 'capacity' || h.kind === 'supervisor').length;
  const silences = items.filter(h => h.kind === 'silence').length;
  return [certs && `${plural(certs, 'certificate', 'certificates')} expiring`, out && `${out} running out`, silences && `${plural(silences, 'silence', 'silences')} ending`].filter(Boolean).join(', ');
}

function next30Block(horizon: HorizonItem[], now: number): DashboardBlock {
  // A silence ending or a certificate that rotation renews is information, not something running out.
  const real = horizon.filter(h => h.tone !== 'info');
  return {
    id: 'next30',
    label: 'Next 30 days',
    value: String(real.length),
    unit: real.length === 1 ? 'item' : 'items',
    tone: real.some(h => h.tone === 'error') ? 'bad' : real.length ? 'warn' : 'ok',
    reason: real.length ? `${horizonKinds(real)}; first ${inWords(real[0].at, now)}` : horizon.length ? `${horizonKinds(horizon)}; first ${inWords(horizon[0].at, now)}` : 'Nothing expires or runs out',
    path: fleetTabPath('issues', 'next-30-days'),
    n: real.length,
  };
}

function lifecycleBlock(l: BlocksInput['lifecycle']): DashboardBlock {
  const base = { id: 'lifecycle' as const, label: 'Lifecycle' };
  if (l.failing) return { ...base, value: String(l.failing), tone: 'bad', reason: `${l.failing === 1 ? 'package' : 'packages'} failing to reconcile`, path: PACKAGES_PATH, n: l.failing };
  if (l.upgrading) return { ...base, value: String(l.upgrading), tone: 'warn', reason: `${l.upgrading === 1 ? 'cluster' : 'clusters'} upgrading now`, path: UPGRADES_PATH, n: l.upgrading };
  if (l.upgradable) return { ...base, value: String(l.upgradable), tone: 'none', reason: `${l.upgradable === 1 ? 'cluster' : 'clusters'} can be upgraded`, path: UPGRADES_PATH, n: l.upgradable };
  if (l.drift) return { ...base, value: String(l.drift), tone: 'warn', reason: `${l.drift === 1 ? 'package' : 'packages'} at different versions`, path: PACKAGES_PATH, n: l.drift };
  if (l.failing === undefined) return { ...base, value: '—', tone: 'none', reason: 'Sign in to clusters to read packages', path: PACKAGES_PATH };
  return { ...base, value: '0', tone: 'ok', reason: 'Packages reconciled, versions current', path: PACKAGES_PATH, n: 0 };
}

/** Open security findings: posture, compliance and vulnerabilities (the issues the wall marks with the lock). */
export function securityIssues(issues: Issue[]): Issue[] {
  return issues.filter(i => i.severity !== 'info' && iconFor(i) === 'security');
}

function securityBlock(issues: Issue[]): DashboardBlock {
  const open = securityIssues(issues);
  const critical = open.filter(i => i.severity === 'critical').length;
  return {
    id: 'security',
    label: 'Security',
    value: String(open.length),
    tone: critical ? 'bad' : open.length ? 'warn' : 'ok',
    reason: !open.length ? 'No open security findings' : critical ? `open ${open.length === 1 ? 'finding' : 'findings'}, ${critical} critical` : `open ${open.length === 1 ? 'finding' : 'findings'} (posture and compliance)`,
    path: SECURITY_ROUTE,
    n: open.length,
  };
}

function governanceBlock(g: BlocksInput['governance']): DashboardBlock {
  const base = { id: 'governance' as const, label: 'Governance', path: BASELINE_PATH };
  const without = g.backupsKnown - g.backedUp;
  const backups = !g.backupsKnown ? 'Sign in to clusters to read backups' : without ? `${plural(without, 'cluster', 'clusters')} without a backup` : 'Every cluster has a backup';
  if (g.baselinePct !== undefined) {
    return { ...base, value: `${g.baselinePct}%`, unit: 'baseline', tone: without ? 'warn' : scoreTone(g.baselinePct), reason: backups, n: g.baselinePct };
  }
  if (!g.backupsKnown) return { ...base, value: '—', tone: 'none', reason: backups };
  return { ...base, value: String(g.backedUp), unit: `of ${g.backupsKnown}`, tone: without ? 'warn' : 'ok', reason: g.backupsKnown === 1 ? 'cluster backed up' : 'clusters backed up', n: g.backedUp };
}

function networkBlock(subnet: BlocksInput['subnet']): DashboardBlock {
  const base = { id: 'network' as const, label: 'Network', path: NETWORK_PATH };
  if (!subnet) return { ...base, value: '—', tone: 'none', reason: 'No subnet usage reported' };
  return { ...base, value: `${subnet.pct}%`, tone: subnet.pct >= 95 ? 'bad' : subnet.pct >= 85 ? 'warn' : 'ok', reason: `Fullest subnet: ${subnet.name}`, n: subnet.pct };
}

/** The eight blocks, in the order they are shown. */
export function dashboardBlocks(input: BlocksInput): DashboardBlock[] {
  return [
    clustersBlock(input.tiles),
    supervisorBlock(input.supervisor),
    capacityBlock(input.capacity, input.horizon, input.now),
    next30Block(input.horizon, input.now),
    lifecycleBlock(input.lifecycle),
    securityBlock(input.issues),
    governanceBlock(input.governance),
    networkBlock(input.subnet),
  ];
}

/** The blocks' numbers by id, for the day's history point. */
export function blockNumbers(blocks: DashboardBlock[]): Record<string, number> {
  return Object.fromEntries(blocks.filter(b => b.n !== undefined).map(b => [b.id, b.n as number]));
}

/** The sentence at the top: the fleet in one line. */
export function headline(tiles: WallTile[]): string {
  const n = tiles.length;
  if (!n) return 'No clusters yet';
  const attention = tiles.filter(t => t.state === 'critical' || t.state === 'warning').length;
  if (!attention) return n === 1 ? 'The cluster is healthy' : `All ${n} clusters are healthy`;
  if (n === 1) return 'The cluster needs attention';
  return `${attention} of ${n} clusters ${attention === 1 ? 'needs' : 'need'} attention`;
}

/** The line under it: the score, how it moved, and what costs the most points. */
export function scoreLine(score: number | undefined, since: string | undefined, drivers: ScoreDriver[]): string {
  if (score === undefined) return 'No score yet: no best-practice check could run.';
  const drag = drivers[0] ? ` Biggest drag: ${drivers[0].title.charAt(0).toLowerCase()}${drivers[0].title.slice(1)} (−${drivers[0].points}).` : ' Every check that could run is passing.';
  return `Fleet score ${score}${since ? `, ${since}` : ''}.${drag}`;
}

/**
 * "Needs you now" for the dashboard: each item on one short line. An issue's
 * title loses the cluster's long name (and the node prefix that repeats it)
 * and leads with the cluster's short name instead.
 */
export function compactNow(items: NowItem[], short: (cluster: string) => string = n => n): NowItem[] {
  return items.map(i => {
    if (!i.clusterName) return i;
    const rest = tileTitle(i.title, i.clusterName);
    return { ...i, title: `${short(i.clusterName)}: ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`, sub: undefined };
  });
}
