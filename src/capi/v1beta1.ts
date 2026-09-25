/**
 * Translator from Cluster API v1beta1 objects on the Supervisor to the
 * plugin's FleetCluster model. A future v1beta2 translator sits next to this
 * file and produces the same model; views don't change.
 *
 * Note: current VKS Supervisors prefer cluster.x-k8s.io/v1beta2 but still
 * serve v1beta1, which is what this reads.
 */
import {
  ClusterCondition,
  clusterKey,
  FleetCluster,
  Health,
  HealthCheckSummary,
  MachineInfo,
  NodePool,
  ReplicaCount,
} from '../types';

export const API_VERSION = 'cluster.x-k8s.io/v1beta1';

export const PATHS = {
  clusters: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'clusters' },
  machineDeployments: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'machinedeployments' },
  machines: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'machines' },
  machineHealthChecks: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'machinehealthchecks' },
  controlPlanes: { prefix: '/apis/controlplane.cluster.x-k8s.io/v1beta1', plural: 'kubeadmcontrolplanes' },
} as const;

/** Minimal structural type for the fields we read. Everything is optional on purpose. */
export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    creationTimestamp?: string;
    deletionTimestamp?: string;
  };
  spec?: any;
  status?: any;
}

export interface CapiObjects {
  clusters: KubeObject[];
  machineDeployments: KubeObject[];
  controlPlanes: KubeObject[];
  machines: KubeObject[];
  machineHealthChecks?: KubeObject[];
}

export interface TenantInfo {
  tenantId: string;
  tenantName: string;
  mapped: boolean;
  named: boolean;
}

export type TenantOf = (namespace: string) => TenantInfo;

const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';
const CONTROL_PLANE_LABEL = 'cluster.x-k8s.io/control-plane';
const MD_NAME_LABEL = 'cluster.x-k8s.io/deployment-name';
const TOPOLOGY_MD_LABEL = 'topology.cluster.x-k8s.io/deployment-name';
const OS_IMAGE_ANNOTATION = 'run.tanzu.vmware.com/resolve-os-image';
const AUTOSCALER_MIN = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size';
const AUTOSCALER_MAX = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size';

/** A machine stuck in a transitional state longer than this is reported as an issue. */
export const STUCK_AFTER_MS = 30 * 60 * 1000;
/** A running machine whose Ready condition has been False longer than this is reported. */
export const NOT_READY_AFTER_MS = 10 * 60 * 1000;

function nsName(ns: string | undefined, name: string): string {
  return `${ns ?? ''}/${name}`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function optNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function sameVersion(a?: string, b?: string): boolean {
  return (a ?? '').trim().replace(/^v/, '') === (b ?? '').trim().replace(/^v/, '');
}

export function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function conditions(obj: KubeObject): ClusterCondition[] {
  const raw = obj.status?.conditions;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((c: any) => c && typeof c.type === 'string')
    .map((c: any) => ({
      type: c.type,
      status: String(c.status ?? 'Unknown'),
      reason: c.reason || undefined,
      message: c.message || undefined,
      severity: c.severity || undefined,
      lastTransitionTime: c.lastTransitionTime || undefined,
    }));
}

/** Topology variables ([{name, value}]) as a map. */
function variables(list: unknown): Map<string, any> {
  const m = new Map<string, any>();
  if (Array.isArray(list)) {
    for (const v of list) {
      if (v && typeof v.name === 'string') m.set(v.name, v.value);
    }
  }
  return m;
}

/** "os-name=ubuntu, os-version=24.04" → "ubuntu 24.04" */
export function parseOsAnnotation(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = new Map(
    value.split(',').map(p => {
      const [k, ...rest] = p.split('=');
      return [k.trim(), rest.join('=').trim()] as [string, string];
    })
  );
  const text = [parts.get('os-name'), parts.get('os-version')].filter(Boolean).join(' ');
  return text || undefined;
}

function controlPlaneCount(kcp: KubeObject | undefined): ReplicaCount | undefined {
  if (!kcp) {
    return undefined;
  }
  return {
    ready: num(kcp.status?.readyReplicas),
    desired: num(kcp.spec?.replicas ?? kcp.status?.replicas),
  };
}

function workerCount(mds: KubeObject[]): ReplicaCount | undefined {
  if (mds.length === 0) {
    return undefined;
  }
  return mds.reduce<ReplicaCount>(
    (acc, md) => ({
      ready: acc.ready + num(md.status?.readyReplicas),
      desired: acc.desired + num(md.spec?.replicas),
    }),
    { ready: 0, desired: 0 }
  );
}

function nodePools(cluster: KubeObject, mds: KubeObject[], clusterVars: Map<string, any>): NodePool[] {
  const topoMds: any[] = cluster.spec?.topology?.workers?.machineDeployments ?? [];
  const mdForTopo = (name: string) => mds.find(md => md.metadata.labels?.[TOPOLOGY_MD_LABEL] === name);

  if (Array.isArray(topoMds) && topoMds.length > 0) {
    return topoMds
      .map((t, topologyIndex) => ({ t, topologyIndex }))
      .filter(({ t }) => t && typeof t.name === 'string')
      .map(({ t, topologyIndex }) => {
        const md = mdForTopo(t.name);
        const overrides = variables(t.variables?.overrides);
        const ann: Record<string, string> = t.metadata?.annotations ?? {};
        const min = optNum(ann[AUTOSCALER_MIN]);
        const max = optNum(ann[AUTOSCALER_MAX]);
        return {
          name: t.name,
          topologyIndex,
          className: str(t.class),
          ready: num(md?.status?.readyReplicas),
          available: num(md?.status?.availableReplicas),
          desired: optNum(t.replicas) ?? optNum(md?.spec?.replicas),
          vmClass: str(overrides.get('vmClass')) ?? str(clusterVars.get('vmClass')),
          storageClass: str(overrides.get('storageClass')) ?? str(clusterVars.get('storageClass')),
          failureDomain: str(t.failureDomain) ?? str(md?.spec?.template?.spec?.failureDomain),
          autoscaler: min !== undefined || max !== undefined ? { min, max } : undefined,
        };
      });
  }

  // Not a ClusterClass cluster: fall back to the MachineDeployments themselves.
  return mds.map(md => ({
    name: md.metadata.name,
    ready: num(md.status?.readyReplicas),
    available: num(md.status?.availableReplicas),
    desired: optNum(md.spec?.replicas),
    failureDomain: str(md.spec?.template?.spec?.failureDomain),
  }));
}

function machineInfo(m: KubeObject, poolOfMd: Map<string, string>): MachineInfo {
  const labels = m.metadata.labels ?? {};
  const addresses: any[] = Array.isArray(m.status?.addresses) ? m.status.addresses : [];
  const ready = conditions(m).find(c => c.type === 'Ready');
  const mdName = labels[MD_NAME_LABEL];
  return {
    name: m.metadata.name,
    nodeName: str(m.status?.nodeRef?.name),
    role: CONTROL_PLANE_LABEL in labels ? 'control-plane' : 'worker',
    pool: mdName ? poolOfMd.get(mdName) ?? mdName : undefined,
    phase: str(m.status?.phase) ?? 'Unknown',
    ready: ready ? ready.status === 'True' : undefined,
    version: str(m.spec?.version),
    internalIP: str(addresses.find(a => a?.type === 'InternalIP')?.address),
    failureDomain: str(m.spec?.failureDomain),
    osImage: str(m.status?.nodeInfo?.osImage),
    createdAt: m.metadata.creationTimestamp,
    deletingSince: m.metadata.deletionTimestamp,
    certificatesExpiry: str(m.status?.certificatesExpiryDate),
  };
}

/** Sums the cluster's MachineHealthChecks. Repair counts as blocked if any check has stopped remediating. */
export function healthCheckSummary(mhcs: KubeObject[]): HealthCheckSummary | undefined {
  if (mhcs.length === 0) return undefined;
  let expected = 0;
  let healthy = 0;
  let remediationAllowed = true;
  for (const m of mhcs) {
    const e = num(m.status?.expectedMachines);
    const h = num(m.status?.currentHealthy);
    expected += e;
    healthy += h;
    const cond = conditions(m).find(c => c.type === 'RemediationAllowed');
    const allowedCount = optNum(m.status?.remediationsAllowed);
    if (cond?.status === 'False' || (allowedCount === 0 && h < e)) remediationAllowed = false;
  }
  return { expected, healthy, remediationAllowed };
}

/** Plain-language problems visible from the Supervisor, e.g. a machine stuck deleting. */
export function machineIssues(machines: KubeObject[], now: Date): string[] {
  const issues: string[] = [];
  const age = (ts?: string) => (ts ? now.getTime() - new Date(ts).getTime() : 0);
  for (const m of machines) {
    const label = str(m.status?.nodeRef?.name) ?? m.metadata.name;
    const phase: string = m.status?.phase ?? 'Unknown';
    const deleting = age(m.metadata.deletionTimestamp);
    if (m.metadata.deletionTimestamp) {
      if (deleting > STUCK_AFTER_MS) {
        issues.push(`Machine ${label} has been deleting for ${formatDuration(deleting)}`);
      }
      continue;
    }
    if (phase === 'Failed') {
      issues.push(`Machine ${label} failed`);
      continue;
    }
    const created = age(m.metadata.creationTimestamp);
    if (phase !== 'Running' && created > STUCK_AFTER_MS) {
      issues.push(`Machine ${label} has been ${phase.toLowerCase()} for ${formatDuration(created)}`);
      continue;
    }
    const ready = conditions(m).find(c => c.type === 'Ready');
    if (phase === 'Running' && ready?.status === 'False') {
      const since = age(ready.lastTransitionTime);
      if (since > NOT_READY_AFTER_MS) {
        issues.push(`Machine ${label} has not been ready for ${formatDuration(since)}`);
      }
    }
  }
  return issues;
}

export function deriveHealth(
  phase: string,
  conds: ClusterCondition[],
  cp?: ReplicaCount,
  workers?: ReplicaCount,
  issues: string[] = []
): Health {
  switch (phase) {
    case 'Deleting':
      return 'deleting';
    case 'Failed':
      return 'failed';
    case 'Pending':
    case 'Provisioning':
      return 'provisioning';
  }
  const ready = conds.find(c => c.type === 'Ready');
  if (!ready) {
    return 'unknown';
  }
  if (ready.status !== 'True') {
    return ready.severity === 'Error' ? 'failed' : 'degraded';
  }
  const short = (r?: ReplicaCount) => !!r && r.ready < r.desired;
  return short(cp) || short(workers) || issues.length > 0 ? 'degraded' : 'healthy';
}

export function toFleetClusters(
  objs: CapiObjects,
  supervisorId: string,
  tenantOf: TenantOf,
  now: Date = new Date()
): FleetCluster[] {
  const kcpByName = new Map<string, KubeObject>();
  for (const kcp of objs.controlPlanes) {
    kcpByName.set(nsName(kcp.metadata.namespace, kcp.metadata.name), kcp);
  }

  const byCluster = (items: KubeObject[], owner: (o: KubeObject) => string | undefined) => {
    const m = new Map<string, KubeObject[]>();
    for (const o of items) {
      const name = owner(o);
      if (!name) continue;
      const k = nsName(o.metadata.namespace, name);
      m.set(k, [...(m.get(k) ?? []), o]);
    }
    return m;
  };
  const mdsByCluster = byCluster(
    objs.machineDeployments,
    md => md.spec?.clusterName || md.metadata.labels?.[CLUSTER_NAME_LABEL]
  );
  const machinesByCluster = byCluster(
    objs.machines,
    m => m.spec?.clusterName || m.metadata.labels?.[CLUSTER_NAME_LABEL]
  );
  const mhcsByCluster = byCluster(
    objs.machineHealthChecks ?? [],
    m => m.spec?.clusterName || m.metadata.labels?.[CLUSTER_NAME_LABEL]
  );

  return objs.clusters.map(c => {
    const namespace = c.metadata.namespace ?? '';
    const name = c.metadata.name;
    const cpRef = c.spec?.controlPlaneRef;
    const kcp = cpRef?.name ? kcpByName.get(nsName(cpRef.namespace || namespace, cpRef.name)) : undefined;
    const mds = mdsByCluster.get(nsName(namespace, name)) ?? [];
    const rawMachines = machinesByCluster.get(nsName(namespace, name)) ?? [];
    const conds = conditions(c);
    const phase: string = c.status?.phase ?? 'Unknown';
    const topology = c.spec?.topology;
    const vars = variables(topology?.variables);

    const desiredVersion: string | undefined = str(topology?.version);
    const cpVersion: string | undefined = str(kcp?.status?.version);
    const cp = controlPlaneCount(kcp);
    const workers = workerCount(mds);

    const topo = conds.find(x => x.type === 'TopologyReconciled');
    const upgradePending = topo?.status === 'False' && /UpgradePending/.test(topo.reason ?? '');
    const cpBehind = !!desiredVersion && !!cpVersion && !sameVersion(desiredVersion, cpVersion);
    const workersBehind =
      !!desiredVersion &&
      mds.some(md => {
        const v: string | undefined = md.spec?.template?.spec?.version;
        return !!v && !sameVersion(v, desiredVersion);
      });

    const poolOfMd = new Map<string, string>();
    for (const md of mds) {
      const topoName = md.metadata.labels?.[TOPOLOGY_MD_LABEL];
      if (topoName) poolOfMd.set(md.metadata.name, topoName);
    }
    const machines = rawMachines
      .map(m => machineInfo(m, poolOfMd))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'control-plane' ? -1 : 1));
    const issues = machineIssues(rawMachines, now);

    const endpointHost = str(c.spec?.controlPlaneEndpoint?.host);
    const endpointPort = optNum(c.spec?.controlPlaneEndpoint?.port);
    const net = c.spec?.clusterNetwork;
    const pods: string[] = Array.isArray(net?.pods?.cidrBlocks) ? net.pods.cidrBlocks : [];
    const services: string[] = Array.isArray(net?.services?.cidrBlocks) ? net.services.cidrBlocks : [];

    const tenant = tenantOf(namespace);
    const certExpiries = machines
      .filter(m => m.role === 'control-plane' && m.certificatesExpiry && !m.deletingSince)
      .map(m => m.certificatesExpiry as string)
      .sort();
    const rotation = vars.get('kubernetes')?.certificateRotation;

    return {
      key: clusterKey(supervisorId, namespace, name),
      supervisorId,
      namespace,
      name,
      tenantId: tenant.tenantId,
      tenantName: tenant.tenantName,
      tenantMapped: tenant.mapped,
      tenantNamed: tenant.named,
      phase,
      health: deriveHealth(phase, conds, cp, workers, issues),
      issues,
      kubernetesVersion: desiredVersion,
      controlPlaneVersion: cpVersion,
      clusterClass: str(topology?.class) ?? str(topology?.classRef?.name),
      classNamespace: str(topology?.classNamespace) ?? str(topology?.classRef?.namespace),
      paused: c.spec?.paused === true || 'cluster.x-k8s.io/paused' in (c.metadata.annotations ?? {}),
      certificatesExpiry: certExpiries[0],
      certificateRotation:
        rotation && typeof rotation === 'object'
          ? { enabled: rotation.enabled === true, renewalDaysBeforeExpiry: optNum(rotation.renewalDaysBeforeExpiry) }
          : undefined,
      healthCheck: healthCheckSummary(mhcsByCluster.get(nsName(namespace, name)) ?? []),
      controlPlane: cp,
      workers,
      upgrading: upgradePending || cpBehind || workersBehind,
      endpoint: endpointHost ? { host: endpointHost, port: endpointPort ?? 6443 } : undefined,
      network:
        pods.length || services.length
          ? { pods, services, serviceDomain: str(net?.serviceDomain) }
          : undefined,
      vmClass: str(vars.get('vmClass')),
      storageClass: str(vars.get('storageClass')),
      osImage:
        machines.find(m => m.osImage)?.osImage ??
        parseOsAnnotation(topology?.controlPlane?.metadata?.annotations?.[OS_IMAGE_ANNOTATION]),
      cni: str(vars.get('bootstrapAddons')?.cniRef?.name),
      nodePools: nodePools(c, mds, vars),
      machines,
      conditions: conds,
      createdAt: c.metadata.creationTimestamp,
      sourceApiVersion: c.apiVersion ?? API_VERSION,
    };
  });
}
