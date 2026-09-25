import { SupervisorResult } from './types';

export const ALL_ORGS = '__all__';

/**
 * Narrows every Supervisor's data to one org (tenant): its clusters, the
 * leftovers in its namespaces, and none of the Supervisor-wide services.
 */
export function scopeResults(results: SupervisorResult[], org: string): SupervisorResult[] {
  if (org === ALL_ORGS) return results;
  return results.map(r => {
    const clusters = r.clusters.filter(c => c.tenantId === org);
    const namespaces = new Set(clusters.map(c => c.namespace));
    return {
      ...r,
      clusters,
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
