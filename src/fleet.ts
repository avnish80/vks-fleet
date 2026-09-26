import { describeError, statusOf, SupervisorClient } from './api/client';
import { ListResult, scopedList } from './api/scopedList';
import { KubeObject, PATHS, toFleetClusters } from './capi/v1beta1';
import { fetchReleaseVersions, findUpgrade, parseVersion } from './releases';
import {
  attachClassUpdates,
  attachQuotas,
  attachVms,
  DEFAULT_CLASS_NAMESPACE,
  vmClassInfos,
  fetchClassNames,
  fetchServices,
  listFirstServed,
  VMOP_VERSIONS,
} from './supervisor';
import { findLeftovers } from './cleanup';
import { labelTenantResolver, readNamespaces } from './tenancy';
import { EventInfo, FleetCluster, ServiceHealth, SupervisorConfig, SupervisorResult } from './types';
import { toEventInfo } from './workload';

/** Supervisor warnings kept for issue rules (e.g. volume attach failures). */
export const SUPERVISOR_EVENT_WINDOW_MS = 2 * 60 * 60 * 1000;

async function supervisorWarnings(
  client: import('./api/client').SupervisorClient,
  operator: boolean,
  namespaces: string[],
  now: Date
): Promise<EventInfo[]> {
  const paths = operator
    ? ['/api/v1/events?fieldSelector=type%3DWarning&limit=500']
    : namespaces.map(ns => `/api/v1/namespaces/${encodeURIComponent(ns)}/events?fieldSelector=type%3DWarning&limit=300`);
  const settled = await Promise.allSettled(paths.map(p => client.get<{ items?: any[] }>(p)));
  return settled
    .flatMap(r => (r.status === 'fulfilled' ? r.value?.items ?? [] : []))
    .map(toEventInfo)
    .filter(e => e.lastSeen && now.getTime() - new Date(e.lastSeen).getTime() <= SUPERVISOR_EVENT_WINDOW_MS);
}

/** How many minor versions `current` is behind the newest available release. */
export function minorsBehind(current: string | undefined, available: string[]): number | undefined {
  const cur = parseVersion(current);
  if (!cur) return undefined;
  const newest = available
    .map(parseVersion)
    .filter(p => p && p.parts[0] === cur.parts[0])
    .reduce((max, p) => Math.max(max, p!.parts[1]), cur.parts[1]);
  return newest - cur.parts[1];
}

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
  // VCF Automation tenants reach each namespace through its own proxy
  // endpoint, so there's no Supervisor-wide view to try first.
  const vcfa = supervisor.mode === 'vcfa';
  const list = (p: { prefix: string; plural: string }, namespaces: string[]) =>
    scopedList<KubeObject>(client, p.prefix, p.plural, namespaces, vcfa);

  let clusters: ListResult<KubeObject>;
  try {
    clusters = await list(PATHS.clusters, supervisor.namespaces);
  } catch (err) {
    const expired = statusOf(err) === 401;
    return {
      supervisor,
      clusters: [],
      signInExpired: expired || undefined,
      error: expired
        ? vcfa
          ? `The VCF Automation sign-in for ${supervisor.org} has expired (tokens last about an hour). Run on the Headlamp machine: vcf context refresh ${supervisor.org}`
          : `The sign-in to ${supervisor.headlampCluster} has expired (about 10 hours). Sign in again: kubectl vsphere login --server=${supervisor.headlampCluster} --vsphere-username <you> --insecure-skip-tls-verify`
        : describeError(err),
      warnings,
      fetchedAt,
    };
  }
  warnings.push(...clusters.warnings);

  // Everything else enriches the view; missing it is a warning, not a failure.
  // When clusters came from a namespaced read, only revisit the namespaces
  // that worked so a denied namespace is reported once.
  const operator = clusters.scope === 'cluster';
  const rest = operator ? supervisor.namespaces : clusters.readableNamespaces;
  const [mds, kcps, machines, mhcs, vms, vmClasses, quotas, releases, allNamespaces, vmServices, supPvcs] = await Promise.allSettled([
    list(PATHS.machineDeployments, rest),
    list(PATHS.controlPlanes, rest),
    list(PATHS.machines, rest),
    list(PATHS.machineHealthChecks, rest),
    listFirstServed(client, 'vmoperator.vmware.com', VMOP_VERSIONS, 'virtualmachines', rest, vcfa),
    listFirstServed(client, 'vmoperator.vmware.com', VMOP_VERSIONS, 'virtualmachineclasses', rest, vcfa),
    scopedList<KubeObject>(client, '/api/v1', 'resourcequotas', rest, vcfa),
    fetchReleaseVersions(client),
    // Supervisor-wide namespace list: tenant labels plus Supervisor services. Operators only.
    operator ? client.get<{ items?: KubeObject[] }>('/api/v1/namespaces') : Promise.resolve(undefined),
    listFirstServed(client, 'vmoperator.vmware.com', VMOP_VERSIONS, 'virtualmachineservices', rest, vcfa),
    scopedList<KubeObject>(client, '/api/v1', 'persistentvolumeclaims', rest, vcfa),
  ]);

  const optional = <T>(r: PromiseSettledResult<ListResult<T>>, what: string): T[] => {
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
  const healthChecks = optional(mhcs, 'Node health checks');
  const vmObjects = optional(vms, 'Node VM details');
  const classObjects = optional(vmClasses, 'VM class sizes');
  // Quotas are often simply not set, or not readable by tenants: no warning.
  const quotaObjects = quotas.status === 'fulfilled' ? quotas.value.items : [];

  let versions: string[] = [];
  if (releases.status === 'fulfilled') {
    versions = releases.value.versions;
    if (releases.value.warning) warnings.push(releases.value.warning);
  }
  const namespaceList: KubeObject[] | undefined =
    allNamespaces.status === 'fulfilled' ? allNamespaces.value?.items : undefined;

  let tenantOf = labelTenantResolver('', [], supervisor.tenantNames);
  if (vcfa && supervisor.org) {
    // The org is the tenant; its namespaces' labels aren't needed (or readable).
    const org = supervisor.org;
    tenantOf = () => ({ tenantId: org, tenantName: supervisor.tenantNames[org] ?? org, mapped: true, named: true });
  } else if (supervisor.tenantLabelKey) {
    let nsObjects = namespaceList;
    if (!nsObjects) {
      const names = Array.from(new Set(clusters.items.map(c => c.metadata.namespace ?? '').filter(Boolean)));
      const ns = await readNamespaces(client, names);
      warnings.push(...ns.warnings);
      nsObjects = ns.namespaces;
    }
    tenantOf = labelTenantResolver(supervisor.tenantLabelKey, nsObjects, supervisor.tenantNames);
  }

  let fleet: FleetCluster[] = toFleetClusters(
    {
      clusters: clusters.items,
      machineDeployments,
      controlPlanes,
      machines: machineObjects,
      machineHealthChecks: healthChecks,
    },
    supervisor.id,
    tenantOf,
    now
  ).map(c => ({
    ...c,
    availableUpgrade: findUpgrade(c.kubernetesVersion, versions),
    minorsBehind: versions.length ? minorsBehind(c.kubernetesVersion, versions) : undefined,
  }));

  fleet = attachVms(fleet, vmObjects, classObjects);
  fleet = attachQuotas(fleet, quotaObjects);
  const classNamespaces = Array.from(new Set(fleet.map(c => c.classNamespace ?? DEFAULT_CLASS_NAMESPACE)));
  const classNames = await fetchClassNames(client, classNamespaces);
  fleet = attachClassUpdates(fleet, classNames);

  const events = await supervisorWarnings(client, operator, rest, now);

  // Org namespaces: those carrying the tenant label (operator view), the
  // configured or readable ones otherwise, plus any holding clusters or VMs.
  const isSystem = (ns: string) => /^(kube-|vmware-system|svc-|default$)/.test(ns);
  const nsNames = new Set<string>([
    ...clusters.items.map(c => c.metadata.namespace ?? ''),
    ...vmObjects.map(v => v.metadata.namespace ?? ''),
    ...(vcfa ? supervisor.namespaces : []),
    ...(!vcfa && namespaceList && supervisor.tenantLabelKey
      ? namespaceList.filter(n => n.metadata.labels?.[supervisor.tenantLabelKey]).map(n => n.metadata.name)
      : []),
    ...(!vcfa && !operator ? rest : []),
  ]);
  const orgNamespaces = Array.from(nsNames)
    .filter(ns => ns && !isSystem(ns))
    .sort()
    .map(ns => {
      const t = tenantOf(ns);
      return { name: ns, tenantId: t.tenantId, tenantName: t.tenantName };
    });
  const cleanup = findLeftovers(
    supervisor.id,
    supervisor.headlampCluster,
    clusters.items,
    vmObjects,
    vmServices.status === 'fulfilled' ? vmServices.value.items : [],
    supPvcs.status === 'fulfilled' ? supPvcs.value.items : [],
    now
  );

  let services: ServiceHealth[] | undefined;
  if (namespaceList) {
    const s = await fetchServices(client, namespaceList.map(n => n.metadata.name), now);
    services = s.services;
    warnings.push(...s.warnings);
  }

  return {
    supervisor,
    clusters: fleet,
    scope: clusters.scope,
    warnings: Array.from(new Set(warnings)),
    services,
    releases: versions,
    classes: classNames,
    events,
    vmClasses: vmClassInfos(classObjects),
    cleanup,
    namespaces: orgNamespaces,
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
