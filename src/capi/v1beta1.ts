/**
 * Translator from Cluster API v1beta1 objects on the Supervisor to the
 * plugin's FleetCluster model. A future v1beta2 translator sits next to this
 * file and produces the same model; views don't change.
 */
import { ClusterCondition, clusterKey, FleetCluster, Health, ReplicaCount } from '../types';

export const API_VERSION = 'cluster.x-k8s.io/v1beta1';

export const PATHS = {
  clusters: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'clusters' },
  machineDeployments: { prefix: '/apis/cluster.x-k8s.io/v1beta1', plural: 'machinedeployments' },
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
    creationTimestamp?: string;
  };
  spec?: any;
  status?: any;
}

export interface CapiObjects {
  clusters: KubeObject[];
  machineDeployments: KubeObject[];
  controlPlanes: KubeObject[];
}

export type TenantOf = (namespace: string) => { tenant: string; mapped: boolean };

const CLUSTER_NAME_LABEL = 'cluster.x-k8s.io/cluster-name';

function nsName(ns: string | undefined, name: string): string {
  return `${ns ?? ''}/${name}`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function sameVersion(a?: string, b?: string): boolean {
  return (a ?? '').trim().replace(/^v/, '') === (b ?? '').trim().replace(/^v/, '');
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

export function deriveHealth(
  phase: string,
  conds: ClusterCondition[],
  cp?: ReplicaCount,
  workers?: ReplicaCount
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
  return short(cp) || short(workers) ? 'degraded' : 'healthy';
}

export function toFleetClusters(
  objs: CapiObjects,
  supervisorId: string,
  tenantOf: TenantOf
): FleetCluster[] {
  const kcpByName = new Map<string, KubeObject>();
  for (const kcp of objs.controlPlanes) {
    kcpByName.set(nsName(kcp.metadata.namespace, kcp.metadata.name), kcp);
  }

  const mdsByCluster = new Map<string, KubeObject[]>();
  for (const md of objs.machineDeployments) {
    const owner = md.spec?.clusterName || md.metadata.labels?.[CLUSTER_NAME_LABEL];
    if (!owner) {
      continue;
    }
    const k = nsName(md.metadata.namespace, owner);
    mdsByCluster.set(k, [...(mdsByCluster.get(k) ?? []), md]);
  }

  return objs.clusters.map(c => {
    const namespace = c.metadata.namespace ?? '';
    const name = c.metadata.name;
    const cpRef = c.spec?.controlPlaneRef;
    const kcp = cpRef?.name ? kcpByName.get(nsName(cpRef.namespace || namespace, cpRef.name)) : undefined;
    const mds = mdsByCluster.get(nsName(namespace, name)) ?? [];
    const conds = conditions(c);
    const phase: string = c.status?.phase ?? 'Unknown';

    const desiredVersion: string | undefined = c.spec?.topology?.version;
    const cpVersion: string | undefined = kcp?.status?.version;
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

    const { tenant, mapped } = tenantOf(namespace);

    return {
      key: clusterKey(supervisorId, namespace, name),
      supervisorId,
      namespace,
      name,
      tenant,
      tenantMapped: mapped,
      phase,
      health: deriveHealth(phase, conds, cp, workers),
      kubernetesVersion: desiredVersion,
      controlPlaneVersion: cpVersion,
      clusterClass: c.spec?.topology?.class || undefined,
      controlPlane: cp,
      workers,
      upgrading: upgradePending || cpBehind || workersBehind,
      conditions: conds,
      createdAt: c.metadata.creationTimestamp,
      sourceApiVersion: c.apiVersion ?? API_VERSION,
    };
  });
}
