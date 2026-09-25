import { describeError, SupervisorClient } from './api/client';
import { ListResult, scopedList } from './api/scopedList';
import { KubeObject, PATHS, toFleetClusters } from './capi/v1beta1';
import { fetchReleaseVersions, findUpgrade } from './releases';
import { labelTenantResolver, readNamespaces } from './tenancy';
import { SupervisorConfig, SupervisorResult } from './types';

/**
 * Reads one Supervisor. Never throws: a failure becomes `error` on the result
 * so the other Supervisors in the fleet still render.
 */
export async function fetchSupervisor(
  supervisor: SupervisorConfig,
  client: SupervisorClient,
  now: Date = new Date()
): Promise<SupervisorResult> {
  const fetchedAt = now.toISOString();
  const warnings: string[] = [];
  const list = (p: { prefix: string; plural: string }, namespaces: string[]) =>
    scopedList<KubeObject>(client, p.prefix, p.plural, namespaces);

  let clusters: ListResult<KubeObject>;
  try {
    clusters = await list(PATHS.clusters, supervisor.namespaces);
  } catch (err) {
    return { supervisor, clusters: [], error: describeError(err), warnings, fetchedAt };
  }
  warnings.push(...clusters.warnings);

  // Everything else enriches the view; missing it is a warning, not a failure.
  // When clusters came from a namespaced read, only revisit the namespaces
  // that worked so a denied namespace is reported once.
  const rest = clusters.scope === 'namespaced' ? clusters.readableNamespaces : supervisor.namespaces;
  const [mds, kcps, machines, releases] = await Promise.allSettled([
    list(PATHS.machineDeployments, rest),
    list(PATHS.controlPlanes, rest),
    list(PATHS.machines, rest),
    fetchReleaseVersions(client),
  ]);

  const optional = <T>(
    r: PromiseSettledResult<ListResult<T>>,
    what: string
  ): T[] => {
    if (r.status === 'rejected') {
      warnings.push(`${what} unavailable: ${describeError(r.reason)}`);
      return [];
    }
    warnings.push(...r.value.warnings);
    return r.value.items;
  };
  const machineDeployments = optional(mds, 'Node pool details');
  const controlPlanes = optional(kcps, 'Control plane details');
  const machineObjects = optional(machines, 'Machine details');

  let versions: string[] = [];
  if (releases.status === 'fulfilled') {
    versions = releases.value.versions;
    if (releases.value.warning) warnings.push(releases.value.warning);
  }

  let tenantOf = labelTenantResolver('', [], supervisor.tenantNames);
  if (supervisor.tenantLabelKey) {
    const names = Array.from(new Set(clusters.items.map(c => c.metadata.namespace ?? '').filter(Boolean)));
    const ns = await readNamespaces(client, names);
    warnings.push(...ns.warnings);
    tenantOf = labelTenantResolver(supervisor.tenantLabelKey, ns.namespaces, supervisor.tenantNames);
  }

  const fleet = toFleetClusters(
    { clusters: clusters.items, machineDeployments, controlPlanes, machines: machineObjects },
    supervisor.id,
    tenantOf,
    now
  ).map(c => ({ ...c, availableUpgrade: findUpgrade(c.kubernetesVersion, versions) }));

  return {
    supervisor,
    clusters: fleet,
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
