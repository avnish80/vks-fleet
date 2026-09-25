import { describeError, statusOf, SupervisorClient } from './api/client';
import { KubeObject, TenantInfo, TenantOf } from './capi/v1beta1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Display name for a tenant ID: the configured name if there is one; an
 * abbreviated ID if it's an unreadable UUID; otherwise the ID itself.
 */
export function tenantDisplay(id: string, names: Record<string, string>): { name: string; named: boolean } {
  const configured = names[id];
  if (configured) return { name: configured, named: true };
  if (UUID.test(id)) return { name: `${id.slice(0, 8)}…`, named: false };
  return { name: id, named: true };
}

/**
 * Builds the namespace → tenant function for one Supervisor.
 *
 * Grouping always uses the tenant ID; names are display only, so adding or
 * changing a name never regroups clusters. Swap this out if tenancy should
 * come from somewhere else (a VCFA API call, a ConfigMap, ...).
 */
export function labelTenantResolver(
  labelKey: string,
  namespaceObjects: KubeObject[],
  names: Record<string, string> = {}
): TenantOf {
  const info = (tenantId: string, mapped: boolean): TenantInfo => {
    const d = tenantDisplay(tenantId, names);
    return { tenantId, tenantName: d.name, mapped, named: d.named };
  };
  if (!labelKey) {
    // Configured mode: the namespace is the tenant.
    return ns => info(ns, true);
  }
  const byName = new Map(namespaceObjects.map(n => [n.metadata.name, n]));
  return ns => {
    const value = byName.get(ns)?.metadata.labels?.[labelKey];
    return value ? info(value, true) : info(ns, false);
  };
}

/**
 * Reads the Namespace objects needed for tenant labels, using the widest
 * access the caller has: list all, else get each one. Never throws; problems
 * come back as warnings and those namespaces fall back to "namespace as tenant".
 */
export async function readNamespaces(
  client: SupervisorClient,
  names: string[]
): Promise<{ namespaces: KubeObject[]; warnings: string[] }> {
  if (names.length === 0) {
    return { namespaces: [], warnings: [] };
  }
  try {
    const list = await client.get<{ items?: KubeObject[] }>('/api/v1/namespaces');
    return { namespaces: list?.items ?? [], warnings: [] };
  } catch (err) {
    if (statusOf(err) !== 403) {
      return { namespaces: [], warnings: [`Couldn't read namespace labels: ${describeError(err)}`] };
    }
  }

  const settled = await Promise.allSettled(
    names.map(n => client.get<KubeObject>(`/api/v1/namespaces/${encodeURIComponent(n)}`))
  );
  const namespaces: KubeObject[] = [];
  const denied: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.metadata) {
      namespaces.push(r.value);
    } else {
      denied.push(names[i]);
    }
  });
  const warnings = denied.length
    ? [`Couldn't read tenant labels for namespaces ${denied.join(', ')}; showing the namespace name as the tenant.`]
    : [];
  return { namespaces, warnings };
}
