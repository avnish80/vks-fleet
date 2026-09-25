/**
 * Pure types for the VKS fleet plugin. Nothing in this file imports Headlamp,
 * so it can be unit-tested and reused by a future server-side aggregator.
 */

/** One vSphere Supervisor the plugin reads from. */
export interface SupervisorConfig {
  /**
   * Stable identifier used in cluster keys and URLs. Must be DNS-label-like
   * and must not change once links have been shared.
   */
  id: string;
  /** Name of the Headlamp cluster (kubeconfig context) that points at this Supervisor. */
  headlampCluster: string;
  /** Friendly name shown in the UI. Defaults to the id. */
  displayName?: string;
  /**
   * Namespaces to read when the signed-in user cannot list across all
   * namespaces (the normal case for tenant users).
   */
  namespaces: string[];
  /**
   * Namespace label whose value names the tenant. Empty means "the namespace
   * is the tenant". Per Supervisor, because labelling can differ between
   * Supervisors or VCFA versions.
   */
  tenantLabelKey: string;
}

export interface PluginConfig {
  /** Phase 1 uses exactly one entry; everything downstream handles N. */
  supervisors: SupervisorConfig[];
  refreshSeconds: number;
}

export type Health = 'healthy' | 'degraded' | 'failed' | 'provisioning' | 'deleting' | 'unknown';

export interface ReplicaCount {
  ready: number;
  desired: number;
}

export interface ClusterCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  severity?: string;
  lastTransitionTime?: string;
}

/**
 * Normalized view of one VKS cluster. Views only ever read this shape, never
 * raw CAPI objects, so a CAPI API version change stays inside the translator.
 */
export interface FleetCluster {
  /** supervisorId/namespace/name — the only identity views may rely on. */
  key: string;
  supervisorId: string;
  namespace: string;
  name: string;
  tenant: string;
  /** False when a tenant label was configured but could not be read for this namespace. */
  tenantMapped: boolean;
  phase: string;
  health: Health;
  /** Desired Kubernetes version (from the ClusterClass topology). */
  kubernetesVersion?: string;
  /** Version the control plane currently reports. */
  controlPlaneVersion?: string;
  clusterClass?: string;
  controlPlane?: ReplicaCount;
  workers?: ReplicaCount;
  upgrading: boolean;
  conditions: ClusterCondition[];
  createdAt?: string;
  /** Source CAPI apiVersion, for diagnostics. */
  sourceApiVersion: string;
}

export type ListScope = 'cluster' | 'namespaced';

/** Result of reading one Supervisor. A failure here never blanks the rest of the fleet. */
export interface SupervisorResult {
  supervisor: SupervisorConfig;
  clusters: FleetCluster[];
  /** How the Cluster list was obtained; undefined when it failed. */
  scope?: ListScope;
  /** Set when this Supervisor could not be read at all. */
  error?: string;
  /** Partial problems (a namespace denied, labels unreadable, ...). */
  warnings: string[];
  fetchedAt: string;
}

export function clusterKey(supervisorId: string, namespace: string, name: string): string {
  return `${supervisorId}/${namespace}/${name}`;
}

export function supervisorLabel(s: SupervisorConfig): string {
  return s.displayName?.trim() || s.id;
}
