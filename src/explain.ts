/**
 * The walk-down: from a pod or node through every layer VKS stacks under it
 * (node, Machine, VM, ESXi host, namespace, Supervisor), each with its state,
 * and the deepest unhealthy layer named as the likely one: a problem low in
 * the stack usually explains everything above it. Plus host patterns across
 * a cluster ("3 of 4 problem nodes are VMs on the same host").
 */
import { NamespaceLimits, overcommit } from './limits';
import { shortHost, shortNode } from './names';
import { FleetCluster, Inventory, WorkloadHealth } from './types';

export type LayerState = 'ok' | 'warn' | 'bad' | 'unknown';

export interface Layer {
  layer: 'Pod' | 'Node' | 'Machine' | 'VM' | 'Host' | 'Namespace' | 'Supervisor';
  name: string;
  state: LayerState;
  facts: string[];
}

export interface WalkDown {
  layers: Layer[];
  /** The deepest layer in trouble. */
  likely?: Layer;
  summary: string;
}

export interface WalkInput {
  cluster: FleetCluster;
  node: string;
  pod?: { namespace: string; name: string };
  workload?: WorkloadHealth;
  inventory?: Inventory;
  /** Supervisor nodes (ESXi hosts) by name, with Ready. */
  hosts?: Array<{ name: string; ready: boolean }>;
  limits?: NamespaceLimits;
  configured?: { memoryBytes: number; vcpu: number };
  supervisorScore?: number;
  /** VM name → ESXi host, when VM Operator doesn't report it (the vCenter collector's placement). */
  hostOf?: (vmName: string) => string | undefined;
}

export function walkDown(i: WalkInput): WalkDown {
  const layers: Layer[] = [];
  const w = i.workload;
  if (i.pod) {
    const issue = w?.podIssues.find(p => p.namespace === i.pod!.namespace && p.name === i.pod!.name);
    layers.push({ layer: 'Pod', name: `${i.pod.namespace}/${i.pod.name}`, state: issue ? 'bad' : w ? 'ok' : 'unknown', facts: issue ? [issue.reason] : w ? ['No problem reported'] : ['Cluster not readable'] });
  }
  // Node, as the cluster sees it.
  const onNode = (w?.podIssues ?? []).filter(p => p.node === i.node);
  const sandbox = (w?.sandboxFailures ?? []).find(s => s.node === i.node);
  const nodeFacts: string[] = [];
  if (onNode.length) nodeFacts.push(`${onNode.length} pod${onNode.length === 1 ? '' : 's'} with problems on this node`);
  if (sandbox) nodeFacts.push(`Pod networking failing here (${sandbox.pods} pod${sandbox.pods === 1 ? '' : 's'}, ${sandbox.attempts} attempts): ${sandbox.error}`);
  const short = (n: string) => shortNode(i.cluster.name, n);
  layers.push({ layer: 'Node', name: short(i.node), state: sandbox ? 'bad' : onNode.length > 1 ? 'warn' : w ? 'ok' : 'unknown', facts: nodeFacts.length ? nodeFacts : ['Nothing reported'] });
  // Machine (Cluster API).
  const m = i.cluster.machines.find(x => x.nodeName === i.node || x.name === i.node);
  if (m) {
    const facts = [`${m.phase}${m.ready ? ', ready' : ''}`];
    if (m.deletingSince) facts.push(`Deleting since ${new Date(m.deletingSince).toLocaleString()} (a drain may be blocked)`);
    if (m.failureDomain) facts.push(`Failure domain ${m.failureDomain}`);
    layers.push({ layer: 'Machine', name: short(m.name), state: m.deletingSince || m.phase === 'Failed' ? 'bad' : !m.ready || m.phase !== 'Running' ? 'warn' : 'ok', facts });
  }
  // VM (VM Operator): VKS names a node's VM after its Machine.
  const vm = (i.inventory?.vms ?? []).find(v => v.name === (m?.name ?? i.node) && v.namespace === i.cluster.namespace);
  if (vm) {
    const facts = [`${vm.power ?? 'power unknown'}${vm.className ? `, class ${vm.className}` : ''}${vm.zone ? `, zone ${vm.zone}` : ''}`];
    if (vm.readyMessage) facts.push(vm.readyMessage);
    layers.push({ layer: 'VM', name: short(vm.name), state: vm.power && vm.power !== 'PoweredOn' ? 'bad' : vm.ready === false ? 'warn' : 'ok', facts });
  }
  // ESXi host.
  const hostName = vm?.host ?? i.hostOf?.(vm?.name ?? m?.name ?? i.node);
  if (hostName) {
    const h = i.hosts?.find(x => x.name === hostName);
    const where = (v: { name: string; host?: string }) => v.host ?? i.hostOf?.(v.name);
    const neighbours = (i.inventory?.vms ?? []).filter(v => where(v) === hostName && v.name !== (vm?.name ?? m?.name));
    layers.push({
      layer: 'Host',
      name: shortHost(hostName),
      state: h ? (h.ready ? 'ok' : 'bad') : 'unknown',
      facts: [h ? (h.ready ? 'Ready' : 'NOT Ready (as the Supervisor sees it)') : 'Not in the Supervisor\u2019s node list', `${neighbours.length} other VM${neighbours.length === 1 ? '' : 's'} on this host`],
    });
  }
  // Namespace: limits and overcommit.
  const oc = i.limits?.memoryLimitBytes && i.configured ? overcommit(i.configured.memoryBytes, i.limits.memoryLimitBytes) : undefined;
  layers.push({
    layer: 'Namespace',
    name: i.cluster.namespace,
    state: oc === undefined ? 'unknown' : oc > 4 ? 'bad' : oc > 1.5 ? 'warn' : 'ok',
    facts: oc !== undefined ? [`Memory configured ${oc.toFixed(1)}× the namespace limit${oc > 1 ? ': VMs compete for memory under load' : ''}`] : ['No memory limit recorded'],
  });
  if (i.supervisorScore !== undefined) {
    layers.push({ layer: 'Supervisor', name: i.cluster.supervisorId, state: i.supervisorScore >= 90 ? 'ok' : i.supervisorScore >= 70 ? 'warn' : 'bad', facts: [`Health ${i.supervisorScore}/100`] });
  }
  const troubled = layers.filter(l => l.state === 'bad');
  const likely = troubled[troubled.length - 1] ?? layers.filter(l => l.state === 'warn').slice(-1)[0];
  return {
    layers,
    likely,
    summary: likely ? `The deepest layer in trouble is the ${likely.layer.toLowerCase()} (${likely.name}): ${likely.facts[0]}.` : 'Every layer that could be read looks healthy.',
  };
}

export interface HostPattern {
  host: string;
  problemNodes: string[];
  totalProblemNodes: number;
}

/** Problem nodes concentrated on one ESXi host (two or more, and most of them). */
export function hostPatterns(cluster: FleetCluster, workload: WorkloadHealth | undefined, inventory: Inventory | undefined, hostOfVm?: (vmName: string) => string | undefined): HostPattern[] {
  const problemNodes = new Set<string>([...(workload?.podIssues ?? []).map(p => p.node).filter((n): n is string => !!n), ...(workload?.sandboxFailures ?? []).map(s => s.node)]);
  for (const m of cluster.machines) if (m.deletingSince || !m.ready) problemNodes.add(m.nodeName ?? m.name);
  const hostOf = (node: string) => {
    const m = cluster.machines.find(x => x.nodeName === node || x.name === node);
    const name = m?.name ?? node;
    return (inventory?.vms ?? []).find(v => v.name === name && v.namespace === cluster.namespace)?.host ?? hostOfVm?.(name);
  };
  const byHost = new Map<string, string[]>();
  for (const n of problemNodes) {
    const h = hostOf(n);
    if (h) byHost.set(h, [...(byHost.get(h) ?? []), n]);
  }
  return Array.from(byHost.entries())
    .filter(([, nodes]) => nodes.length >= 2 && nodes.length / problemNodes.size > 0.5)
    .map(([host, nodes]) => ({ host, problemNodes: nodes.sort(), totalProblemNodes: problemNodes.size }));
}
