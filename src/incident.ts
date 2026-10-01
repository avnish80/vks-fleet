/**
 * The incident timeline: everything the fleet knows about one cluster over a
 * window, as one story (changes and conditions, alerts, warning events,
 * unusual metrics, forecasts, open issues), with a plain summary and a
 * post-mortem draft to start from.
 *
 * The likely trigger is only a suggestion: the last change shortly before
 * the first symptom. The draft says so and asks for review.
 */
import { Alert, Forecast, humanDuration, Unusual } from './observability';
import { shortNode } from './names';
import { TimelineEntry } from './timeline';
import { EventInfo, Issue } from './types';

export type IncidentSource = 'change' | 'condition' | 'alert' | 'event' | 'anomaly' | 'forecast' | 'issue';

export interface IncidentEvent {
  /** ms; undefined for "now" (open issues, forecasts). */
  time?: number;
  source: IncidentSource;
  text: string;
  tone: 'success' | 'warning' | 'error' | 'info' | 'neutral';
  /** Counts as a symptom (something going wrong), for the trigger heuristic. */
  symptom: boolean;
}

export interface Incident {
  cluster: string;
  from: number;
  to: number;
  events: IncidentEvent[];
  firstSymptom?: IncidentEvent;
  trigger?: IncidentEvent;
  summary: string;
}

const CHANGE_KINDS = new Set(['action', 'change', 'node-added', 'node-deleting', 'created']);
const TRIGGER_WINDOW_MS = 2 * 3600e3;
const UNUSUAL_LABEL: Record<Unusual['kpi'], string> = { nodeCpu: 'Node CPU', nodeMem: 'Node memory', apiP99: 'API server latency (p99)', api5xx: 'API server errors' };

export function buildIncident(input: {
  cluster: string;
  now: Date;
  hours: number;
  timeline: TimelineEntry[];
  alerts?: Alert[];
  warnings?: EventInfo[];
  unusual?: Unusual[];
  forecasts?: Forecast[];
  issues?: Issue[];
}): Incident {
  const to = input.now.getTime();
  const from = to - input.hours * 3600e3;
  const inWindow = (t?: number) => t !== undefined && t >= from && t <= to;
  const events: IncidentEvent[] = [];
  for (const e of input.timeline) {
    const t = new Date(e.time).getTime();
    if (!inWindow(t)) continue;
    const change = CHANGE_KINDS.has(e.kind);
    events.push({ time: t, source: change ? 'change' : e.kind === 'event' ? 'event' : 'condition', text: e.text, tone: e.tone, symptom: !change && (e.tone === 'error' || e.tone === 'warning') });
  }
  for (const a of input.alerts ?? []) {
    const t = a.since ? new Date(a.since).getTime() : undefined;
    events.push({ time: inWindow(t) ? t : undefined, source: 'alert', text: `Alert ${a.name}${a.summary ? `: ${a.summary}` : ''}${!inWindow(t) && t ? ` (firing since ${new Date(t).toLocaleString()})` : ''}`, tone: a.severity === 'critical' ? 'error' : 'warning', symptom: true });
  }
  for (const w of input.warnings ?? []) {
    const t = w.lastSeen ? new Date(w.lastSeen).getTime() : undefined;
    if (!inWindow(t)) continue;
    events.push({ time: t, source: 'event', text: `${w.reason ?? 'Warning'} on ${w.object}${w.count && w.count > 1 ? ` (×${w.count})` : ''}${w.message ? `: ${w.message.slice(0, 160)}` : ''}`, tone: 'warning', symptom: true });
  }
  for (const u of input.unusual ?? []) {
    events.push({ source: 'anomaly', text: `${UNUSUAL_LABEL[u.kpi]} unusual for this time: ${u.now.toFixed(2)} now, ${u.weekAgo.toFixed(2)} a week ago`, tone: 'warning', symptom: true });
  }
  for (const f of input.forecasts ?? []) {
    events.push({ source: 'forecast', text: `${f.what} ${f.what.startsWith('node') ? shortNode(input.cluster, f.subject) : f.subject} runs out in about ${humanDuration(f.seconds)}`, tone: f.seconds < 2 * 86400 ? 'error' : 'warning', symptom: false });
  }
  for (const i of input.issues ?? []) {
    events.push({ source: 'issue', text: i.title, tone: i.severity === 'critical' ? 'error' : i.severity === 'warning' ? 'warning' : 'info', symptom: i.severity !== 'info' });
  }
  events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  const timed = events.filter(e => e.time !== undefined);
  const firstSymptom = timed.find(e => e.symptom);
  const trigger = firstSymptom
    ? timed.filter(e => e.source === 'change' && e.time! <= firstSymptom.time! && firstSymptom.time! - e.time! <= TRIGGER_WINDOW_MS).slice(-1)[0]
    : undefined;
  const open = events.filter(e => e.time === undefined && e.symptom).length;
  const parts: string[] = [];
  if (!firstSymptom && !open) parts.push(`Nothing went wrong in ${input.cluster} in the last ${input.hours} hours as far as the fleet can see.`);
  if (firstSymptom) parts.push(`The first sign of trouble in ${input.cluster} was at ${new Date(firstSymptom.time!).toLocaleString()}: ${firstSymptom.text}.`);
  if (trigger) parts.push(`It followed a change ${humanDuration((firstSymptom!.time! - trigger.time!) / 1000)} earlier: ${trigger.text}. That may be the trigger; check before concluding.`);
  else if (firstSymptom) parts.push('No change by the fleet preceded it within two hours.');
  if (open) parts.push(`${open} problem${open === 1 ? ' is' : 's are'} still open.`);
  return { cluster: input.cluster, from, to, events, firstSymptom, trigger, summary: parts.join(' ') };
}

const SOURCE_LABEL: Record<IncidentSource, string> = { change: 'Change', condition: 'Condition', alert: 'Alert', event: 'Event', anomaly: 'Unusual', forecast: 'Forecast', issue: 'Open issue' };

/** A post-mortem draft to start from: facts from the fleet, with the parts only people can fill in marked. */
export function postMortemMarkdown(inc: Incident, extra: { affected?: string[]; actions?: string[] } = {}): string {
  const when = (t?: number) => (t === undefined ? 'now' : new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
  const lines = [
    `# Incident in ${inc.cluster}: post-mortem draft`,
    '',
    `> Generated by vks-fleet from ${when(inc.from)} to ${when(inc.to)}. Review everything before sharing; the trigger is a suggestion from timing, not a conclusion.`,
    '',
    '## Summary',
    '',
    inc.summary,
    '',
    '## Impact',
    '',
    ...(extra.affected?.length ? extra.affected.map(a => `- ${a}`) : ['- _Who and what was affected, for how long (to be filled in)._']),
    '',
    '## Timeline',
    '',
    '| When | What | Detail |',
    '|---|---|---|',
    ...inc.events.map(e => `| ${when(e.time)} | ${SOURCE_LABEL[e.source]} | ${e.text.replace(/\|/g, '\\|')} |`),
    '',
    '## Likely trigger',
    '',
    inc.trigger ? `- ${inc.trigger.text} (${when(inc.trigger.time)}), shortly before the first symptom. _Confirm or rule out._` : '- _None identified from the fleet\u2019s changes; look at application deployments and external dependencies._',
    '',
    '## Actions taken',
    '',
    ...(extra.actions?.length ? extra.actions.map(a => `- ${a}`) : ['- _What was done to mitigate, and when (to be filled in)._']),
    '',
    '## Follow-ups',
    '',
    ...inc.events.filter(e => e.source === 'issue' || e.source === 'forecast').map(e => `- [ ] ${e.text}`),
    '- [ ] _Prevent a repeat (to be filled in)._',
    '',
  ];
  return lines.join('\n');
}
