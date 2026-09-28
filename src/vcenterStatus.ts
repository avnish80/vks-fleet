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

export interface VcenterStatus {
  collectedAt: string;
  vcenter?: string;
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
export function matchSupervisor(status: VcenterStatus, s: SupervisorConfig, configuredCount: number): VcSupervisor | undefined {
  const names = [s.headlampCluster, s.headlampCluster.replace(/-admin$/, '')];
  const host = (e: string) => e.replace(/^https?:\/\//, '').replace(/:\d+$/, '');
  const byEndpoint = status.supervisors.find(v => v.apiEndpoints.some(e => names.includes(host(e))));
  if (byEndpoint) return byEndpoint;
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
