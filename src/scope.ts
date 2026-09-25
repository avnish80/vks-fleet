import { Inventory, SupervisorResult } from './types';

export const ALL_ORGS = '__all__';

/**
 * Narrows every Supervisor's data to one org (tenant): its clusters, the
 * leftovers in its namespaces, and none of the Supervisor-wide services.
 */
export function scopeResults(results: SupervisorResult[], org: string): SupervisorResult[] {
  if (org === ALL_ORGS) return results;
  return results.map(r => {
    const clusters = r.clusters.filter(c => c.tenantId === org);
    const namespaces = new Set([
      ...clusters.map(c => c.namespace),
      ...(r.namespaces ?? []).filter(n => n.tenantId === org).map(n => n.name),
    ]);
    return {
      ...r,
      clusters,
      namespaces: (r.namespaces ?? []).filter(n => n.tenantId === org),
      cleanup: (r.cleanup ?? []).filter(i => namespaces.has(i.namespace)),
      services: undefined,
      events: (r.events ?? []).filter(e => !e.namespace || namespaces.has(e.namespace)),
    };
  });
}

/** Orgs present in the data, for the switcher. */
export function orgsOf(results: SupervisorResult[]): Array<{ id: string; name: string; clusters: number }> {
  const m = new Map<string, { id: string; name: string; clusters: number }>();
  for (const r of results) {
    for (const c of r.clusters) {
      const cur = m.get(c.tenantId) ?? { id: c.tenantId, name: c.tenantName, clusters: 0 };
      cur.clusters += 1;
      m.set(c.tenantId, cur);
    }
  }
  return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Narrows an inventory to the namespaces of one org. */
export function scopeInventory(inv: Inventory, namespaces: Set<string> | undefined): Inventory {
  if (!namespaces) return inv;
  const keep = <T extends { namespace?: string }>(xs: T[]) => xs.filter(x => !x.namespace || namespaces.has(x.namespace));
  return {
    ...inv,
    vms: keep(inv.vms),
    lbs: keep(inv.lbs),
    subnets: keep(inv.subnets),
    vpcs: keep(inv.vpcs),
    nsx: inv.nsx.filter(x => x.namespace && namespaces.has(x.namespace)),
    quotas: keep(inv.quotas),
    volumes: keep(inv.volumes),
    supervisorNodes: undefined,
  };
}

