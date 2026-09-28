/**
 * Creating VMs and clusters in a Supervisor namespace, with the effect on
 * the namespace's capacity shown first, and the same manifests available as
 * YAML for GitOps instead of applying them.
 *
 * Requests go through the Supervisor (or VCF Automation's namespace proxy for
 * tenants), so the platform's own quotas, VM class assignments and policies
 * still apply; the preview only helps decide.
 */
import { ActionPlan, Check } from './actions';
import { WriteRequest } from './api/client';
import { Delta, fits, QuotaLine } from './headroom';
import { Configured, NamespaceLimits, overcommit } from './limits';
import { VmClassInfo } from './types';

export const VMOP_API = 'vmoperator.vmware.com/v1alpha5';
const CAPI = 'cluster.x-k8s.io/v1beta1';
const JSON_CT = 'application/json';
const DNS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/* ---------------- VMs ---------------- */

export interface VmInput {
  namespace: string;
  name: string;
  className: string;
  /** VM image resource name (vmi-…). */
  image: string;
  /** Namespaced image, or one shared across the Supervisor. */
  imageKind: 'VirtualMachineImage' | 'ClusterVirtualMachineImage';
  storageClass?: string;
  /** A subnet or subnet set; empty uses the namespace's default network. */
  network?: { kind: 'Subnet' | 'SubnetSet'; name: string };
  /** A public SSH key for the default user (cloud-init). */
  sshKey?: string;
  user?: string;
  powerOn: boolean;
}

export function cloudConfig(user: string, sshKey: string): string {
  return [
    '#cloud-config',
    'users:',
    `  - name: ${user}`,
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    shell: /bin/bash',
    '    ssh_authorized_keys:',
    `      - ${sshKey.trim()}`,
    'ssh_pwauth: false',
    '',
  ].join('\n');
}

export function vmManifests(i: VmInput): any[] {
  const labels = { 'app.kubernetes.io/managed-by': 'vks-fleet' };
  const secretName = `${i.name}-cloud-init`;
  const docs: any[] = [];
  if (i.sshKey?.trim()) {
    docs.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace: i.namespace, labels }, stringData: { 'user-data': cloudConfig(i.user?.trim() || 'vmware', i.sshKey) } });
  }
  docs.push({
    apiVersion: VMOP_API,
    kind: 'VirtualMachine',
    metadata: { name: i.name, namespace: i.namespace, labels },
    spec: {
      className: i.className,
      image: { kind: i.imageKind, name: i.image },
      imageName: i.image,
      ...(i.storageClass ? { storageClass: i.storageClass } : {}),
      powerState: i.powerOn ? 'PoweredOn' : 'PoweredOff',
      ...(i.network ? { network: { interfaces: [{ name: 'eth0', network: { apiVersion: 'crd.nsx.vmware.com/v1alpha1', kind: i.network.kind, name: i.network.name } }] } } : {}),
      ...(i.sshKey?.trim() ? { bootstrap: { cloudInit: { rawCloudConfig: { name: secretName, key: 'user-data' } } } } : {}),
    },
  });
  return docs;
}

/* ---------------- Clusters ---------------- */

export interface PoolInput {
  name: string;
  replicas: number;
  vmClass: string;
}

export interface ClusterInput {
  namespace: string;
  name: string;
  version: string;
  controlPlaneReplicas: 1 | 3;
  pools: PoolInput[];
  /** A Cluster object to copy class, variables and networking from (recommended). */
  template?: any;
  /** From scratch (no template): the class and its common variables. */
  clusterClass?: string;
  classNamespace?: string;
  controlPlaneClass?: string;
  storageClass?: string;
}

const variable = (vars: any[], name: string) => vars.find(v => v?.name === name)?.value;

/** The VM class the template's workers use, for new pools that don't say. */
function templatePoolClass(t: any): string | undefined {
  const md = t?.spec?.topology?.workers?.machineDeployments?.[0];
  return md?.variables?.overrides?.find((o: any) => o?.name === 'vmClass')?.value ?? variable(t?.spec?.topology?.variables ?? [], 'vmClass');
}

export function clusterManifest(i: ClusterInput): any {
  const t = i.template;
  const topo = t?.spec?.topology ?? {};
  const mdClass = topo.workers?.machineDeployments?.[0]?.class ?? 'node-pool';
  const variables = t
    ? (topo.variables ?? []).map((v: any) => (v?.name === 'vmClass' && i.controlPlaneClass ? { ...v, value: i.controlPlaneClass } : v))
    : [
        ...(i.controlPlaneClass ? [{ name: 'vmClass', value: i.controlPlaneClass }] : []),
        ...(i.storageClass ? [{ name: 'storageClass', value: i.storageClass }] : []),
      ];
  return {
    apiVersion: CAPI,
    kind: 'Cluster',
    metadata: { name: i.name, namespace: i.namespace, labels: { 'app.kubernetes.io/managed-by': 'vks-fleet' } },
    spec: {
      clusterNetwork: t?.spec?.clusterNetwork ?? { pods: { cidrBlocks: ['192.168.156.0/20'] }, services: { cidrBlocks: ['10.96.0.0/12'] }, serviceDomain: 'cluster.local' },
      topology: {
        class: t ? topo.class : i.clusterClass,
        ...((t ? topo.classNamespace : i.classNamespace) ? { classNamespace: t ? topo.classNamespace : i.classNamespace } : {}),
        version: i.version,
        controlPlane: { replicas: i.controlPlaneReplicas },
        variables,
        workers: {
          machineDeployments: i.pools.map(p => ({ class: mdClass, name: p.name, replicas: p.replicas, variables: { overrides: [{ name: 'vmClass', value: p.vmClass }] } })),
        },
      },
    },
  };
}

/** What the cluster adds: control plane and workers, by VM class. */
export function clusterDelta(i: ClusterInput, classes: VmClassInfo[]): Delta & { unknown: string[] } {
  const size = (n?: string) => classes.find(c => c.namespace === i.namespace && c.name === n);
  const cpClass = i.controlPlaneClass ?? variable(i.template?.spec?.topology?.variables ?? [], 'vmClass') ?? templatePoolClass(i.template);
  const unknown: string[] = [];
  let cpus = 0;
  let memoryBytes = 0;
  const add = (cls: string | undefined, n: number, what: string) => {
    const s = size(cls);
    if (!s?.cpus || !s.memoryBytes) {
      unknown.push(`${what} (${cls ?? 'class not set'})`);
      return;
    }
    cpus += s.cpus * n;
    memoryBytes += s.memoryBytes * n;
  };
  add(cpClass, i.controlPlaneReplicas, 'control plane');
  for (const p of i.pools) add(p.vmClass, p.replicas, `pool ${p.name}`);
  return { cpus, memoryBytes, unknown };
}

/* ---------------- Impact on the namespace ---------------- */

export interface ImpactRow {
  resource: string;
  before: string;
  after: string;
  limit: string;
  status: 'ok' | 'warn' | 'over';
  note?: string;
}

const gib = (b: number) => `${(b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1)} GiB`;

export function impact(add: Delta & { reservedBytes?: number }, current: Configured | undefined, limits: NamespaceLimits | undefined, quota: QuotaLine[]): { rows: ImpactRow[]; checks: Check[] } {
  const cur = current ?? { vcpu: 0, memoryBytes: 0, reservedBytes: 0 };
  const rows: ImpactRow[] = [];
  const checks: Check[] = [];
  rows.push({
    resource: 'vCPU (configured)',
    before: String(cur.vcpu),
    after: String(cur.vcpu + add.cpus),
    limit: limits?.cpuLimitMHz ? `${(limits.cpuLimitMHz / 1000).toFixed(1)} GHz` : '—',
    status: 'ok',
    note: limits?.cpuLimitMHz ? 'CPU limits are in GHz; vCPUs share them when busy.' : undefined,
  });
  const memLimit = limits?.memoryLimitBytes;
  const before = overcommit(cur.memoryBytes, memLimit);
  const after = overcommit(cur.memoryBytes + add.memoryBytes, memLimit);
  rows.push({
    resource: 'Memory (configured)',
    before: `${gib(cur.memoryBytes)}${before ? ` (${before.toFixed(1)}×)` : ''}`,
    after: `${gib(cur.memoryBytes + add.memoryBytes)}${after ? ` (${after.toFixed(1)}×)` : ''}`,
    limit: memLimit ? gib(memLimit) : '—',
    status: after && after > 4 ? 'over' : after && after > 1 ? 'warn' : 'ok',
    note: after && after > 1 ? 'More memory configured than the limit: best-effort VMs still run, but compete for memory when busy.' : undefined,
  });
  if (after && after > 4) checks.push({ level: 'warn', text: `Memory would be ${after.toFixed(1)}× the namespace limit: expect contention and ballooning under load.` });
  else if (after && after > 1) checks.push({ level: 'warn', text: `Memory would be ${after.toFixed(1)}× the namespace limit (${before ? `${before.toFixed(1)}× now` : 'within it now'}).` });
  if (add.reservedBytes && memLimit && (limits?.memoryReservationBytes ?? 0) + add.reservedBytes > memLimit) {
    checks.push({ level: 'warn', text: 'The guaranteed (reserved) memory would exceed the namespace limit: the VM may fail to power on.' });
  }
  for (const f of fits(quota, add)) {
    rows.push({
      resource: `Quota: ${f.resource}`,
      before: f.kind === 'memory' ? gib(f.free) + ' free' : `${f.free} free`,
      after: f.kind === 'memory' ? gib(f.free - f.needed) + ' free' : `${f.free - f.needed} free`,
      limit: '',
      status: f.fits ? 'ok' : 'over',
    });
    if (!f.fits) checks.push({ level: 'warn', text: `Needs more ${f.resource} than the namespace quota has free; the Supervisor will likely refuse it.` });
  }
  if (!memLimit && !quota.length) checks.push({ level: 'ok', text: 'No CPU or memory limit is recorded for this namespace.' });
  return { rows, checks };
}

/* ---------------- Plans ---------------- */

const kindPath = (d: any) => {
  const [group, version] = String(d.apiVersion).includes('/') ? String(d.apiVersion).split('/') : ['', d.apiVersion];
  const plural = ({ Secret: 'secrets', VirtualMachine: 'virtualmachines', Cluster: 'clusters' } as Record<string, string>)[d.kind];
  return `${group ? `/apis/${group}/${version}` : '/api/v1'}/namespaces/${encodeURIComponent(d.metadata.namespace)}/${plural}`;
};

export function createPlan(what: 'VM' | 'cluster', docs: any[], name: string, namespace: string, checks: Check[], existingNames: string[]): ActionPlan {
  const all = [...checks];
  if (!DNS.test(name) || name.length > 41) all.unshift({ level: 'block', text: `The name "${name}" isn't valid: lowercase letters, digits and dashes, up to 41 characters.` });
  if (existingNames.includes(name)) all.unshift({ level: 'block', text: `A ${what} named ${name} already exists in ${namespace}.` });
  return {
    id: `create-${what}#${namespace}/${name}#${JSON.stringify(docs).length}`,
    title: `Create ${what} ${name}`,
    summary: `In ${namespace}. The Supervisor applies its own quotas and policies when it creates it.`,
    checks: all,
    reasonRequired: false,
    applyLabel: 'Create',
    requests: (reason: string): WriteRequest[] =>
      docs.map(d => ({
        method: 'POST' as const,
        path: kindPath(d),
        contentType: JSON_CT,
        body: reason ? { ...d, metadata: { ...d.metadata, annotations: { ...(d.metadata.annotations ?? {}), 'vks-fleet/reason': reason } } } : d,
      })),
  };
}

/* ---------------- YAML (for GitOps) ---------------- */

const plain = /^[A-Za-z0-9_./@-][A-Za-z0-9_ ./@:-]*$/;
const reserved = /^(true|false|null|yes|no|on|off|~|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/i;

function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s.includes('\n')) return `|\n${s.replace(/\n$/, '').split('\n').map(l => `  ${l}`).join('\n')}`;
  return plain.test(s) && !reserved.test(s) && !s.endsWith(':') && !s.includes(': ') ? s : JSON.stringify(s);
}

function emit(v: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return v
      .map(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const body = emit(item, indent + 1).replace(/^\n/, '');
          return `\n${pad}- ${body.slice(pad.length + 2)}`;
        }
        return `\n${pad}- ${scalar(item).replace(/\n/g, `\n${pad}  `)}`;
      })
      .join('');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return ' {}';
    return entries
      .map(([k, x]) => {
        const key = plain.test(k) && !reserved.test(k) ? k : JSON.stringify(k);
        if (x && typeof x === 'object') return `\n${pad}${key}:${emit(x, indent + 1)}`;
        return `\n${pad}${key}: ${scalar(x).replace(/\n/g, `\n${pad}`)}`;
      })
      .join('');
  }
  return ` ${scalar(v)}`;
}

/** Kubernetes manifests as YAML documents. */
export function toYaml(docs: any[]): string {
  return docs.map(d => emit(d, 0).replace(/^\n/, '')).join('\n---\n') + '\n';
}
