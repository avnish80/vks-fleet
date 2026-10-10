/**
 * The fleet page's hero band: the fleet at a glance, what needs you now,
 * and what's coming in the next 30 days.
 */
import { shortNode } from './names';
import { Forecast, humanDuration } from './observability';
import { clusterPath } from './routes';
import { FleetCluster, Issue, Silence } from './types';

export interface HorizonItem {
  /** When it happens (ms). */
  at: number;
  text: string;
  tone: 'error' | 'warning' | 'info';
  kind: 'certificate' | 'capacity' | 'supervisor' | 'silence';
  /** Page to open. */
  path?: string;
  clusterKey?: string;
  cluster?: string;
  /** What runs out, for grouping ("node memory"). */
  what?: string;
}

export const HORIZON_DAYS = 30;

export function horizon(input: {
  now: Date;
  clusters: FleetCluster[];
  /** Observability forecasts, per cluster. */
  forecasts?: Array<{ clusterName: string; clusterKey: string; forecasts: Forecast[] }>;
  /** Certificates inside clusters (cert-manager) expiring soon. */
  certificates?: Array<{ clusterName: string; clusterKey: string; name: string; expires: string }>;
  /** Supervisor control-plane VM disks filling up: seconds until full. */
  supervisorDisks?: Array<{ supervisor: string; vm: string; seconds: number }>;
  silences?: Silence[];
  days?: number;
  /** Display name for a cluster (shortened when names share a prefix). */
  short?: (cluster: string) => string;
}): HorizonItem[] {
  const now = input.now.getTime();
  const end = now + (input.days ?? HORIZON_DAYS) * 86400e3;
  const short = input.short ?? ((n: string) => n);
  const items: HorizonItem[] = [];
  const within = (t: number) => t >= now - 86400e3 && t <= end;
  for (const c of input.clusters) {
    if (!c.certificatesExpiry) continue;
    const t = new Date(c.certificatesExpiry).getTime();
    if (!within(t)) continue;
    const auto = c.certificateRotation?.enabled;
    const days = (t - now) / 86400e3;
    items.push({
      at: t,
      kind: 'certificate',
      tone: auto ? 'info' : days < 7 ? 'error' : 'warning',
      text: `${short(c.name)}: control-plane certificates expire${auto ? ' (rotation renews them first)' : ''}`,
      path: clusterPath(c),
      clusterKey: c.key,
      cluster: short(c.name),
    });
  }
  for (const x of input.certificates ?? []) {
    const t = new Date(x.expires).getTime();
    if (!within(t)) continue;
    items.push({ at: t, kind: 'certificate', tone: t - now < 7 * 86400e3 ? 'error' : 'warning', text: `${short(x.clusterName)}: certificate ${x.name} expires`, clusterKey: x.clusterKey, cluster: short(x.clusterName) });
  }
  for (const s of input.forecasts ?? []) {
    for (const f of s.forecasts) {
      const t = now + f.seconds * 1000;
      if (!within(t)) continue;
      const node = f.what === 'node disk' || f.what === 'node memory';
      items.push({
        at: t,
        kind: 'capacity',
        tone: f.seconds < 2 * 86400 ? 'error' : 'warning',
        text: node ? `${short(s.clusterName)}: ${f.what} full on ${shortNode(s.clusterName, f.subject)}` : `${short(s.clusterName)}: ${f.what} ${f.subject} full`,
        path: `/vks-fleet/observability?cluster=${encodeURIComponent(s.clusterKey)}`,
        clusterKey: s.clusterKey,
        cluster: short(s.clusterName),
        what: f.what,
      });
    }
  }
  for (const d of input.supervisorDisks ?? []) {
    const t = now + d.seconds * 1000;
    if (!within(t)) continue;
    items.push({ at: t, kind: 'supervisor', tone: d.seconds < 7 * 86400 ? 'error' : 'warning', text: `Supervisor ${d.supervisor}: ${d.vm} disk full`, path: '/vks-fleet/supervisor-health' });
  }
  for (const s of input.silences ?? []) {
    const t = new Date(s.until).getTime();
    if (!within(t) || t < now) continue;
    items.push({ at: t, kind: 'silence', tone: 'info', text: `Silence ends, the issue returns: ${s.label}` });
  }
  // The same event can arrive twice (a metric scraped by two jobs): keep the earliest of each.
  const seen = new Map<string, HorizonItem>();
  for (const i of items.sort((a, b) => a.at - b.at)) if (!seen.has(`${i.kind}|${i.text}`)) seen.set(`${i.kind}|${i.text}`, i);
  return Array.from(seen.values());
}

export const inWords = (at: number, now: number) => {
  const s = (at - now) / 1000;
  return s <= 0 ? 'now' : s < 86400 ? `in ${humanDuration(s)}` : `in ${Math.round(s / 86400)} day${Math.round(s / 86400) === 1 ? '' : 's'}`;
};

export interface Glance {
  score?: number;
  clusters: number;
  attention: number;
  critical: number;
  warnings: number;
  supervisorScore?: number;
}

export function glance(clusters: FleetCluster[], scores: number[], issues: Issue[], supervisorScores: number[]): Glance {
  return {
    score: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : undefined,
    clusters: clusters.length,
    attention: clusters.filter(c => c.health !== 'healthy').length,
    critical: issues.filter(i => i.severity === 'critical').length,
    warnings: issues.filter(i => i.severity === 'warning').length,
    supervisorScore: supervisorScores.length ? Math.min(...supervisorScores) : undefined,
  };
}

export interface NowItem {
  id: string;
  title: string;
  sub?: string;
  severity: 'critical' | 'warning' | 'info';
  path?: string;
  investigate?: { clusterKey: string; node?: string };
  /** The cluster an issue belongs to (its full name), when it has one. */
  clusterName?: string;
}

/**
 * What needs you now: time-bound problems first (something running out within
 * a week, a certificate within two), then critical issues, then warnings by
 * how much they touch.
 */
export function needsYouNow(issues: Issue[], coming: HorizonItem[] = [], now = Date.now(), n = 3): NowItem[] {
  const urgent: NowItem[] = [];
  const soon = coming.filter(h => (h.kind === 'certificate' ? h.at - now < 14 * 86400e3 && h.tone !== 'info' : (h.kind === 'capacity' || h.kind === 'supervisor') && h.at - now < 7 * 86400e3));
  const groups = new Map<string, HorizonItem[]>();
  for (const h of soon) {
    const k = h.kind === 'capacity' ? `${h.clusterKey}|${h.what}` : `${h.kind}|${h.text}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  for (const [k, hs] of groups) {
    const first = hs[0];
    urgent.push({
      id: `soon|${k}`,
      title: first.kind === 'capacity' && hs.length > 1 ? `${first.cluster}: ${first.what} runs out on ${hs.length} nodes` : first.kind === 'capacity' ? `${first.text.replace(/ full on /, ' runs out on ')}` : first.text,
      sub: `${first.kind === 'capacity' && hs.length > 1 ? 'first ' : ''}${inWords(first.at, now)}`,
      severity: first.tone === 'error' ? 'critical' : 'warning',
      path: first.path,
      investigate: first.clusterKey ? { clusterKey: first.clusterKey } : undefined,
    });
  }
  const covered = new Set(soon.filter(h => h.kind === 'capacity').map(h => h.clusterKey));
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  const reach = (i: Issue) => i.affected.clusters.length + i.affected.nodes.length + i.affected.pods.length;
  const rest = issues
    .filter(i => i.severity !== 'info')
    // A forecast already shown as time-bound isn't repeated as an issue.
    .filter(i => !(i.id.includes('#forecast#') && i.clusterKey && covered.has(i.clusterKey)))
    .map((i, k) => ({ i, k }))
    .sort((a, b) => rank[a.i.severity] - rank[b.i.severity] || reach(b.i) - reach(a.i) || a.k - b.k)
    .map(({ i }) => ({
      id: i.id,
      title: i.title,
      sub: [i.clusterName, i.tenantName].filter(Boolean).join(' · ') || undefined,
      severity: i.severity,
      path: i.primary?.path,
      investigate: i.clusterKey ? { clusterKey: i.clusterKey, node: i.affected.nodes[0] } : undefined,
      clusterName: i.clusterName,
    }));
  const urgentSorted = urgent.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return [...urgentSorted, ...rest].slice(0, n);
}
