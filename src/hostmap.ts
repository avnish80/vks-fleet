/**
 * The Supervisor by ESXi host: what runs on each host (the control-plane VM,
 * Supervisor service pods, cluster nodes, VM Service VMs), its load and
 * alarms, and what a host failure would take down.
 *
 * VM placement comes from VM Operator's status.host when it reports it, and
 * otherwise from the vCenter collector.
 */
import { ServiceState } from './supervisorHealth';
import { FleetCluster, ServiceVm } from './types';

export interface HostCard {
  name: string;
  ready: boolean;
  /** vCenter's connection state, when known. */
  connection?: string;
  cpuPct?: number;
  memPct?: number;
  alarms: number;
  controlPlaneVms: string[];
  services: string[];
  clusters: Array<{ cluster: string; key: string; nodes: string[]; controlPlane: number }>;
  vms: string[];
}

export interface HostMapInput {
  hosts: Array<{ name: string; ready: boolean }>;
  vcHosts?: Array<{ name: string; connection?: string }>;
  load?: Array<{ name: string; kind: 'vm' | 'host'; cpuPct?: number; memPct?: number }>;
  alarms?: Array<{ entity: string; acknowledged?: boolean }>;
  controlPlaneVms?: string[];
  services: ServiceState[];
  clusters: FleetCluster[];
  vms: ServiceVm[];
  /** VM name → host (VM Operator's status.host, else the collector's placement). */
  hostOf: (vmName: string) => string | undefined;
}

export interface HostMap {
  cards: HostCard[];
  /** Cluster nodes and VMs whose host isn't known (no placement). */
  unplaced: number;
}

export function hostMap(i: HostMapInput): HostMap {
  const cards = new Map<string, HostCard>();
  for (const h of i.hosts) {
    const vc = i.vcHosts?.find(x => x.name === h.name);
    const load = i.load?.find(x => x.kind === 'host' && x.name === h.name);
    cards.set(h.name, {
      name: h.name,
      ready: h.ready,
      connection: vc?.connection,
      cpuPct: load?.cpuPct,
      memPct: load?.memPct,
      alarms: (i.alarms ?? []).filter(a => a.entity === h.name && !a.acknowledged).length,
      controlPlaneVms: [],
      services: [],
      clusters: [],
      vms: [],
    });
  }
  let unplaced = 0;
  for (const vm of i.controlPlaneVms ?? []) {
    const h = i.hostOf(vm);
    if (h && cards.has(h)) cards.get(h)!.controlPlaneVms.push(vm);
  }
  for (const s of i.services) {
    for (const h of new Set(s.running.map(p => p.host).filter((x): x is string => !!x))) if (cards.has(h)) cards.get(h)!.services.push(s.name);
  }
  for (const c of i.clusters) {
    for (const m of c.machines) {
      const h = i.hostOf(m.name);
      if (!h || !cards.has(h)) {
        unplaced += 1;
        continue;
      }
      const card = cards.get(h)!;
      let entry = card.clusters.find(x => x.key === c.key);
      if (!entry) card.clusters.push((entry = { cluster: c.name, key: c.key, nodes: [], controlPlane: 0 }));
      entry.nodes.push(m.nodeName ?? m.name);
      if (m.role === 'control-plane') entry.controlPlane += 1;
    }
  }
  for (const v of i.vms.filter(x => !x.cluster)) {
    const h = i.hostOf(v.name);
    if (!h || !cards.has(h)) {
      unplaced += 1;
      continue;
    }
    cards.get(h)!.vms.push(v.name);
  }
  for (const c of cards.values()) c.clusters.sort((a, b) => b.nodes.length - a.nodes.length || a.cluster.localeCompare(b.cluster));
  return { cards: Array.from(cards.values()).sort((a, b) => a.name.localeCompare(b.name)), unplaced };
}

export interface HostBlast {
  host: string;
  /** The Supervisor's control plane is on this host. */
  supervisorControlPlane: string[];
  /** Services with every running pod on this host: down until rescheduled. */
  servicesDown: string[];
  /** Services with pods here and elsewhere: keep running, with fewer pods. */
  servicesDegraded: string[];
  clusters: Array<{ cluster: string; nodes: number; total: number; controlPlaneLost: boolean }>;
  vms: string[];
}

/** What a failure of this host would take down, until vSphere HA restarts its VMs elsewhere. */
export function hostBlast(card: HostCard, services: ServiceState[], clusters: FleetCluster[]): HostBlast {
  const down: string[] = [];
  const degraded: string[] = [];
  for (const s of services) {
    const hosts = new Set(s.running.map(p => p.host));
    if (!hosts.has(card.name)) continue;
    (hosts.size === 1 ? down : degraded).push(s.name);
  }
  return {
    host: card.name,
    supervisorControlPlane: card.controlPlaneVms,
    servicesDown: down.sort(),
    servicesDegraded: degraded.sort(),
    clusters: card.clusters.map(x => {
      const c = clusters.find(k => k.key === x.key);
      const cpTotal = c?.machines.filter(m => m.role === 'control-plane').length ?? 0;
      return { cluster: x.cluster, nodes: x.nodes.length, total: c?.machines.length ?? x.nodes.length, controlPlaneLost: cpTotal > 0 && x.controlPlane >= cpTotal };
    }),
    vms: card.vms,
  };
}
