/**
 * Data for one machine's page. The Supervisor side (machine, VM, events)
 * works without signing in to the cluster; the node side (node, pods, which
 * pods block a drain) needs a Headlamp context for the workload cluster.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { parseConditions } from './capi/v1beta1';
import { matchesSelector } from './selector';

export { matchesSelector };
import { VMOP_VERSIONS } from './supervisor';
import { ClusterCondition, EventInfo } from './types';
import { eventTime, toEventInfo } from './workload';

const CAPI = '/apis/cluster.x-k8s.io/v1beta1';

export interface VmDetail {
  powerState?: string;
  className?: string;
  imageName?: string;
  ip?: string;
  zone?: string;
  host?: string;
  uniqueId?: string;
  conditions: ClusterCondition[];
}

export interface MachineDetail {
  raw?: any;
  conditions: ClusterCondition[];
  /** Newer, more detailed conditions CAPI also publishes (status.v1beta2.conditions). */
  detailedConditions: ClusterCondition[];
  drainStarted?: string;
  volumeWaitStarted?: string;
  vm?: VmDetail;
  events: EventInfo[];
  warnings: string[];
}

/**
 * Plain-language "what's happening" from the machine's conditions: why a
 * deletion is stuck (drain, volumes, hooks) or which provisioning step it's on.
 */
export function machineStatusNotes(d: MachineDetail): string[] {
  const notes: string[] = [];
  const add = (label: string, c?: ClusterCondition) => {
    if (c?.message) notes.push(`${label}: ${c.message}`);
    else if (c?.reason) notes.push(`${label}: ${c.reason}`);
  };
  const find = (list: ClusterCondition[], type: string, status?: string) =>
    list.find(c => c.type === type && (status === undefined || c.status === status));

  add('Deletion', find(d.detailedConditions, 'Deleting', 'True'));
  add('Drain', find(d.conditions, 'DrainingSucceeded', 'False'));
  add('Volume detach', find(d.conditions, 'VolumeDetachSucceeded', 'False'));
  add('Pre-drain hook', find(d.conditions, 'PreDrainDeleteHookSucceeded', 'False'));
  add('Pre-terminate hook', find(d.conditions, 'PreTerminateDeleteHookSucceeded', 'False'));
  add('Infrastructure', find(d.conditions, 'InfrastructureReady', 'False'));
  add('Bootstrap', find(d.conditions, 'BootstrapReady', 'False'));
  add('Node', find(d.conditions, 'NodeHealthy', 'False'));
  add('VM', d.vm?.conditions.find(c => c.status === 'False'));
  return Array.from(new Set(notes));
}

/** Which stage a deleting machine is stuck in, from its conditions. */
export function deletionStage(d: MachineDetail): 'drain' | 'volume' | undefined {
  const deleting = d.detailedConditions.find(c => c.type === 'Deleting' && c.status === 'True');
  const msg = `${deleting?.message ?? ''} ${deleting?.reason ?? ''}`;
  if (/volume/i.test(msg) || d.conditions.some(c => c.type === 'VolumeDetachSucceeded' && c.status === 'False')) {
    return 'volume';
  }
  if (/drain/i.test(msg) || d.conditions.some(c => c.type === 'DrainingSucceeded' && c.status === 'False')) {
    return 'drain';
  }
  return undefined;
}

async function getVm(client: SupervisorClient, ns: string, name: string): Promise<any> {
  let last: unknown;
  for (const v of VMOP_VERSIONS) {
    try {
      return await client.get<any>(
        `/apis/vmoperator.vmware.com/${v}/namespaces/${encodeURIComponent(ns)}/virtualmachines/${encodeURIComponent(name)}`
      );
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      last = err;
    }
  }
  throw last;
}

export async function fetchMachineDetail(
  client: SupervisorClient,
  namespace: string,
  machineName: string
): Promise<MachineDetail> {
  const ns = encodeURIComponent(namespace);
  const [machine, vm, events] = await Promise.allSettled([
    client.get<any>(`${CAPI}/namespaces/${ns}/machines/${encodeURIComponent(machineName)}`),
    getVm(client, namespace, machineName),
    client.get<any>(`/api/v1/namespaces/${ns}/events`),
  ]);
  const warnings: string[] = [];
  const detail: MachineDetail = { conditions: [], detailedConditions: [], events: [], warnings };

  if (machine.status === 'fulfilled') {
    const m = machine.value;
    const raw = JSON.parse(JSON.stringify(m));
    if (raw?.metadata) delete raw.metadata.managedFields;
    detail.raw = raw;
    detail.conditions = parseConditions(m?.status?.conditions);
    detail.detailedConditions = parseConditions(m?.status?.v1beta2?.conditions);
    detail.drainStarted = m?.status?.deletion?.nodeDrainStartTime;
    detail.volumeWaitStarted = m?.status?.deletion?.waitForNodeVolumeDetachStartTime;
  } else {
    warnings.push(`Machine unavailable: ${describeError(machine.reason)}`);
  }

  if (vm.status === 'fulfilled') {
    const v = vm.value;
    detail.vm = {
      powerState: v?.status?.powerState,
      className: v?.spec?.className,
      imageName: v?.spec?.imageName,
      ip: v?.status?.network?.primaryIP4 ?? v?.status?.vmIp,
      zone: v?.status?.zone,
      host: v?.status?.host,
      uniqueId: v?.status?.uniqueID,
      conditions: parseConditions(v?.status?.conditions),
    };
  } else if (statusOf(vm.reason) !== 404) {
    warnings.push(`VM unavailable: ${describeError(vm.reason)}`);
  }

  if (events.status === 'fulfilled') {
    detail.events = (events.value?.items ?? [])
      .filter((e: any) => (e?.involvedObject?.name ?? e?.regarding?.name) === machineName)
      .sort((a: any, b: any) => (eventTime(b) ?? '').localeCompare(eventTime(a) ?? ''))
      .slice(0, 50)
      .map(toEventInfo);
  } else {
    warnings.push(`Events unavailable: ${describeError(events.reason)}`);
  }
  return detail;
}

/* ---------------- Inside the workload cluster ---------------- */

export interface NodeDetail {
  ready?: boolean;
  cordoned: boolean;
  taints: string[];
  kubeletVersion?: string;
  capacity: { cpu?: string; memory?: string; pods?: string };
  allocatable: { cpu?: string; memory?: string; pods?: string };
  /** Pressure conditions that are True (MemoryPressure, DiskPressure, PIDPressure...). */
  pressure: string[];
  conditions: ClusterCondition[];
}

export interface NodePod {
  namespace: string;
  name: string;
  phase: string;
  reason?: string;
  ready: string;
  restarts: number;
  owner?: string;
  /** DaemonSet and static pods stay on the node during a drain. */
  daemonSet: boolean;
  /** PDB that currently allows no disruptions for this pod: it blocks a drain. */
  blockingPdb?: string;
  /** PDB that protects the pod but still allows a disruption. */
  protectedBy?: string;
  /** Why the pod keeps landing on this node even though it's being drained, if it does. */
  pinned?: string;
}

export interface NodeView {
  node?: NodeDetail;
  pods: NodePod[];
  warnings: string[];
}

export function nodeDetail(n: any): NodeDetail {
  const conds = parseConditions(n?.status?.conditions);
  return {
    ready: conds.find(c => c.type === 'Ready')?.status === 'True',
    cordoned: n?.spec?.unschedulable === true,
    taints: (n?.spec?.taints ?? []).map((t: any) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
    kubeletVersion: n?.status?.nodeInfo?.kubeletVersion,
    capacity: { cpu: n?.status?.capacity?.cpu, memory: n?.status?.capacity?.memory, pods: n?.status?.capacity?.pods },
    allocatable: {
      cpu: n?.status?.allocatable?.cpu,
      memory: n?.status?.allocatable?.memory,
      pods: n?.status?.allocatable?.pods,
    },
    pressure: conds.filter(c => c.type !== 'Ready' && c.status === 'True').map(c => c.type),
    conditions: conds,
  };
}

/**
 * Why a pod is tied to this node. A hostname nodeSelector or required affinity
 * is visible on the pod. A nodeName in the owner's template isn't, but it
 * shows up as a (non-DaemonSet) pod created after the node started draining:
 * the scheduler would never have put it on a cordoned node.
 */
export function pinReason(p: any, nodeName: string, drainStarted?: string): string | undefined {
  if (p?.spec?.nodeSelector?.['kubernetes.io/hostname'] === nodeName) return 'nodeSelector on kubernetes.io/hostname';
  const terms: any[] = p?.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? [];
  const byHost = terms.some(t =>
    (t?.matchExpressions ?? []).some(
      (e: any) => e?.key === 'kubernetes.io/hostname' && e?.operator === 'In' && (e?.values ?? []).includes(nodeName)
    )
  );
  if (byHost) return 'required node affinity on kubernetes.io/hostname';
  const created = p?.metadata?.creationTimestamp;
  if (drainStarted && created && new Date(created).getTime() > new Date(drainStarted).getTime()) {
    return 'recreated on this node after the drain started (likely nodeName in its owner\'s template)';
  }
  return undefined;
}

export function nodePods(pods: any[], pdbs: any[], nodeName = '', drainStarted?: string): NodePod[] {
  return pods
    .map(p => {
      const statuses: any[] = p?.status?.containerStatuses ?? [];
      const owner = (p?.metadata?.ownerReferences ?? []).find((o: any) => o?.controller) ?? p?.metadata?.ownerReferences?.[0];
      const waiting = statuses.map(s => s?.state?.waiting?.reason).find(Boolean);
      const ns = p?.metadata?.namespace ?? '';
      const labels = p?.metadata?.labels ?? {};
      const phase: string = p?.status?.phase ?? 'Unknown';
      // A drain leaves DaemonSet and static (mirror) pods alone and doesn't evict finished pods,
      // so a PDB can only block the rest.
      const staysOnNode = owner?.kind === 'DaemonSet' || owner?.kind === 'Node';
      const evicted = !staysOnNode && phase !== 'Succeeded' && phase !== 'Failed';
      const matching = pdbs.filter(b => b?.metadata?.namespace === ns && matchesSelector(b?.spec?.selector, labels));
      const blocking = evicted ? matching.find(b => (b?.status?.disruptionsAllowed ?? 0) === 0) : undefined;
      return {
        namespace: ns,
        name: p?.metadata?.name ?? '',
        phase,
        reason: waiting ?? p?.status?.reason,
        ready: `${statuses.filter(s => s?.ready).length}/${statuses.length || (p?.spec?.containers ?? []).length}`,
        restarts: statuses.reduce((n, s) => n + (typeof s?.restartCount === 'number' ? s.restartCount : 0), 0),
        owner: owner ? `${owner.kind}/${owner.name}` : undefined,
        daemonSet: staysOnNode,
        blockingPdb: blocking?.metadata?.name,
        protectedBy: blocking ? undefined : matching[0]?.metadata?.name,
        pinned: staysOnNode ? undefined : pinReason(p, nodeName, drainStarted),
      };
    })
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        Number(!!b.blockingPdb) - Number(!!a.blockingPdb) ||
        a.namespace.localeCompare(b.namespace) ||
        a.name.localeCompare(b.name)
    );
}

export async function fetchNodeView(
  client: SupervisorClient,
  nodeName: string,
  drainStarted?: string
): Promise<NodeView> {
  const [node, pods, pdbs] = await Promise.allSettled([
    client.get<any>(`/api/v1/nodes/${encodeURIComponent(nodeName)}`),
    client.get<any>(`/api/v1/pods?fieldSelector=${encodeURIComponent(`spec.nodeName=${nodeName}`)}`),
    client.get<any>('/apis/policy/v1/poddisruptionbudgets'),
  ]);
  const warnings: string[] = [];
  const view: NodeView = { pods: [], warnings };
  if (node.status === 'fulfilled') {
    view.node = nodeDetail(node.value);
  } else if (statusOf(node.reason) === 404) {
    warnings.push('The node no longer exists in the cluster.');
  } else {
    warnings.push(`Node unavailable: ${describeError(node.reason)}`);
  }
  const pdbList = pdbs.status === 'fulfilled' ? pdbs.value?.items ?? [] : [];
  if (pdbs.status === 'rejected') warnings.push(`PodDisruptionBudgets unavailable: ${describeError(pdbs.reason)}`);
  if (pods.status === 'fulfilled') {
    view.pods = nodePods(pods.value?.items ?? [], pdbList, nodeName, drainStarted);
  } else {
    warnings.push(`Pods unavailable: ${describeError(pods.reason)}`);
  }
  return view;
}
