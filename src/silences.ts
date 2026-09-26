/**
 * Silences: mute one issue (for example an accepted security finding) or a
 * whole cluster (maintenance), with a reason and an expiry, like
 * Alertmanager silences. Expired silences stop applying by themselves.
 */
import { Issue, Silence } from './types';

export const DURATIONS: Array<{ label: string; hours: number }> = [
  { label: '1 hour', hours: 1 },
  { label: '8 hours', hours: 8 },
  { label: '1 day', hours: 24 },
  { label: '1 week', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '90 days', hours: 24 * 90 },
];

export function activeSilences(all: Silence[] | undefined, now: Date = new Date()): Silence[] {
  return (all ?? []).filter(s => new Date(s.until).getTime() > now.getTime());
}

export function silenceFor(issue: Issue, silences: Silence[]): Silence | undefined {
  return silences.find(s => (s.match.issueId && s.match.issueId === issue.id) || (s.match.clusterKey && s.match.clusterKey === issue.clusterKey));
}

export function partitionIssues(issues: Issue[], silences: Silence[]): { active: Issue[]; silenced: Array<{ issue: Issue; by: Silence }> } {
  const active: Issue[] = [];
  const silenced: Array<{ issue: Issue; by: Silence }> = [];
  for (const i of issues) {
    const by = silenceFor(i, silences);
    if (by) silenced.push({ issue: i, by });
    else active.push(i);
  }
  return { active, silenced };
}

export function newSilence(match: Silence['match'], label: string, reason: string, hours: number, now: Date = new Date()): Silence {
  return {
    id: `s-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    match,
    label,
    reason,
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + hours * 3600000).toISOString(),
  };
}

export function inMaintenance(clusterKey: string, silences: Silence[]): Silence | undefined {
  return silences.find(s => s.match.clusterKey === clusterKey);
}
