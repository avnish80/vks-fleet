/**
 * Numbers behind the fleet overview (tiles and charts). Pure, so the same
 * summaries can feed a report or a future server-side aggregator.
 */
import { needsAttention } from './summary';
import { FleetCluster, Finding, Health, Severity } from './types';

export type HealthBucket = 'healthy' | 'attention' | 'changing';

export function bucketOf(h: Health): HealthBucket {
  if (h === 'healthy') return 'healthy';
  if (h === 'provisioning' || h === 'deleting') return 'changing';
  return 'attention';
}

export interface HealthSlice {
  health: Health;
  count: number;
}

export function healthSlices(clusters: FleetCluster[]): HealthSlice[] {
  const order: Health[] = ['healthy', 'degraded', 'failed', 'unknown', 'provisioning', 'deleting'];
  return order
    .map(health => ({ health, count: clusters.filter(c => c.health === health).length }))
    .filter(s => s.count > 0);
}

export interface NodeTotals {
  ready: number;
  total: number;
  deleting: number;
}

/** Nodes across the fleet, from Supervisor machines. Machines being deleted are counted separately. */
export function nodeTotals(clusters: FleetCluster[]): NodeTotals {
  let ready = 0;
  let total = 0;
  let deleting = 0;
  for (const c of clusters) {
    for (const m of c.machines) {
      if (m.deletingSince) {
        deleting += 1;
        continue;
      }
      total += 1;
      if (m.phase === 'Running' && m.ready !== false) ready += 1;
    }
  }
  return { ready, total, deleting };
}

export interface TenantHealthRow {
  tenantId: string;
  tenantName: string;
  healthy: number;
  attention: number;
  changing: number;
  total: number;
}

export function tenantHealth(clusters: FleetCluster[]): TenantHealthRow[] {
  const rows = new Map<string, TenantHealthRow>();
  for (const c of clusters) {
    const row = rows.get(c.tenantId) ?? {
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      healthy: 0,
      attention: 0,
      changing: 0,
      total: 0,
    };
    row[bucketOf(c.health)] += 1;
    row.total += 1;
    rows.set(c.tenantId, row);
  }
  return Array.from(rows.values()).sort((a, b) => b.total - a.total || a.tenantName.localeCompare(b.tenantName));
}

export interface CertRow {
  key: string;
  cluster: FleetCluster;
  daysLeft: number;
  rotating: boolean;
}

/** Clusters by days until control-plane certificates expire, soonest first. */
export function certRows(clusters: FleetCluster[], now: Date, limit = 8): CertRow[] {
  return clusters
    .filter(c => c.certificatesExpiry)
    .map(c => ({
      key: c.key,
      cluster: c,
      daysLeft: Math.floor((new Date(c.certificatesExpiry as string).getTime() - now.getTime()) / 86400000),
      rotating: c.certificateRotation?.enabled === true,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, limit);
}

export interface ChangeRow {
  cluster: FleetCluster;
  time: string;
  text: string;
}

/** Most recent actions taken through the plugin (from the vks-fleet/last-action stamp). */
export function recentChanges(clusters: FleetCluster[], limit = 6): ChangeRow[] {
  return clusters
    .filter(c => c.lastAction)
    .map(c => ({ cluster: c, time: c.lastAction!.time, text: c.lastAction!.text }))
    .sort((a, b) => b.time.localeCompare(a.time))
    .slice(0, limit);
}

export interface OverviewNumbers {
  clusters: number;
  healthy: number;
  attention: number;
  nodes: NodeTotals;
  cpus: number;
  memoryBytes: number;
  tenants: number;
  findings: Record<Severity, number>;
  upgradable: number;
  upgrading: number;
}

export function overviewNumbers(clusters: FleetCluster[], findings: Finding[]): OverviewNumbers {
  const findingCounts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) findingCounts[f.severity] += 1;
  return {
    clusters: clusters.length,
    healthy: clusters.filter(c => c.health === 'healthy').length,
    attention: clusters.filter(needsAttention).length,
    nodes: nodeTotals(clusters),
    cpus: clusters.reduce((n, c) => n + (c.capacity?.cpus ?? 0), 0),
    memoryBytes: clusters.reduce((n, c) => n + (c.capacity?.memoryBytes ?? 0), 0),
    tenants: new Set(clusters.map(c => c.tenantId)).size,
    findings: findingCounts,
    upgradable: clusters.filter(c => c.availableUpgrade && !c.upgrading).length,
    upgrading: clusters.filter(c => c.upgrading).length,
  };
}
