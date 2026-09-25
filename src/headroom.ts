/**
 * Headroom: how much room a Supervisor namespace has left under its quota,
 * what adding nodes of a VM class would take, and how much extra a rolling
 * upgrade needs while it replaces nodes (one extra node per pool and one for
 * the control plane at a time).
 */
import { parseQuantity } from './quantity';
import { FleetCluster, QuotaItem, SupervisorResult, VmClassInfo } from './types';

export type QuotaKind = 'cpu' | 'memory' | 'storage';

export interface QuotaLine {
  resource: string;
  kind: QuotaKind;
  used: number;
  hard: number;
  free: number;
}

export function quotaKind(resource: string): QuotaKind | undefined {
  if (/(^|\.)cpu$/.test(resource)) return 'cpu';
  if (/(^|\.)memory$/.test(resource)) return 'memory';
  if (/storage$/.test(resource)) return 'storage';
  return undefined;
}

export function quotaLines(items: QuotaItem[] | undefined): QuotaLine[] {
  return (items ?? [])
    .map(q => {
      const kind = quotaKind(q.resource);
      const used = parseQuantity(q.used);
      const hard = parseQuantity(q.hard);
      return kind && used !== undefined && hard !== undefined
        ? { resource: q.resource, kind, used, hard, free: Math.max(0, hard - used) }
        : undefined;
    })
    .filter((x): x is QuotaLine => !!x);
}

export interface Delta {
  cpus: number;
  memoryBytes: number;
}

export interface FitLine {
  resource: string;
  kind: QuotaKind;
  needed: number;
  free: number;
  fits: boolean;
}

/** Whether a delta fits each CPU and memory quota line. No lines means no quota to hit. */
export function fits(lines: QuotaLine[], delta: Delta): FitLine[] {
  return lines
    .filter(l => l.kind !== 'storage')
    .map(l => {
      const needed = l.kind === 'cpu' ? delta.cpus : delta.memoryBytes;
      return { resource: l.resource, kind: l.kind, needed, free: l.free, fits: needed <= l.free };
    });
}

export function classSize(classes: VmClassInfo[], namespace: string, name?: string): VmClassInfo | undefined {
  if (!name) return undefined;
  return classes.find(c => c.namespace === namespace && c.name === name) ?? classes.find(c => c.name === name);
}

/** Extra capacity held while a rolling upgrade replaces nodes: one new node per pool, plus one control-plane node. */
export function upgradeSurge(c: FleetCluster, classes: VmClassInfo[]): Delta & { parts: string[]; unknown: string[] } {
  let cpus = 0;
  let memoryBytes = 0;
  const parts: string[] = [];
  const unknown: string[] = [];
  const add = (label: string, cls?: string) => {
    const size = classSize(classes, c.namespace, cls);
    if (size?.cpus !== undefined && size.memoryBytes !== undefined) {
      cpus += size.cpus;
      memoryBytes += size.memoryBytes;
      parts.push(`${label} (${cls})`);
    } else {
      unknown.push(label);
    }
  };
  const cpClass = c.machines.find(m => m.role === 'control-plane')?.vm?.className;
  if (c.controlPlane && c.controlPlane.desired > 0) add('control plane', cpClass);
  for (const p of c.nodePools) {
    if ((p.desired ?? p.ready) > 0) add(`pool ${p.name}`, p.vmClass ?? c.machines.find(m => m.pool === p.name)?.vm?.className);
  }
  return { cpus, memoryBytes, parts, unknown };
}

export interface NamespaceHeadroom {
  supervisorId: string;
  namespace: string;
  tenantName: string;
  clusters: FleetCluster[];
  quota: QuotaLine[];
  classes: VmClassInfo[];
  /** Capacity of the clusters' nodes in this namespace. */
  used: Delta;
}

/** One entry per Supervisor namespace that holds clusters. */
export function namespaceHeadroom(results: SupervisorResult[]): NamespaceHeadroom[] {
  const out: NamespaceHeadroom[] = [];
  for (const r of results) {
    const byNs = new Map<string, FleetCluster[]>();
    for (const c of r.clusters) byNs.set(c.namespace, [...(byNs.get(c.namespace) ?? []), c]);
    for (const [ns, cs] of byNs) {
      out.push({
        supervisorId: r.supervisor.id,
        namespace: ns,
        tenantName: cs[0].tenantName,
        clusters: cs,
        quota: quotaLines(cs[0].quota),
        classes: (r.vmClasses ?? []).filter(v => v.namespace === ns).sort((a, b) => (a.cpus ?? 0) - (b.cpus ?? 0)),
        used: cs.reduce((d, c) => ({ cpus: d.cpus + (c.capacity?.cpus ?? 0), memoryBytes: d.memoryBytes + (c.capacity?.memoryBytes ?? 0) }), {
          cpus: 0,
          memoryBytes: 0,
        }),
      });
    }
  }
  return out.sort((a, b) => a.tenantName.localeCompare(b.tenantName) || a.namespace.localeCompare(b.namespace));
}
