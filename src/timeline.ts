/**
 * A cluster's recent history, rebuilt from timestamps the Supervisor keeps:
 * creation, machines added and deleting, condition changes, plugin actions,
 * and (on the cluster page) Supervisor events. No storage needed, so it only
 * reaches back as far as those timestamps do.
 */
import { EventInfo, FleetCluster } from './types';

export type TimelineKind = 'created' | 'node-added' | 'node-deleting' | 'condition' | 'action' | 'event';

export interface TimelineEntry {
  time: string;
  kind: TimelineKind;
  text: string;
  /** Good, bad or neutral, for colouring. */
  tone: 'success' | 'warning' | 'error' | 'info' | 'neutral';
  clusterKey: string;
  clusterName: string;
  /** Machine name, when the entry is about one. */
  machine?: string;
}

/** Conditions where True is the good state; others (e.g. Paused) aren't listed. */
const POSITIVE = new Set([
  'Ready',
  'ControlPlaneReady',
  'ControlPlaneInitialized',
  'InfrastructureReady',
  'TopologyReconciled',
  'CloudProviderReconciled',
  'StorageProviderReconciled',
  'DNSReconciled',
  'KubeProxyReconciled',
  'SSOReconciled',
]);

export function clusterTimeline(c: FleetCluster, events: EventInfo[] = []): TimelineEntry[] {
  const base = { clusterKey: c.key, clusterName: c.name };
  const out: TimelineEntry[] = [];
  if (c.createdAt) out.push({ ...base, time: c.createdAt, kind: 'created', text: `Cluster created (${c.kubernetesVersion ?? 'version unknown'})`, tone: 'info' });

  for (const m of c.machines) {
    const label = m.nodeName ?? m.name;
    const where = m.role === 'control-plane' ? 'control plane' : `pool ${m.pool ?? '—'}`;
    if (m.createdAt) out.push({ ...base, time: m.createdAt, kind: 'node-added', text: `Node ${label} added (${where})`, tone: 'success', machine: m.name });
    if (m.deletingSince) out.push({ ...base, time: m.deletingSince, kind: 'node-deleting', text: `Node ${label} deletion started`, tone: 'warning', machine: m.name });
  }

  for (const cond of c.conditions) {
    if (!cond.lastTransitionTime || !POSITIVE.has(cond.type)) continue;
    // A condition that has always been True since creation isn't news.
    if (cond.status === 'True' && c.createdAt && Math.abs(new Date(cond.lastTransitionTime).getTime() - new Date(c.createdAt).getTime()) < 15 * 60000) continue;
    out.push({
      ...base,
      time: cond.lastTransitionTime,
      kind: 'condition',
      text: `${cond.type} became ${cond.status}${cond.reason ? ` (${cond.reason})` : ''}`,
      tone: cond.status === 'True' ? 'success' : cond.status === 'False' ? 'error' : 'neutral',
    });
  }

  if (c.lastAction?.time) {
    out.push({ ...base, time: c.lastAction.time, kind: 'action', text: `Plugin action: ${c.lastAction.text}`, tone: 'info' });
  }

  for (const e of events) {
    if (!e.lastSeen) continue;
    out.push({
      ...base,
      time: e.lastSeen,
      kind: 'event',
      text: `${e.object ? `${e.object}: ` : ''}${e.reason ?? ''}${e.message ? `, ${e.message}` : ''}${e.count && e.count > 1 ? ` (x${e.count})` : ''}`,
      tone: e.type === 'Warning' ? 'warning' : 'neutral',
    });
  }
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

/** Entries across the fleet within the last `days`, oldest first per cluster. */
export function fleetTimeline(clusters: FleetCluster[], now: Date, days = 7): Map<string, TimelineEntry[]> {
  const from = now.getTime() - days * 86400000;
  const lanes = new Map<string, TimelineEntry[]>();
  for (const c of clusters) {
    const entries = clusterTimeline(c)
      .filter(e => new Date(e.time).getTime() >= from)
      .sort((a, b) => a.time.localeCompare(b.time));
    lanes.set(c.key, entries);
  }
  return lanes;
}
