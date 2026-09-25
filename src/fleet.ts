import { describeError, SupervisorClient } from './api/client';
import { scopedList } from './api/scopedList';
import { KubeObject, PATHS, toFleetClusters } from './capi/v1beta1';
import { labelTenantResolver, readNamespaces } from './tenancy';
import { SupervisorConfig, SupervisorResult } from './types';

/**
 * Reads one Supervisor. Never throws: a failure becomes `error` on the result
 * so the other Supervisors in the fleet still render.
 */
export async function fetchSupervisor(
  supervisor: SupervisorConfig,
  client: SupervisorClient
): Promise<SupervisorResult> {
  const fetchedAt = new Date().toISOString();
  const warnings: string[] = [];
  const list = (p: { prefix: string; plural: string }, namespaces: string[]) =>
    scopedList<KubeObject>(client, p.prefix, p.plural, namespaces);

  let clusters;
  try {
    clusters = await list(PATHS.clusters, supervisor.namespaces);
  } catch (err) {
    return { supervisor, clusters: [], error: describeError(err), warnings, fetchedAt };
  }
  warnings.push(...clusters.warnings);

  // Machine deployments and control planes enrich the view; missing them is a
  // warning, not a failure. When clusters came from a namespaced read, only
  // revisit the namespaces that worked so a denied namespace is reported once.
  const rest = clusters.scope === 'namespaced' ? clusters.readableNamespaces : supervisor.namespaces;
  const [mds, kcps] = await Promise.allSettled([
    list(PATHS.machineDeployments, rest),
    list(PATHS.controlPlanes, rest),
  ]);
  const machineDeployments = mds.status === 'fulfilled' ? mds.value.items : [];
  const controlPlanes = kcps.status === 'fulfilled' ? kcps.value.items : [];
  if (mds.status === 'rejected') {
    warnings.push(`Worker node counts unavailable: ${describeError(mds.reason)}`);
  } else {
    warnings.push(...mds.value.warnings);
  }
  if (kcps.status === 'rejected') {
    warnings.push(`Control plane details unavailable: ${describeError(kcps.reason)}`);
  } else {
    warnings.push(...kcps.value.warnings);
  }

  let tenantOf = labelTenantResolver('', []);
  if (supervisor.tenantLabelKey) {
    const names = Array.from(new Set(clusters.items.map(c => c.metadata.namespace ?? '').filter(Boolean)));
    const ns = await readNamespaces(client, names);
    warnings.push(...ns.warnings);
    tenantOf = labelTenantResolver(supervisor.tenantLabelKey, ns.namespaces);
  }

  return {
    supervisor,
    clusters: toFleetClusters(
      { clusters: clusters.items, machineDeployments, controlPlanes },
      supervisor.id,
      tenantOf
    ),
    scope: clusters.scope,
    warnings: Array.from(new Set(warnings)),
    fetchedAt,
  };
}

/** Fans out over every configured Supervisor in parallel. */
export function fetchFleet(
  supervisors: SupervisorConfig[],
  clientFor: (s: SupervisorConfig) => SupervisorClient
): Promise<SupervisorResult[]> {
  return Promise.all(supervisors.map(s => fetchSupervisor(s, clientFor(s))));
}
