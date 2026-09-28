/**
 * Comparing, from each cluster's Prometheus:
 *  - right-sizing: what workloads ask for against what they use (p95 over
 *    the last week), and what that means for the number of worker nodes and
 *    the namespace's memory overcommit;
 *  - the same app across clusters: one workload, several clusters, very
 *    different behaviour.
 */
import { SupervisorClient } from './api/client';
import { Configured, NamespaceLimits, overcommit } from './limits';
import { Endpoint, instant, Sample } from './observability';
import { FleetCluster, VmClassInfo } from './types';
import { isPlatformNamespace } from './workload';

const SAFE = '[bcdfghjklmnpqrstvwxz2456789]';

/** The workload a pod belongs to, from its name (Deployment pods: name-<hash>-<id>; StatefulSet: name-<n>; DaemonSet: name-<id>). */
export function podOwner(pod: string): string {
  // Kubernetes builds generated suffixes from a "safe" alphabet without vowels (and without 0, 1, 3),
  // so a word like "exporter" is never mistaken for a ReplicaSet hash.
  const deploy = new RegExp(`^(.*)-${SAFE}{6,10}-${SAFE}{5}$`).exec(pod);
  if (deploy) return deploy[1];
  const sts = /^(.*)-\d+$/.exec(pod);
  if (sts) return sts[1];
  const ds = new RegExp(`^(.*)-${SAFE}{5}$`).exec(pod);
  return ds ? ds[1] : pod;
}

const imageRepo = (image: string) => image.replace(/@sha256:.*$/, '').replace(/:[^/:]+$/, '');
const imageTag = (image: string) => (/@sha256:/.test(image) ? 'digest' : /:([^/:]+)$/.exec(image)?.[1] ?? 'latest');

const byWorkload = (samples: Sample[]) => {
  const m = new Map<string, { value: number; pods: number }>();
  for (const s of samples) {
    if (!s.labels.namespace || !s.labels.pod) continue;
    const k = `${s.labels.namespace}/${podOwner(s.labels.pod)}`;
    const cur = m.get(k) ?? { value: 0, pods: 0 };
    cur.value += s.value;
    cur.pods += 1;
    m.set(k, cur);
  }
  return m;
};

/* ---------------- Right-sizing ---------------- */

export interface WorkloadSizing {
  workload: string;
  namespace: string;
  pods: number;
  cpuRequest: number;
  cpuP95: number;
  memRequest: number;
  memP95: number;
  /** Suggested requests: p95 plus 30% headroom (with small floors). */
  cpuSuggest: number;
  memSuggest: number;
  verdict: 'over' | 'under' | 'ok';
}

export interface ClusterSizing {
  requestedMem: number;
  p95Mem: number;
  requestedCpu: number;
  p95Cpu: number;
  /** One worker pool: how many nodes the suggested requests need. */
  pool?: { name: string; vmClass?: string; nodes: number; suggestedNodes: number; nodeMem: number };
  /** Memory freed in the namespace if the pool shrank, and overcommit before and after. */
  freedMem?: number;
  overcommitBefore?: number;
  overcommitAfter?: number;
}

export interface RightSizing {
  /** Hours of history the answers rest on. */
  historyHours?: number;
  workloads: WorkloadSizing[];
  cluster?: ClusterSizing;
}

const HEADROOM = 1.3;
const CPU_FLOOR = 0.01;
const MEM_FLOOR = 32 * 2 ** 20;
const PER_NODE_SYSTEM = 1.5 * 2 ** 30; // kubelet, CNI, CSI and system pods, per node

export const SIZING_QUERIES = {
  cpuP95: 'quantile_over_time(0.95, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m]))[7d:30m])',
  memP95: 'quantile_over_time(0.95, sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"})[7d:30m])',
  cpuReq: 'sum by (namespace, pod) (kube_pod_container_resource_requests{resource="cpu"})',
  memReq: 'sum by (namespace, pod) (kube_pod_container_resource_requests{resource="memory"})',
  history: 'time() - min(prometheus_tsdb_lowest_timestamp_seconds)',
};

export function sizeWorkloads(cpuP95: Sample[], memP95: Sample[], cpuReq: Sample[], memReq: Sample[]): WorkloadSizing[] {
  const [cu, mu, cr, mr] = [byWorkload(cpuP95), byWorkload(memP95), byWorkload(cpuReq), byWorkload(memReq)];
  const out: WorkloadSizing[] = [];
  for (const [k, req] of cr) {
    const [namespace, workload] = [k.split('/')[0], k.slice(k.indexOf('/') + 1)];
    if (isPlatformNamespace(namespace)) continue;
    const cpuP = cu.get(k)?.value ?? 0;
    const memP = mu.get(k)?.value ?? 0;
    const memR = mr.get(k)?.value ?? 0;
    const cpuSuggest = Math.max(CPU_FLOOR * req.pods, cpuP * HEADROOM);
    const memSuggest = Math.max(MEM_FLOOR * req.pods, memP * HEADROOM);
    const over = (req.value > 2 * cpuSuggest && req.value - cpuSuggest >= 0.2) || (memR > 2 * memSuggest && memR - memSuggest >= 256 * 2 ** 20);
    const under = (req.value > 0 && cpuP > req.value) || (memR > 0 && memP > memR);
    out.push({ workload, namespace, pods: req.pods, cpuRequest: req.value, cpuP95: cpuP, memRequest: memR, memP95: memP, cpuSuggest, memSuggest, verdict: under ? 'under' : over ? 'over' : 'ok' });
  }
  return out.sort((a, b) => b.memRequest - b.memSuggest - (a.memRequest - a.memSuggest));
}

/**
 * How many workers the cluster needs if over-sized workloads asked for what
 * they use (only for a single worker pool, where the answer is clear), and
 * what that frees in the namespace.
 */
export function sizeCluster(
  c: FleetCluster,
  classes: VmClassInfo[],
  cpuReqAll: Sample[],
  memReqAll: Sample[],
  cpuP95All: Sample[],
  memP95All: Sample[],
  workloads: WorkloadSizing[],
  limits?: NamespaceLimits,
  configured?: Configured
): ClusterSizing {
  const sum = (s: Sample[]) => s.reduce((n, x) => n + x.value, 0);
  const out: ClusterSizing = { requestedMem: sum(memReqAll), p95Mem: sum(memP95All), requestedCpu: sum(cpuReqAll), p95Cpu: sum(cpuP95All) };
  const pools = c.nodePools ?? [];
  if (pools.length !== 1) return out;
  const pool = pools[0];
  const size = classes.find(v => v.namespace === c.namespace && v.name === pool.vmClass);
  if (!size?.memoryBytes || !pool.desired) return out;
  const saved = workloads.filter(w => w.verdict === 'over').reduce((n, w) => n + Math.max(0, w.memRequest - w.memSuggest), 0);
  const nodeAlloc = size.memoryBytes * 0.9 - PER_NODE_SYSTEM;
  const need = out.requestedMem - saved;
  const suggestedNodes = Math.max(2, Math.ceil(need / Math.max(nodeAlloc, 1)));
  out.pool = { name: pool.name, vmClass: pool.vmClass, nodes: pool.desired, suggestedNodes: Math.min(pool.desired, suggestedNodes), nodeMem: size.memoryBytes };
  if (suggestedNodes < pool.desired) {
    out.freedMem = (pool.desired - suggestedNodes) * size.memoryBytes;
    if (limits?.memoryLimitBytes && configured) {
      out.overcommitBefore = overcommit(configured.memoryBytes, limits.memoryLimitBytes);
      out.overcommitAfter = overcommit(configured.memoryBytes - out.freedMem, limits.memoryLimitBytes);
    }
  }
  return out;
}

export async function fetchRightSizing(
  client: SupervisorClient,
  prom: Endpoint,
  c: FleetCluster,
  classes: VmClassInfo[],
  limits?: NamespaceLimits,
  configured?: Configured
): Promise<RightSizing> {
  const q = (x: string) => instant(client, prom, x).catch(() => [] as Sample[]);
  const [cpuP95, memP95, cpuReq, memReq, hist] = await Promise.all([q(SIZING_QUERIES.cpuP95), q(SIZING_QUERIES.memP95), q(SIZING_QUERIES.cpuReq), q(SIZING_QUERIES.memReq), q(SIZING_QUERIES.history)]);
  const workloads = sizeWorkloads(cpuP95, memP95, cpuReq, memReq);
  return {
    historyHours: hist[0] ? Math.round(hist[0].value / 3600) : undefined,
    workloads,
    cluster: memReq.length ? sizeCluster(c, classes, cpuReq, memReq, cpuP95, memP95, workloads, limits, configured) : undefined,
  };
}

/* ---------------- The same app across clusters ---------------- */

export interface AppUsage {
  cluster: string;
  namespace: string;
  workload: string;
  image: string;
  tag: string;
  replicas: number;
  cpuPerReplica: number;
  memPerReplica: number;
  restarts24h: number;
}

export interface AppComparison {
  app: string;
  repo: string;
  rows: AppUsage[];
  notes: string[];
}

export const APP_QUERIES = {
  info: 'count by (namespace, pod, image) (kube_pod_container_info{container!="POD"})',
  cpu: 'sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[1h]))',
  mem: 'sum by (namespace, pod) (avg_over_time(container_memory_working_set_bytes{container!="",container!="POD"}[1h]))',
  restarts: 'sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[24h]))',
};

export function appUsage(cluster: string, info: Sample[], cpu: Sample[], mem: Sample[], restarts: Sample[]): AppUsage[] {
  const imageOf = new Map<string, string>();
  for (const s of info) if (s.labels.namespace && s.labels.pod && s.labels.image) imageOf.set(`${s.labels.namespace}/${s.labels.pod}`, s.labels.image);
  const val = (list: Sample[]) => new Map(list.map(s => [`${s.labels.namespace}/${s.labels.pod}`, s.value]));
  const [c, m, r] = [val(cpu), val(mem), val(restarts)];
  const groups = new Map<string, AppUsage>();
  for (const [pod, image] of imageOf) {
    const [ns, name] = [pod.split('/')[0], pod.slice(pod.indexOf('/') + 1)];
    if (isPlatformNamespace(ns)) continue;
    const workload = podOwner(name);
    const k = `${ns}/${workload}`;
    const g = groups.get(k) ?? { cluster, namespace: ns, workload, image, tag: imageTag(image), replicas: 0, cpuPerReplica: 0, memPerReplica: 0, restarts24h: 0 };
    g.replicas += 1;
    g.cpuPerReplica += c.get(pod) ?? 0;
    g.memPerReplica += m.get(pod) ?? 0;
    g.restarts24h += r.get(pod) ?? 0;
    groups.set(k, g);
  }
  return Array.from(groups.values()).map(g => ({ ...g, cpuPerReplica: g.cpuPerReplica / g.replicas, memPerReplica: g.memPerReplica / g.replicas, restarts24h: Math.round(g.restarts24h) }));
}

/** Apps (same workload name and image) running in more than one cluster, with what stands out. */
export function compareApps(all: AppUsage[]): AppComparison[] {
  const groups = new Map<string, AppUsage[]>();
  for (const u of all) {
    const k = `${u.workload}|${imageRepo(u.image)}`;
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  const out: AppComparison[] = [];
  for (const [k, rows] of groups) {
    if (new Set(rows.map(r => r.cluster)).size < 2) continue;
    const notes: string[] = [];
    const min = (f: (r: AppUsage) => number) => Math.min(...rows.map(f));
    for (const [label, f] of [
      ['CPU', (r: AppUsage) => r.cpuPerReplica],
      ['memory', (r: AppUsage) => r.memPerReplica],
    ] as Array<[string, (r: AppUsage) => number]>) {
      const lo = min(f);
      for (const r of rows) if (lo > 0 && f(r) > 2 * lo) notes.push(`${r.cluster} uses ${(f(r) / lo).toFixed(1)}× the ${label} per replica of the lowest cluster`);
    }
    const restarting = rows.filter(r => r.restarts24h > 0);
    if (restarting.length && restarting.length < rows.length) notes.push(`Restarts only in ${restarting.map(r => r.cluster).join(', ')}`);
    const tags = new Set(rows.map(r => r.tag));
    if (tags.size > 1) notes.push(`Different versions: ${Array.from(tags).join(', ')}`);
    out.push({ app: k.split('|')[0], repo: k.split('|')[1], rows: rows.sort((a, b) => a.cluster.localeCompare(b.cluster)), notes });
  }
  return out.sort((a, b) => b.notes.length - a.notes.length || a.app.localeCompare(b.app));
}

export async function fetchAppUsage(client: SupervisorClient, prom: Endpoint, cluster: string): Promise<AppUsage[]> {
  const q = (x: string) => instant(client, prom, x).catch(() => [] as Sample[]);
  const [info, cpu, mem, restarts] = await Promise.all([q(APP_QUERIES.info), q(APP_QUERIES.cpu), q(APP_QUERIES.mem), q(APP_QUERIES.restarts)]);
  return appUsage(cluster, info, cpu, mem, restarts);
}
