/**
 * Namespace limits and org quotas.
 *
 * With VCF Automation, a namespace's limits come from its SupervisorNamespace
 * (class plus overrides: CPU limit in MHz, memory limit, storage per class,
 * allowed VM classes, per zone), and the org's storage quota from
 * RegionStorageClassQuota; both are only readable through VCF Automation.
 * Namespaces managed in vCenter record their limits on the namespace
 * (vmware-system-resource-pool-cpu-limit / -memory-limit).
 *
 * Limits cap what VMs actually use; best-effort VM classes reserve nothing,
 * so "configured" can exceed the limit: the overcommit ratio says how far.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { classSize } from './headroom';
import { parseQuantity } from './quantity';
import { Inventory, SupervisorResult } from './types';

export interface NamespaceLimits {
  namespace: string;
  source: 'vcfa' | 'supervisor';
  className?: string;
  cpuLimitMHz?: number;
  cpuReservationMHz?: number;
  memoryLimitBytes?: number;
  memoryReservationBytes?: number;
  storage: Array<{ storageClass: string; limitBytes: number }>;
  vmClasses: string[];
  zones: string[];
  project?: string;
  endpoint?: string;
}

export interface OrgQuota {
  org: string;
  region?: string;
  storage: Array<{ storageClass: string; capacityBytes: number; allocatedBytes: number; zones: string[] }>;
  vmClasses: Array<{ vmClass: string; limit?: number; used?: number }>;
}

/** vSphere CPU limits are MHz: "20000M" or "20000" = 20,000 MHz, "20G" = 20,000 MHz. */
export function parseMHz(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*([\d.]+)\s*(M|MHz|G|GHz)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  return /^g/i.test(m[2] ?? '') ? n * 1000 : n;
}

/** Memory limits: "20000Mi" style quantities, or a bare number meaning MiB. */
export function parseMemory(v: unknown): number | undefined {
  if (typeof v === 'number') return v * 2 ** 20;
  if (typeof v !== 'string' || /unset/i.test(v)) return undefined;
  return /^\s*[\d.]+\s*$/.test(v) ? Number(v) * 2 ** 20 : parseQuantity(v);
}

export function parseSupervisorNamespace(o: any): NamespaceLimits {
  const st = o?.status ?? {};
  const spec = o?.spec ?? {};
  const zones: any[] = st.zones ?? spec.classConfigOverrides?.zones ?? [];
  const sum = (f: (z: any) => number | undefined) => {
    const vals = zones.map(f).filter((x): x is number => x !== undefined);
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
  };
  const storage: any[] = st.storageClasses ?? spec.classConfigOverrides?.storageClasses ?? [];
  return {
    namespace: o?.metadata?.name ?? '',
    source: 'vcfa',
    className: spec.className,
    cpuLimitMHz: sum(z => parseMHz(z?.cpuLimit)),
    cpuReservationMHz: sum(z => parseMHz(z?.cpuReservation)),
    memoryLimitBytes: sum(z => parseMemory(z?.memoryLimit)),
    memoryReservationBytes: sum(z => parseMemory(z?.memoryReservation)),
    storage: storage
      .map(s => ({ storageClass: String(s?.name ?? ''), limitBytes: parseMemory(s?.limit) ?? 0 }))
      .filter(s => s.storageClass),
    vmClasses: (st.vmClasses ?? []).map((c: any) => String(c?.name ?? '')).filter(Boolean),
    zones: zones.map(z => String(z?.name ?? '')).filter(Boolean),
    project: o?.metadata?.namespace,
    endpoint: st.namespaceEndpointURL,
  };
}

export function parseOrgQuota(org: string, storage: any[], vmClassQuotas: any[]): OrgQuota {
  return {
    org,
    region: storage[0]?.spec?.regionName,
    storage: storage.map(q => ({
      storageClass: String(q?.spec?.storageClassName ?? ''),
      capacityBytes: parseMemory(q?.spec?.storageCapacity) ?? 0,
      allocatedBytes: parseMemory(q?.status?.storageConsumed) ?? 0,
      zones: (q?.spec?.zones ?? []).map((z: any) => String(z?.name ?? '')),
    })),
    vmClasses: vmClassQuotas.map(q => ({
      vmClass: String(q?.spec?.virtualMachineClassName ?? q?.spec?.vmClassName ?? q?.metadata?.name ?? ''),
      limit: typeof q?.spec?.limit === 'number' ? q.spec.limit : Number(q?.spec?.limit) || undefined,
      used: typeof q?.status?.used === 'number' ? q.status.used : Number(q?.status?.used ?? q?.status?.consumed) || undefined,
    })),
  };
}

/** Limits a vCenter-managed namespace records as annotations ("<unset>" when none). */
export function annotationLimits(annotations: Record<string, string> | undefined): { cpuMHz?: number; memoryBytes?: number } | undefined {
  const cpu = parseMHz(annotations?.['vmware-system-resource-pool-cpu-limit']);
  const mem = parseMemory(annotations?.['vmware-system-resource-pool-memory-limit']);
  return cpu !== undefined || mem !== undefined ? { cpuMHz: cpu, memoryBytes: mem } : undefined;
}

async function firstServed(client: SupervisorClient, paths: string[]): Promise<any[]> {
  let last: unknown;
  for (const p of paths) {
    try {
      return (await client.get<{ items?: any[] }>(p))?.items ?? [];
    } catch (err) {
      last = err;
      if (statusOf(err) !== 404) throw err;
    }
  }
  throw last;
}

const CCI = '/apis/infrastructure.cci.vmware.com';

/** Reads an org's namespace limits and storage quota through its org-level VCFA context. */
export async function fetchOrgLimits(
  client: SupervisorClient,
  org: string,
  projects: string[]
): Promise<{ limits: NamespaceLimits[]; quota?: OrgQuota; error?: string; expired?: boolean }> {
  try {
    const nsLists = await Promise.all(
      projects.map(p =>
        firstServed(client, ['v1alpha3', 'v1alpha2', 'v1alpha1'].map(v => `${CCI}/${v}/namespaces/${encodeURIComponent(p)}/supervisornamespaces`))
      )
    );
    const [storage, vmq] = await Promise.all([
      firstServed(client, [`${CCI}/v1alpha1/regionstorageclassquotas`]).catch(() => [] as any[]),
      firstServed(client, [`${CCI}/v1alpha1/regionvirtualmachineclassquotas`]).catch(() => [] as any[]),
    ]);
    return { limits: nsLists.flat().map(parseSupervisorNamespace), quota: parseOrgQuota(org, storage, vmq) };
  } catch (err) {
    return { limits: [], error: describeError(err), expired: statusOf(err) === 401 };
  }
}

export interface Configured {
  vcpu: number;
  memoryBytes: number;
  /** Memory reserved by guaranteed VM classes. */
  reservedBytes: number;
}

/** What a namespace's VMs are configured with: cluster nodes plus VM Service VMs, by VM class size. */
export function configuredByNamespace(results: SupervisorResult[], inventories: Map<string, Inventory> | null): Map<string, Configured> {
  const out = new Map<string, Configured>();
  const add = (ns: string, cpus = 0, mem = 0, reserved = 0) => {
    const c = out.get(ns) ?? { vcpu: 0, memoryBytes: 0, reservedBytes: 0 };
    c.vcpu += cpus;
    c.memoryBytes += mem;
    c.reservedBytes += reserved;
    out.set(ns, c);
  };
  for (const r of results) {
    const classes = r.vmClasses ?? [];
    for (const c of r.clusters) {
      for (const m of c.machines.filter(x => !x.deletingSince)) {
        const size = classSize(classes, c.namespace, m.vm?.className);
        add(c.namespace, m.vm?.cpus ?? size?.cpus, m.vm?.memoryBytes ?? size?.memoryBytes, size?.reserved ? size.memoryBytes ?? 0 : 0);
      }
    }
    for (const v of inventories?.get(r.supervisor.id)?.vms.filter(x => !x.cluster) ?? []) {
      const size = classSize(classes, v.namespace, v.className);
      add(v.namespace, size?.cpus, size?.memoryBytes, size?.reserved ? size.memoryBytes ?? 0 : 0);
    }
  }
  return out;
}

export const overcommit = (configured: number, limit?: number) => (limit ? configured / limit : undefined);
