/**
 * The Supervisor's own view from vCenter, as the vCenter collector wrote it
 * (deploy/collector): Workload Management status and messages, control-plane
 * VMs, Supervisor Services, ESXi hosts, and alarms when collected.
 */
import { describeError, SupervisorClient } from './api/client';
import { Issue, SupervisorConfig } from './types';

export interface VcMessage {
  severity: string;
  text: string;
}

export interface VcSupervisor {
  id: string;
  name?: string;
  configStatus: string;
  kubernetesStatus: string;
  messages: VcMessage[];
  apiEndpoints: string[];
  controlPlaneVMs: Array<{ name: string; power?: string; cpus?: number; memoryMiB?: number }>;
  hosts: Array<{ name: string; connection?: string; power?: string }>;
  services: Array<{ id: string; version?: string; state: string; messages?: VcMessage[] }>;
  alarms: Array<{ entity: string; name: string; status: string; time?: string; acknowledged?: boolean }>;
}

export interface VcEntity {
  kind: 'vm' | 'host';
  name: string;
  supervisor: string;
  cpuPct?: number;
  memPct?: number;
  diskKBps?: number;
  netKBps?: number;
  disks?: Array<{ path: string; capacityBytes: number; freeBytes: number }>;
}

/** One history sample: per entity [cpu %, memory %, disk KB/s, network KB/s, fullest disk %]. */
export interface VcSample {
  t: string;
  v: Record<string, Array<number | null>>;
}

export interface VcMetrics {
  sampledAt: string;
  entities: VcEntity[];
  history: VcSample[];
}

export interface VcenterStatus {
  collectedAt: string;
  vcenter?: string;
  metrics?: VcMetrics;
  supervisors: VcSupervisor[];
  errors: string[];
  notes?: string[];
}

export interface VcenterRead {
  status?: VcenterStatus;
  /** Minutes since the collector last wrote. */
  ageMinutes?: number;
  error?: string;
}

export const STALE_MINUTES = 15;

export function parseStatus(cm: any): VcenterStatus | undefined {
  try {
    const s = JSON.parse(cm?.data?.['status.json'] ?? '');
    return s && Array.isArray(s.supervisors) ? { errors: [], ...s } : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchVcenterStatus(client: SupervisorClient, namespace: string, name: string, now: Date = new Date()): Promise<VcenterRead> {
  try {
    const status = parseStatus(await client.get(`/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`));
    if (!status) return { error: `${namespace}/${name} isn't a collector ConfigMap (no status.json).` };
    return { status, ageMinutes: Math.max(0, Math.round((now.getTime() - new Date(status.collectedAt).getTime()) / 60000)) };
  } catch (err) {
    return { error: `Couldn't read ${namespace}/${name}: ${describeError(err)}` };
  }
}

/**
 * vCenter's record for a Supervisor: by its API address (a kubectl vsphere
 * context is named after it), or the only one when there's only one of each.
 */
export function matchSupervisor(status: VcenterStatus, s: SupervisorConfig, configuredCount: number, hostNames?: string[]): VcSupervisor | undefined {
  const names = [s.headlampCluster, s.headlampCluster.replace(/-admin$/, '')];
  const host = (e: string) => e.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const byEndpoint = status.supervisors.find(v => v.apiEndpoints.some(e => names.includes(host(e))));
  if (byEndpoint) return byEndpoint;
  // The Supervisor's ESXi hosts are also its nodes, with the same names: the most reliable match.
  if (hostNames?.length) {
    const byHosts = status.supervisors.find(v => v.hosts.some(h => hostNames.includes(h.name)));
    if (byHosts) return byHosts;
  }
  return status.supervisors.length === 1 && configuredCount === 1 ? status.supervisors[0] : undefined;
}

const okConfig = (x: string) => x === 'RUNNING';
const okKube = (x: string) => x === 'READY';
const okService = (x: string) => ['CONFIGURED', 'RUNNING', 'READY'].includes(x);
const hostOk = (h: VcSupervisor['hosts'][number]) => h.connection === 'CONNECTED' && (!h.power || h.power === 'POWERED_ON');
const redAlarms = (v: VcSupervisor) => v.alarms.filter(a => a.status === 'red' && !a.acknowledged);

/** Points off the Supervisor health score for what vCenter reports. */
export function vcenterPenalty(v: VcSupervisor): number {
  let p = 0;
  if (v.configStatus === 'ERROR') p += 40;
  else if (!okConfig(v.configStatus)) p += 10;
  if (v.kubernetesStatus === 'ERROR') p += 30;
  else if (!okKube(v.kubernetesStatus)) p += 10;
  p += 40 * v.controlPlaneVMs.filter(x => x.power && x.power !== 'POWERED_ON').length;
  p += 5 * v.services.filter(x => !okService(x.state)).length;
  p += Math.min(20, 10 * redAlarms(v).length);
  return p;
}

export function vcenterIssues(v: VcSupervisor, supervisorId: string, supervisorName: string, now: Date = new Date()): Issue[] {
  const base = {
    supervisorId,
    affected: { clusters: [], tenants: [], nodes: [], pods: [] },
    links: [],
    findingIds: [],
    detectedAt: now.toISOString(),
    primary: { label: 'Supervisor health', path: '/vks-fleet/supervisor-health' },
  };
  const out: Issue[] = [];
  if (!okConfig(v.configStatus) || !okKube(v.kubernetesStatus)) {
    const error = v.configStatus === 'ERROR' || v.kubernetesStatus === 'ERROR';
    out.push({
      ...base,
      id: `${supervisorId}#vcenter-status`,
      severity: error ? 'critical' : 'warning',
      title: `vCenter reports ${supervisorName}: configuration ${v.configStatus.toLowerCase()}, Kubernetes ${v.kubernetesStatus.toLowerCase()}`,
      cause: 'From vCenter\u2019s Workload Management view of the Supervisor (collected by the vCenter collector).',
      evidence: v.messages.slice(0, 6).map(m => `${m.severity}: ${m.text}`),
      fix: 'Open Workload Management in vCenter for the full messages and the Supervisor\u2019s events.',
    });
  }
  for (const vm of v.controlPlaneVMs.filter(x => x.power && x.power !== 'POWERED_ON')) {
    out.push({ ...base, id: `${supervisorId}#vcenter-cpvm#${vm.name}`, severity: 'critical', title: `Supervisor control-plane VM ${vm.name} is ${String(vm.power).toLowerCase().replace('_', ' ')}`, cause: 'The Supervisor API and its controllers run on the control-plane VMs.', evidence: [], fix: 'Check the VM in vCenter; Workload Management normally restarts control-plane VMs itself.' });
  }
  const services = v.services.filter(x => !okService(x.state));
  if (services.length) {
    out.push({
      ...base,
      id: `${supervisorId}#vcenter-services`,
      severity: services.some(x => x.state === 'ERROR') ? 'warning' : 'info',
      title: `${services.length} Supervisor Service${services.length === 1 ? '' : 's'} not configured on ${supervisorName} (vCenter)`,
      cause: 'vCenter reports these Supervisor Services in a state other than configured.',
      evidence: services.map(x => `${x.id}${x.version ? ` ${x.version}` : ''}: ${x.state}${x.messages?.[0] ? ` (${x.messages[0].text})` : ''}`),
      fix: 'Workload Management → Services in vCenter shows the details and lets you retry or update.',
    });
  }
  const red = redAlarms(v);
  if (red.length) {
    out.push({
      ...base,
      id: `${supervisorId}#vcenter-alarms`,
      severity: 'warning',
      title: `${red.length} red alarm${red.length === 1 ? '' : 's'} on ${supervisorName}'s cluster, hosts or control plane`,
      cause: 'Triggered, unacknowledged alarms in vCenter.',
      evidence: red.slice(0, 6).map(a => `${a.entity}: ${a.name}`),
      fix: 'Resolve or acknowledge them in vCenter.',
    });
  }
  return out;
}

export const vcHostOk = hostOk;
export const vcServiceOk = okService;

/* ---------------- Utilisation ---------------- */

export const METRIC_INDEX = { cpuPct: 0, memPct: 1, diskKBps: 2, netKBps: 3, diskFullPct: 4 } as const;

/** Entities (control-plane VMs, hosts) of one Supervisor. */
export function entitiesFor(m: VcMetrics | undefined, supervisorId: string): VcEntity[] {
  return (m?.entities ?? []).filter(e => e.supervisor === supervisorId);
}

/** Chart series from the history: one per entity, for one metric. */
export function historySeries(m: VcMetrics | undefined, names: string[], metric: keyof typeof METRIC_INDEX): Array<{ labels: Record<string, string>; points: Array<[number, number]> }> {
  const idx = METRIC_INDEX[metric];
  return names
    .map(name => ({
      labels: { name },
      points: (m?.history ?? [])
        .map(h => [new Date(h.t).getTime(), h.v[name]?.[idx]] as [number, number | null | undefined])
        .filter((p): p is [number, number] => typeof p[1] === 'number'),
    }))
    .filter(s => s.points.length);
}

/** The fullest disk of an entity, now. */
export const fullestDisk = (e: VcEntity) => {
  const disks = (e.disks ?? []).filter(d => d.capacityBytes > 0);
  if (!disks.length) return undefined;
  return disks.map(d => ({ path: d.path, pct: 100 * (1 - d.freeBytes / d.capacityBytes) })).sort((a, b) => b.pct - a.pct)[0];
};

/** Seconds until a disk is full, from the trend of its fullness over the history (at least an hour of it). */
export function diskForecast(m: VcMetrics | undefined, name: string): number | undefined {
  const pts = historySeries(m, [name], 'diskFullPct')[0]?.points ?? [];
  if (pts.length < 4 || pts[pts.length - 1][0] - pts[0][0] < 3600e3) return undefined;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / (pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) || 1); // % per ms
  if (slope <= 0) return undefined;
  const last = pts[n - 1];
  return Math.max(0, ((100 - last[1]) / slope) / 1000);
}

/** Points off the health score for hot or full control-plane VMs and hosts. */
export function utilisationPenalty(entities: VcEntity[]): number {
  let p = 0;
  for (const e of entities) {
    if (e.kind === 'vm') {
      const d = fullestDisk(e)?.pct ?? 0;
      if (d > 90) p += 20;
      else if (d > 80) p += 10;
      if ((e.memPct ?? 0) > 90) p += 10;
    } else if ((e.cpuPct ?? 0) > 90 || (e.memPct ?? 0) > 90) p += 5;
  }
  return Math.min(35, p);
}

export function utilisationIssues(entities: VcEntity[], m: VcMetrics | undefined, supervisorId: string, supervisorName: string, now: Date = new Date()): Issue[] {
  const base = {
    supervisorId,
    affected: { clusters: [], tenants: [], nodes: [], pods: [] },
    links: [],
    findingIds: [],
    detectedAt: now.toISOString(),
    primary: { label: 'Supervisor health', path: '/vks-fleet/supervisor-health' },
  };
  const out: Issue[] = [];
  for (const e of entities.filter(x => x.kind === 'vm')) {
    const d = fullestDisk(e);
    const eta = diskForecast(m, e.name);
    if (d && (d.pct > 80 || (eta !== undefined && eta < 7 * 86400))) {
      out.push({
        ...base,
        id: `${supervisorId}#cpvm-disk#${e.name}`,
        severity: d.pct > 90 || (eta !== undefined && eta < 2 * 86400) ? 'critical' : 'warning',
        title: `${e.name} disk ${d.path} is ${d.pct.toFixed(0)}% full${eta !== undefined ? ` (full in about ${eta < 86400 ? `${Math.round(eta / 3600)} h` : `${Math.round(eta / 86400)} days`})` : ''}`,
        cause: 'The Supervisor control-plane VM holds etcd and the API server; a full disk stops the whole Supervisor.',
        evidence: (e.disks ?? []).map(x => `${x.path}: ${(100 * (1 - x.freeBytes / x.capacityBytes)).toFixed(0)}% of ${(x.capacityBytes / 2 ** 30).toFixed(0)} GiB`),
        fix: 'Check for log or image growth on the control-plane VM with VMware support guidance; do not resize it by hand.',
      });
    }
    if ((e.memPct ?? 0) > 90) {
      out.push({ ...base, id: `${supervisorId}#cpvm-mem#${e.name}`, severity: 'warning', title: `${e.name} memory is ${e.memPct!.toFixed(0)}% used`, cause: 'The control-plane VM is close to its memory; the API server and controllers slow down or restart under pressure.', evidence: [], fix: 'Look at what grew (objects, namespaces, clusters); the Supervisor’s control-plane size (small, medium, large) is set in Workload Management.' });
    }
  }
  const hot = entities.filter(x => x.kind === 'host' && ((x.cpuPct ?? 0) > 90 || (x.memPct ?? 0) > 90));
  if (hot.length) {
    out.push({
      ...base,
      id: `${supervisorId}#hosts-hot`,
      severity: 'warning',
      title: `${hot.length} ESXi host${hot.length === 1 ? '' : 's'} above 90% on ${supervisorName}: ${hot.map(h => h.name).join(', ')}`,
      cause: 'Hosts this busy cannot absorb a failover, and VMs on them (cluster nodes among them) compete for resources.',
      evidence: hot.map(h => `${h.name}: CPU ${h.cpuPct ?? '?'}%, memory ${h.memPct ?? '?'}%`),
      fix: 'Spread VMs across hosts (DRS, or the Supervisor service placement), or add capacity.',
    });
  }
  return out;
}

