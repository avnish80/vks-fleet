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
  /** From the topology. Unset means deletion waits for volumes to detach indefinitely. */
  nodeVolumeDetachTimeout?: string;
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
  /** A MachineHealthCheck covers this machine, so it can be replaced with the remediate-machine annotation. */
  healthChecked?: boolean;
}

export interface VmClassInfo {
  namespace: string;
  name: string;
  cpus?: number;
  memoryBytes?: number;
  /** Reserves its resources (guaranteed) rather than best effort. */
  reserved?: boolean;
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
  /** Last action taken through this plugin, from the vks-fleet/last-action stamp. */
  lastAction?: { time: string; text: string };
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
  /** Kubernetes release versions the Supervisor offers (ready and compatible). */
  releases?: string[];
  /** ClusterClass names available in the class namespaces the clusters use. */
  classes?: string[];
  /** Recent Warning events on the Supervisor (last couple of hours). */
  events?: EventInfo[];
  /** VM classes available per namespace, with their sizes. */
  vmClasses?: VmClassInfo[];
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
  /** Where to go to see or fix it: a page path, possibly with a section, highlight or action. */
  target?: string;
}

/* ---------- Inside the workload cluster (via a Headlamp context) ---------- */

export type WorkloadStatus = 'ok' | 'issues' | 'no-context' | 'no-access' | 'expired' | 'unreachable';

export interface PodIssue {
  namespace: string;
  name: string;
  reason: string;
  /** Node the pod is scheduled on, if any. */
  node?: string;
}

export interface DeploymentIssue {
  namespace: string;
  name: string;
  available: number;
  desired: number;
}

export interface NodeUse {
  name: string;
  cpuUsed: number;
  cpuAllocatable: number;
  memUsed: number;
  memAllocatable: number;
  cpuPct: number;
  memPct: number;
}

export interface PodUse {
  namespace: string;
  name: string;
  node?: string;
  cpu: number;
  mem: number;
}

export interface Utilisation {
  nodes: NodeUse[];
  cpuPct: number;
  memPct: number;
  topByCpu: PodUse[];
  topByMemory: PodUse[];
  /** User pods with a container that requests no CPU or memory. */
  podsWithoutRequests: string[];
}

export interface StuckObject {
  namespace: string;
  name: string;
  /** Since when (creation time). */
  since?: string;
  /** Extra detail, e.g. the storage class. */
  detail?: string;
}

export interface SandboxFailure {
  node: string;
  pods: number;
  attempts: number;
  /** The most telling part of the latest error message. */
  error: string;
}

export interface EventInfo {
  /** Node that reported it (kubelet events). */
  host?: string;
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
  /** Pods whose network couldn't be set up in the last hour, grouped by node. */
  sandboxFailures: SandboxFailure[];
  /** Best-practice observations about workloads (user namespaces only). */
  checks?: WorkloadChecks;
  /** Volume claims stuck Pending for more than a few minutes. */
  pendingClaims?: StuckObject[];
  /** LoadBalancer services still without an external IP after a few minutes. */
  pendingLoadBalancers?: StuckObject[];
  /** Cluster DNS (CoreDNS) availability, when readable. */
  dns?: { available: number; desired: number };
  /** Live usage from metrics-server, when installed. */
  utilisation?: Utilisation;
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

/* ---------------- Checks ---------------- */

export interface WorkloadChecks {
  privilegedPods: string[];
  /** Pods with at least one container that sets no resource limits. */
  podsWithoutLimits: string[];
  /** Containers using a ":latest" or untagged image. */
  latestImages: string[];
  /** Deployments with more than one replica and no PodDisruptionBudget. */
  unprotectedDeployments: string[];
  singleReplicaDeployments: string[];
  /** Whether a backup tool (Velero) is installed, if it could be determined. */
  backup?: boolean;
  /** How many user pods and deployments were looked at. */
  podsChecked: number;
  deploymentsChecked: number;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type CheckCategory = 'Resilience' | 'Lifecycle' | 'Security' | 'Operations';

export interface CheckResult {
  id: string;
  category: CheckCategory;
  title: string;
  status: CheckStatus;
  detail: string;
  /** How to fix it, when it isn't passing. */
  fix?: string;
  /** Relative importance in the score. */
  weight: number;
}

export interface Scorecard {
  clusterKey: string;
  /** 0..100 over the checks that could be evaluated. */
  score: number;
  checks: CheckResult[];
  evaluated: number;
  total: number;
}

/* ---------------- Issues ---------------- */

export interface RunbookStep {
  title: string;
  /** Commands to run, already filled in with this issue's names. */
  commands?: string[];
  note?: string;
}

export interface IssueLink {
  label: string;
  path: string;
}

/** One problem, with its cause and everything it explains, folded from related findings and signals. */
export interface Issue {
  id: string;
  severity: Severity;
  supervisorId: string;
  clusterKey?: string;
  clusterName?: string;
  namespace?: string;
  tenantName?: string;
  title: string;
  cause: string;
  evidence: string[];
  affected: { clusters: string[]; tenants: string[]; nodes: string[]; pods: string[] };
  fix: string;
  /** The most specific place to look: clicking the issue goes here. */
  primary?: IssueLink;
  links: IssueLink[];
  /** Finding ids this issue explains (so they aren't listed twice). */
  findingIds: string[];
  /** Step-by-step commands to investigate and fix it. */
  runbook?: RunbookStep[];
  detectedAt: string;
}
