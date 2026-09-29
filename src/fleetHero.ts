/**
 * The fleet page's hero band: the fleet at a glance, what needs you now,
 * and what's coming in the next 30 days.
 */
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
}

export const HORIZON_DAYS = 30;

export function horizon(input: {
  now: Date;
  clusters: FleetCluster[];
  /** Observability forecasts, per cluster. */
  forecasts?: Array<{ clusterName: string; clusterKey: string; forecasts: Forecast[] }>;
  /** Supervisor control-plane VM disks filling up: seconds until full. */
  supervisorDisks?: Array<{ supervisor: string; vm: string; seconds: number }>;
  silences?: Silence[];
  days?: number;
}): HorizonItem[] {
  const now = input.now.getTime();
  const end = now + (input.days ?? HORIZON_DAYS) * 86400e3;
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
      text: `${c.name}: control-plane certificates expire${auto ? ' (rotation is on: renewed before then)' : ''}`,
      path: clusterPath(c),
    });
  }
  for (const s of input.forecasts ?? []) {
    for (const f of s.forecasts) {
      const t = now + f.seconds * 1000;
      if (!within(t)) continue;
      items.push({ at: t, kind: 'capacity', tone: f.seconds < 2 * 86400 ? 'error' : 'warning', text: `${s.clusterName}: ${f.what} ${f.subject} full`, path: `/vks-fleet/observability?cluster=${encodeURIComponent(s.clusterKey)}` });
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
  return items.sort((a, b) => a.at - b.at);
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

/** The issues to show first: critical before warnings, then those touching the most. */
export function needsYouNow(issues: Issue[], n = 3): Issue[] {
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  const reach = (i: Issue) => i.affected.clusters.length + i.affected.nodes.length + i.affected.pods.length;
  return issues
    .filter(i => i.severity !== 'info')
    .map((i, k) => ({ i, k }))
    .sort((a, b) => rank[a.i.severity] - rank[b.i.severity] || reach(b.i) - reach(a.i) || a.k - b.k)
    .slice(0, n)
    .map(x => x.i);
}
