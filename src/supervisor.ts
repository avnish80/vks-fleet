/**
 * Supervisor-side data beyond Cluster API: the node VMs (VM Operator), VM
 * class sizes, namespace quotas, available ClusterClasses and the health of
 * Supervisor services. All read-only and all optional: anything that can't be
 * read is simply left out of the view.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { ListResult, scopedList } from './api/scopedList';
import { KubeObject } from './capi/v1beta1';
import { parseQuantity } from './quantity';
import { Capacity, FleetCluster, PodIssue, QuotaItem, ServiceHealth, VmInfo } from './types';
import { podIssues } from './workload';

/** Newest first; the first version the Supervisor serves is used. */
export const VMOP_VERSIONS = ['v1alpha5', 'v1alpha4', 'v1alpha3', 'v1alpha2'];
export const DEFAULT_CLASS_NAMESPACE = 'vmware-system-vks-public';

/** Lists a resource at the first API version the server serves (skipping 404s). */
export async function listFirstServed(
  client: SupervisorClient,
  group: string,
  versions: string[],
  plural: string,
  namespaces: string[]
): Promise<ListResult<KubeObject>> {
  let last: unknown;
  for (const v of versions) {
    try {
      return await scopedList<KubeObject>(client, `/apis/${group}/${v}`, plural, namespaces);
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
      last = err;
    }
  }
  throw last ?? new Error(`${plural} not served`);
}

/* ---------------- VMs and capacity ---------------- */

interface ClassSize {
  cpus?: number;
  memoryBytes?: number;
}

export function classSizes(classes: KubeObject[]): Map<string, ClassSize> {
  const m = new Map<string, ClassSize>();
  for (const c of classes) {
    const hw = c.spec?.hardware ?? {};
    const size = { cpus: parseQuantity(hw.cpus), memoryBytes: parseQuantity(hw.memory) };
    m.set(`${c.metadata.namespace ?? ''}/${c.metadata.name}`, size);
    if (!m.has(`*/${c.metadata.name}`)) m.set(`*/${c.metadata.name}`, size);
  }
  return m;
}

export function vmInfo(vm: KubeObject, sizes: Map<string, ClassSize>): VmInfo {
  const className: string | undefined = vm.spec?.className;
  const size = className
    ? sizes.get(`${vm.metadata.namespace ?? ''}/${className}`) ?? sizes.get(`*/${className}`)
    : undefined;
  return {
    powerState: vm.status?.powerState,
    className,
    ip: vm.status?.network?.primaryIP4 ?? vm.status?.vmIp,
    zone: vm.status?.zone ?? vm.metadata.labels?.['topology.kubernetes.io/zone'],
    cpus: size?.cpus,
    memoryBytes: size?.memoryBytes,
  };
}

/** Attaches each machine's VM (same name, same namespace) and totals the cluster's size. */
export function attachVms(clusters: FleetCluster[], vms: KubeObject[], classes: KubeObject[]): FleetCluster[] {
  if (vms.length === 0) return clusters;
  const sizes = classSizes(classes);
  const byName = new Map(vms.map(v => [`${v.metadata.namespace ?? ''}/${v.metadata.name}`, v]));
  return clusters.map(c => {
    let cpus = 0;
    let memoryBytes = 0;
    let nodesCounted = 0;
    const machines = c.machines.map(m => {
      const vm = byName.get(`${c.namespace}/${m.name}`);
      if (!vm) return m;
      const info = vmInfo(vm, sizes);
      if (!m.deletingSince && info.cpus !== undefined && info.memoryBytes !== undefined) {
        cpus += info.cpus;
        memoryBytes += info.memoryBytes;
        nodesCounted += 1;
      }
      return { ...m, vm: info, internalIP: m.internalIP ?? info.ip };
    });
    const capacity: Capacity | undefined = nodesCounted ? { cpus, memoryBytes, nodesCounted } : undefined;
    return { ...c, machines, capacity };
  });
}

/* ---------------- Quotas ---------------- */

export function quotaItems(quotas: KubeObject[]): QuotaItem[] {
  const items: QuotaItem[] = [];
  for (const q of quotas) {
    const hard: Record<string, string> = q.status?.hard ?? q.spec?.hard ?? {};
    const used: Record<string, string> = q.status?.used ?? {};
    for (const [resource, h] of Object.entries(hard)) {
      const u = used[resource] ?? '0';
      const hv = parseQuantity(h);
      const uv = parseQuantity(u);
      items.push({
        resource,
        hard: String(h),
        used: String(u),
        ratio: hv && uv !== undefined ? uv / hv : undefined,
      });
    }
  }
  return items.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
}

export function attachQuotas(clusters: FleetCluster[], quotas: KubeObject[]): FleetCluster[] {
  if (quotas.length === 0) return clusters;
  const byNs = new Map<string, KubeObject[]>();
  for (const q of quotas) {
    const ns = q.metadata.namespace ?? '';
    byNs.set(ns, [...(byNs.get(ns) ?? []), q]);
  }
  return clusters.map(c => {
    const qs = byNs.get(c.namespace);
    return qs ? { ...c, quota: quotaItems(qs) } : c;
  });
}

/* ---------------- ClusterClass currency ---------------- */

/** "builtin-generic-v3.7.0" → { family: "builtin-generic", version: [3, 7, 0] } */
export function parseClassName(name: string): { family: string; version: number[] } | null {
  const m = /^(.*)-v(\d+)\.(\d+)\.(\d+)$/.exec(name);
  return m ? { family: m[1], version: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/** Newest class of the same family, if newer than the current one. */
export function newerClass(current: string | undefined, available: string[]): string | undefined {
  const cur = current ? parseClassName(current) : null;
  if (!cur) return undefined;
  const newer = available
    .map(n => ({ n, p: parseClassName(n) }))
    .filter(x => x.p && x.p.family === cur.family && cmp(x.p.version, cur.version) > 0)
    .sort((a, b) => cmp(a.p!.version, b.p!.version));
  return newer.length ? newer[newer.length - 1].n : undefined;
}

export async function fetchClassNames(client: SupervisorClient, namespaces: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const ns of namespaces) {
    try {
      const list = await client.get<{ items?: KubeObject[] }>(
        `/apis/cluster.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(ns)}/clusterclasses`
      );
      for (const c of list?.items ?? []) names.add(c.metadata.name);
    } catch {
      // Unreadable class namespace: no class-update information.
    }
  }
  return Array.from(names);
}

export function attachClassUpdates(clusters: FleetCluster[], classNames: string[]): FleetCluster[] {
  if (classNames.length === 0) return clusters;
  return clusters.map(c => ({ ...c, classUpdate: newerClass(c.clusterClass, classNames) }));
}

/* ---------------- Supervisor services ---------------- */

const SERVICE_NAMES: Record<string, string> = {
  tkg: 'vSphere Kubernetes Service',
  velero: 'Velero',
  'cci-ns': 'Cloud Consumption Interface',
  'metrics-aggregator': 'Metrics aggregator',
  'auto-attach': 'Auto-attach',
  configuration: 'Configuration',
};

/** "svc-tkg-g6r11" → "vSphere Kubernetes Service"; unknown services keep their short name. */
export function serviceName(namespace: string): string {
  const short = namespace.replace(/^svc-/, '').replace(/-[a-z0-9]{5}$/, '');
  return SERVICE_NAMES[short] ?? short;
}

function ownerOf(pod: any): string | undefined {
  const refs: any[] = pod?.metadata?.ownerReferences ?? [];
  const ref = refs.find(o => o?.controller) ?? refs[0];
  return ref?.uid ?? (ref ? `${ref.kind}/${ref.name}` : undefined);
}

/**
 * Splits a service's pod problems into real ones and left-overs: a Failed pod
 * whose owner (ReplicaSet, StatefulSet, ...) already has a Running pod was
 * replaced and is just waiting to be cleaned up.
 */
export function servicePodHealth(pods: any[], now: Date): { problems: PodIssue[]; leftovers: number } {
  const runningOwners = new Set(pods.filter(p => p?.status?.phase === 'Running').map(ownerOf).filter(Boolean));
  let leftovers = 0;
  const live: any[] = [];
  for (const p of pods) {
    const owner = ownerOf(p);
    if (p?.status?.phase === 'Failed' && owner && runningOwners.has(owner)) {
      leftovers += 1;
    } else {
      live.push(p);
    }
  }
  return { problems: podIssues(live, now), leftovers };
}

export async function fetchServices(
  client: SupervisorClient,
  namespaceNames: string[],
  now: Date
): Promise<{ services: ServiceHealth[]; warnings: string[] }> {
  const svc = namespaceNames.filter(n => n.startsWith('svc-')).sort();
  const settled = await Promise.allSettled(
    svc.map(ns => client.get<{ items?: any[] }>(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods`))
  );
  const services: ServiceHealth[] = [];
  const warnings: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const pods = r.value?.items ?? [];
      const { problems, leftovers } = servicePodHealth(pods, now);
      services.push({ namespace: svc[i], name: serviceName(svc[i]), pods: pods.length, problems, leftovers });
    } else {
      warnings.push(`Couldn't read Supervisor service ${svc[i]}: ${describeError(r.reason)}`);
    }
  });
  return { services, warnings };
}
