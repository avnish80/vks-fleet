import { FleetCluster } from './types';

export function needsAttention(c: FleetCluster): boolean {
  return c.health === 'degraded' || c.health === 'failed' || c.health === 'unknown';
}

export interface FleetTotals {
  clusters: number;
  tenants: number;
  healthy: number;
  attention: number;
  upgrading: number;
}

export function fleetTotals(clusters: FleetCluster[]): FleetTotals {
  return {
    clusters: clusters.length,
    tenants: new Set(clusters.map(c => c.tenant)).size,
    healthy: clusters.filter(c => c.health === 'healthy').length,
    attention: clusters.filter(needsAttention).length,
    upgrading: clusters.filter(c => c.upgrading).length,
  };
}

export interface TenantRollup {
  tenant: string;
  clusters: number;
  attention: number;
  upgrading: number;
  versions: string[];
  supervisorIds: string[];
  /** True if any namespace in this tenant fell back to "namespace as tenant". */
  unmapped: boolean;
}

export function rollupByTenant(clusters: FleetCluster[]): TenantRollup[] {
  const groups = new Map<string, FleetCluster[]>();
  for (const c of clusters) {
    groups.set(c.tenant, [...(groups.get(c.tenant) ?? []), c]);
  }
  return Array.from(groups.entries())
    .map(([tenant, cs]) => ({
      tenant,
      clusters: cs.length,
      attention: cs.filter(needsAttention).length,
      upgrading: cs.filter(c => c.upgrading).length,
      versions: uniqueSorted(cs.map(c => c.kubernetesVersion ?? 'unknown')),
      supervisorIds: uniqueSorted(cs.map(c => c.supervisorId)),
      unmapped: cs.some(c => !c.tenantMapped),
    }))
    .sort((a, b) => b.attention - a.attention || a.tenant.localeCompare(b.tenant));
}

export function versionSpread(clusters: FleetCluster[]): Array<{ version: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of clusters) {
    const v = c.kubernetesVersion ?? 'unknown';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
