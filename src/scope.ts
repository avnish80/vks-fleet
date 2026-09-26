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
export interface OrgInfo {
  id: string;
  name: string;
  namespaces: string[];
  clusters: number;
  /** Clusters not healthy. */
  attention: number;
  vms: number;
}

/**
 * Every org the data shows: from its namespaces (so orgs with only VMs count),
 * its clusters, and (when the inventory is loaded) its VM Service VMs.
 */
export function orgsOf(results: SupervisorResult[], inventories?: Map<string, Inventory> | null): OrgInfo[] {
  const m = new Map<string, OrgInfo>();
  const get = (id: string, name: string) => {
    let o = m.get(id);
    if (!o) {
      o = { id, name, namespaces: [], clusters: 0, attention: 0, vms: 0 };
      m.set(id, o);
    }
    return o;
  };
  for (const r of results) {
    const nsOrg = new Map<string, OrgInfo>();
    for (const n of r.namespaces ?? []) {
      const o = get(n.tenantId, n.tenantName);
      if (!o.namespaces.includes(n.name)) o.namespaces.push(n.name);
      nsOrg.set(n.name, o);
    }
    for (const c of r.clusters) {
      const o = get(c.tenantId, c.tenantName);
      o.clusters += 1;
      if (c.health !== 'healthy') o.attention += 1;
      if (!o.namespaces.includes(c.namespace)) o.namespaces.push(c.namespace);
      nsOrg.set(c.namespace, o);
    }
    for (const v of inventories?.get(r.supervisor.id)?.vms ?? []) {
      if (v.cluster) continue;
      const o = nsOrg.get(v.namespace);
      if (o) o.vms += 1;
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

