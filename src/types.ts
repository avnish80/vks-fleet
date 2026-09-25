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
   * Namespace label whose value identifies the tenant. Empty means "the
   * namespace is the tenant". Per Supervisor, because labelling can differ.
   */
  tenantLabelKey: string;
  /** Tenant ID → display name, for IDs that aren't human-readable (VCFA org UUIDs). */
  tenantNames: Record<string, string>;
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

export interface NodePool {
  name: string;
  /** Position in the Cluster's spec.topology.workers.machineDeployments; needed to change the pool. */
  topologyIndex?: number;
  className?: string;
  ready: number;
  available: number;
  /** Undefined when the pool is autoscaled and has no fixed replica count. */
  desired?: number;
  vmClass?: string;
  storageClass?: string;
  failureDomain?: string;
  /** From the topology, e.g. "5m0s". Unset means drains wait indefinitely. */
  nodeDrainTimeout?: string;
  autoscaler?: { min?: number; max?: number };
}

export interface VmInfo {
  powerState?: string;
  className?: string;
  ip?: string;
  zone?: string;
  cpus?: number;
  memoryBytes?: number;
}

export interface MachineInfo {
  name: string;
  nodeName?: string;
  role: 'control-plane' | 'worker';
  /** Node pool name for workers. */
  pool?: string;
  phase: string;
  ready?: boolean;
  version?: string;
  internalIP?: string;
  failureDomain?: string;
  osImage?: string;
  createdAt?: string;
  deletingSince?: string;
  /** Control-plane machines only: when the Kubernetes certificates expire. */
  certificatesExpiry?: string;
  /** The node's VirtualMachine on the Supervisor, when readable. */
  vm?: VmInfo;
}

export interface HealthCheckSummary {
  expected: number;
  healthy: number;
  /** False when automatic repair has hit its limit (maxUnhealthy) and stopped. */
  remediationAllowed: boolean;
}

export interface Capacity {
  cpus: number;
  memoryBytes: number;
  /** Nodes whose VM or VM class couldn't be read are left out of the totals. */
  nodesCounted: number;
}

export interface QuotaItem {
  resource: string;
  used: string;
  hard: string;
  /** used / hard, 0..1+, when both parse as quantities. */
  ratio?: number;
}

export interface UpgradeInfo {
  version: string;
  kind: 'patch' | 'minor';
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
  /** Grouping key (e.g. the VCFA organization ID). Never changes when a display name is added. */
  tenantId: string;
  /** What the UI shows for the tenant. */
  tenantName: string;
  /** False when a tenant label was configured but could not be read for this namespace. */
  tenantMapped: boolean;
  /** False when the tenant is only known by an unreadable ID (no name configured yet). */
  tenantNamed: boolean;
  phase: string;
  health: Health;
  /** Problems found on the Supervisor side, in plain language. */
  issues: string[];
  /** Desired Kubernetes version (from the ClusterClass topology). */
  kubernetesVersion?: string;
  /** Version the control plane currently reports. */
  controlPlaneVersion?: string;
  availableUpgrade?: UpgradeInfo;
  /** Minor versions behind the newest release on the Supervisor. */
  minorsBehind?: number;
  clusterClass?: string;
  classNamespace?: string;
  /** Newer ClusterClass of the same family, when one exists. */
  classUpdate?: string;
  paused: boolean;
  /** Earliest control-plane certificate expiry. */
  certificatesExpiry?: string;
  certificateRotation?: { enabled: boolean; renewalDaysBeforeExpiry?: number };
  healthCheck?: HealthCheckSummary;
  capacity?: Capacity;
  /** ResourceQuota usage for the cluster's namespace. */
  quota?: QuotaItem[];
  controlPlane?: ReplicaCount;
  workers?: ReplicaCount;
  upgrading: boolean;
  endpoint?: { host: string; port: number };
  network?: { pods: string[]; services: string[]; serviceDomain?: string };
  vmClass?: string;
  storageClass?: string;
  osImage?: string;
  cni?: string;
  nodePools: NodePool[];
  machines: MachineInfo[];
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
  /** Supervisor services (svc-* namespaces); only readable with Supervisor-wide access. */
  services?: ServiceHealth[];
  fetchedAt: string;
}

export interface ServiceHealth {
  namespace: string;
  name: string;
  pods: number;
  problems: PodIssue[];
  /** Failed pods already replaced by a running pod of the same owner: left-overs, safe to delete. */
  leftovers: number;
}

export type Severity = 'critical' | 'warning' | 'info';

/** Something an operator should know or do, with the fix in plain language. */
export interface Finding {
  /** Stable identity, so the same finding keeps its place across refreshes. */
  id: string;
  severity: Severity;
  /** What the finding is about: one cluster, a Supervisor namespace, or the Supervisor itself. */
  scope: 'cluster' | 'namespace' | 'supervisor';
  supervisorId: string;
  clusterKey?: string;
  clusterName?: string;
  namespace?: string;
  tenantName?: string;
  title: string;
  detail?: string;
  fix: string;
}

/* ---------- Inside the workload cluster (via a Headlamp context) ---------- */

export type WorkloadStatus = 'ok' | 'issues' | 'no-context' | 'no-access' | 'expired' | 'unreachable';

export interface PodIssue {
  namespace: string;
  name: string;
  reason: string;
}

export interface DeploymentIssue {
  namespace: string;
  name: string;
  available: number;
  desired: number;
}

export interface EventInfo {
  type?: string;
  namespace?: string;
  object: string;
  reason?: string;
  message?: string;
  lastSeen?: string;
  count?: number;
}

export interface WorkloadHealth {
  status: WorkloadStatus;
  /** Headlamp cluster (kubeconfig context) used to reach the workload cluster. */
  contextName?: string;
  serverVersion?: string;
  nodes?: { ready: number; total: number };
  podCount?: number;
  /** True when the pod list was cut off at the page size. */
  podsTruncated?: boolean;
  podIssues: PodIssue[];
  podIssueCount: number;
  deploymentIssues: DeploymentIssue[];
  recentWarnings: EventInfo[];
  recentWarningCount: number;
  /** Parts that couldn't be read (e.g. "pods: Access denied (403)"). */
  partial: string[];
  error?: string;
}

export function clusterKey(supervisorId: string, namespace: string, name: string): string {
  return `${supervisorId}/${namespace}/${name}`;
}

export function supervisorLabel(s: SupervisorConfig): string {
  return s.displayName?.trim() || s.id;
}
