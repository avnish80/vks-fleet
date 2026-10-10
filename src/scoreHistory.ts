/**
 * The fleet score over time, kept in the browser: one point per day and per
 * scope (Supervisor filter + org), so the dashboard can show a trend and what
 * changed since the last visit without any server.
 *
 * Pure functions over plain data; the store itself lives in the component.
 * The history is per browser: another browser or person starts its own.
 */

export interface ScorePoint {
  /** Local day, YYYY-MM-DD. */
  d: string;
  /** Fleet score that day (the last value seen). */
  s: number;
  /** Each dashboard block's number that day, by what it measures (see DashboardBlock.metric). */
  b?: Record<string, number>;
}

/** Points by scope, oldest first. */
export type ScoreHistory = Record<string, ScorePoint[]>;

/** How long a day's point is kept. */
export const HISTORY_DAYS = 90;
/** The window the dashboard's trend line shows. */
export const TREND_DAYS = 30;
/** Scopes kept (Supervisor and org combinations); the least recently seen go first. */
export const MAX_SCOPES = 24;

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a date. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole days from one day to a later one (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const t = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((t(to) - t(from)) / 86400e3);
}

const same = (a?: ScorePoint, b?: ScorePoint) => !!a && !!b && a.d === b.d && a.s === b.s && JSON.stringify(a.b ?? {}) === JSON.stringify(b.b ?? {});

/**
 * The history with today's point set (replacing an earlier one from today).
 * Returns the same object when nothing changed, so a caller can skip the write.
 */
export function recordPoint(history: ScoreHistory | undefined, scope: string, point: ScorePoint, keep = HISTORY_DAYS): ScoreHistory {
  const all = history ?? {};
  const before = all[scope] ?? [];
  if (same(before[before.length - 1], point)) return all;
  const points = [...before.filter(p => p.d !== point.d && daysBetween(p.d, point.d) > 0 && daysBetween(p.d, point.d) < keep), point].sort((a, b) => a.d.localeCompare(b.d));
  const next: ScoreHistory = { ...all, [scope]: points };
  const scopes = Object.keys(next);
  if (scopes.length > MAX_SCOPES) {
    const last = (k: string) => next[k][next[k].length - 1]?.d ?? '';
    for (const k of scopes.sort((a, b) => last(a).localeCompare(last(b))).slice(0, scopes.length - MAX_SCOPES)) if (k !== scope) delete next[k];
  }
  return next;
}

/** The points inside the trend window, oldest first. */
export function trendPoints(points: ScorePoint[] | undefined, today: string, days = TREND_DAYS): ScorePoint[] {
  return (points ?? []).filter(p => daysBetween(p.d, today) >= 0 && daysBetween(p.d, today) < days);
}

export interface SinceLast {
  /** Today's score minus the score on the last earlier day this browser recorded. */
  delta: number;
  /** How many days ago that was. */
  days: number;
}

/** The change since the last earlier day with a point: "since your last visit". */
export function sinceLast(points: ScorePoint[] | undefined, today: string, score: number): SinceLast | undefined {
  const earlier = (points ?? []).filter(p => daysBetween(p.d, today) > 0);
  const last = earlier[earlier.length - 1];
  return last ? { delta: score - last.s, days: daysBetween(last.d, today) } : undefined;
}

/** "up 3 since your last visit 2 days ago", or undefined when there is no earlier visit. */
export function sinceLastText(since: SinceLast | undefined): string | undefined {
  if (!since) return undefined;
  const when = since.days === 1 ? 'yesterday' : `${since.days} days ago`;
  if (since.delta === 0) return `unchanged since your last visit ${when}`;
  return `${since.delta > 0 ? 'up' : 'down'} ${Math.abs(since.delta)} since your last visit ${when}`;
}

/**
 * Demo mode: a made-up month that ends at today's score, so the trend is
 * visible on the first day. Deterministic (no randomness), and a real point
 * from this browser replaces the made-up one for its day.
 */
export function demoHistory(score: number, today: string, stored: ScorePoint[] = [], days = TREND_DAYS, blocks?: (back: number) => Record<string, number>): ScorePoint[] {
  const [y, m, d] = today.split('-').map(Number);
  const real = new Map(stored.map(p => [p.d, p]));
  const out: ScorePoint[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(y, m - 1, d - back);
    const day = dayOf(date);
    const kept = real.get(day);
    if (kept) {
      out.push(kept);
      continue;
    }
    // A slow climb with two dips (an incident, a bad upgrade), ending exactly at today's score.
    const climb = back === 0 ? 0 : 2 + Math.round((back / (days - 1)) * 7);
    const dip = back >= 17 && back <= 19 ? 6 : back >= 7 && back <= 8 ? 4 : 0;
    const wobble = back < 3 ? 0 : [0, 1, 0, -1, 1, 0, -1][back % 7];
    out.push({ d: day, s: Math.max(0, Math.min(100, score - climb - dip + wobble)), ...(blocks ? { b: blocks(back) } : {}) });
  }
  return out;
}

/** One measure over time: a day and its value. */
export interface SeriesPoint {
  d: string;
  v: number;
}

/** The fleet score as a series. */
export const scoreSeries = (points: ScorePoint[]): SeriesPoint[] => points.map(p => ({ d: p.d, v: p.s }));

/** One block's measure as a series: the days it was recorded with that meaning. */
export function blockSeries(points: ScorePoint[] | undefined, metric: string | undefined): SeriesPoint[] {
  if (!metric) return [];
  return (points ?? []).filter(p => typeof p.b?.[metric] === 'number').map(p => ({ d: p.d, v: p.b![metric] }));
}

/** The change in a series since its last earlier day. */
export function seriesSince(series: SeriesPoint[], today: string, current: number): SinceLast | undefined {
  const earlier = series.filter(p => daysBetween(p.d, today) > 0);
  const last = earlier[earlier.length - 1];
  return last ? { delta: current - last.v, days: daysBetween(last.d, today) } : undefined;
}

/** An SVG polyline for a series: x by day, y by value. `minSpan`: the smallest range drawn, so a flat line sits mid-height and small moves aren't exaggerated. */
export function seriesLine(series: SeriesPoint[], today: string, width: number, height: number, days = TREND_DAYS, minSpan = 10, pad = 4): { line: string; last?: { x: number; y: number } } {
  const shown = series.filter(p => daysBetween(p.d, today) >= 0 && daysBetween(p.d, today) < days);
  if (!shown.length) return { line: '' };
  const lo = Math.min(...shown.map(p => p.v));
  const hi = Math.max(...shown.map(p => p.v));
  const span = Math.max(hi - lo, minSpan);
  const mid = (hi + lo) / 2;
  const x = (p: SeriesPoint) => pad + ((days - 1 - daysBetween(p.d, today)) / (days - 1)) * (width - 2 * pad);
  const y = (p: SeriesPoint) => pad + (1 - (p.v - (mid - span / 2)) / span) * (height - 2 * pad);
  const xy = shown.map(p => ({ x: Math.round(x(p) * 10) / 10, y: Math.round(y(p) * 10) / 10 }));
  return { line: xy.map(p => `${p.x},${p.y}`).join(' '), last: xy[xy.length - 1] };
}

/** An SVG polyline for a score series: x by day, y by score (padded so a flat line sits mid-height). */
export function sparkline(points: ScorePoint[], today: string, width: number, height: number, days = TREND_DAYS): { line: string; last?: { x: number; y: number } } {
  return seriesLine(scoreSeries(points), today, width, height, days);
}
