import { describeError, statusOf, SupervisorClient } from './api/client';
import { KubeObject, TenantOf } from './capi/v1beta1';

/**
 * Builds the namespace → tenant function for one Supervisor.
 *
 * Swap this out if tenancy should come from somewhere other than a namespace
 * label (a VCFA API call, a ConfigMap, ...). The rest of the plugin only sees
 * the TenantOf function.
 */
export function labelTenantResolver(
  labelKey: string,
  namespaceObjects: KubeObject[]
): TenantOf {
  if (!labelKey) {
    // Configured mode: the namespace is the tenant.
    return ns => ({ tenant: ns, mapped: true });
  }
  const byName = new Map(namespaceObjects.map(n => [n.metadata.name, n]));
  return ns => {
    const value = byName.get(ns)?.metadata.labels?.[labelKey];
    return value ? { tenant: value, mapped: true } : { tenant: ns, mapped: false };
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
