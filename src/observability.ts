/**
 * Observability from each cluster's own Prometheus and Alertmanager, queried
 * through the Kubernetes API's service proxy: the same connection and
 * permissions as everything else, no new endpoints or credentials.
 *
 * Finds the stack, runs a curated set of queries (each with fallbacks for
 * different exporters), forecasts when things run out, and turns active
 * alerts into issues.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { FleetCluster, Issue } from './types';

/* ---------------- Finding the stack ---------------- */

export interface Endpoint {
  namespace: string;
  service: string;
  port: string;
}

export interface MonitoringStack {
  prometheus?: Endpoint;
  alertmanager?: Endpoint;
  grafana?: Endpoint;
  nodeExporter: boolean;
  kubeStateMetrics: boolean;
}

const PROM = [/^prometheus-server$/, /-kube-prometheus-prometheus$/, /^prometheus-k8s$/, /^prometheus$/, /^prometheus-operated$/];
const ALERT = [/^alertmanager$/, /-kube-prometheus-alertmanager$/, /^alertmanager-main$/, /^alertmanager-operated$/];

function pickPort(svc: any, preferred: number[]): string | undefined {
  const ports: any[] = svc?.spec?.ports ?? [];
  const named = ports.find(p => ['web', 'http', 'http-web'].includes(p?.name));
  const num = ports.find(p => preferred.includes(Number(p?.port)));
  const p = named ?? num ?? ports[0];
  return p ? String(p.port) : undefined;
}

function find(services: any[], patterns: RegExp[], ports: number[]): Endpoint | undefined {
  for (const re of patterns) {
    const svc = services.find(s => re.test(String(s?.metadata?.name ?? '')));
    const port = svc && pickPort(svc, ports);
    if (svc && port) return { namespace: svc.metadata.namespace, service: svc.metadata.name, port };
  }
  return undefined;
}

export function discoverStack(services: any[]): MonitoringStack {
  const names = services.map(s => String(s?.metadata?.name ?? ''));
  return {
    prometheus: find(services, PROM, [9090, 80]),
    alertmanager: find(services, ALERT, [9093, 80]),
    grafana: find(services, [/grafana$/], [80, 3000]),
    nodeExporter: names.some(n => /node-exporter/.test(n)),
    kubeStateMetrics: names.some(n => /kube-state-metrics/.test(n)),
  };
}

export const proxyBase = (e: Endpoint) => `/api/v1/namespaces/${encodeURIComponent(e.namespace)}/services/${encodeURIComponent(e.service)}:${e.port}/proxy`;

/* ---------------- Queries ---------------- */

export interface Sample {
  labels: Record<string, string>;
  value: number;
}
export interface Series {
  labels: Record<string, string>;
  points: Array<[number, number]>;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export function parseVector(res: any): Sample[] {
  const r = res?.data?.result;
  if (res?.data?.resultType === 'scalar') return [{ labels: {}, value: num(r?.[1]) }];
  return Array.isArray(r) ? r.map((x: any) => ({ labels: x?.metric ?? {}, value: num(x?.value?.[1]) })).filter((x: Sample) => !Number.isNaN(x.value)) : [];
}

export function parseMatrix(res: any): Series[] {
  const r = res?.data?.result;
  return Array.isArray(r)
    ? r.map((x: any) => ({ labels: x?.metric ?? {}, points: (x?.values ?? []).map((p: any) => [Number(p[0]) * 1000, num(p[1])] as [number, number]).filter((p: [number, number]) => !Number.isNaN(p[1])) }))
    : [];
}

const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_MS = 60_000;

/** Caches per cluster; a client without a name (so no safe key) is never cached. */
async function cached<T>(key: string | undefined, load: () => Promise<T>, now = Date.now()): Promise<T> {
  if (!key) return load();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: now, value });
  return value;
}

export function instant(client: SupervisorClient, prom: Endpoint, query: string): Promise<Sample[]> {
  const path = `${proxyBase(prom)}/api/v1/query?query=${encodeURIComponent(query)}`;
  return cached(client.name && `${client.name}|${path}`, async () => parseVector(await client.get(path)));
}

export const RANGES = { '1h': 3600, '24h': 86400, '7d': 7 * 86400 } as const;
export type Range = keyof typeof RANGES;

export function range(client: SupervisorClient, prom: Endpoint, query: string, r: Range, now = Date.now()): Promise<Series[]> {
  const end = Math.floor(now / 60000) * 60; // a minute boundary, so cache keys repeat
  const start = end - RANGES[r];
  const step = Math.max(30, Math.round(RANGES[r] / 120));
  const path = `${proxyBase(prom)}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&step=${step}`;
  return cached(client.name && `${client.name}|${path}`, async () => parseMatrix(await client.get(path)));
}

/** The first query that returns data (exporters name things differently). */
export async function firstWith<T extends unknown[]>(queries: string[], run: (q: string) => Promise<T>): Promise<{ query?: string; data: T | [] }> {
  for (const q of queries) {
    try {
      const d = await run(q);
      if (d.length) return { query: q, data: d };
    } catch (err) {
      if (statusOf(err) === 401 || statusOf(err) === 403) throw err;
    }
  }
  return { data: [] };
}

/* ---------------- Panels ---------------- */

export type Unit = 'percent' | 'bytes' | 'seconds' | 'rate' | 'count';

export interface Panel {
  id: string;
  title: string;
  unit: Unit;
  queries: string[];
  /** Series label from its labels. */
  legend: (l: Record<string, string>) => string;
  /** What collects it, for "not collected" hints. */
  needs: string;
  /** Limit for a warning colour, in the panel's unit. */
  warnAbove?: number;
}

const ROOT_FS = 'mountpoint="/",fstype!~"tmpfs|overlay|squashfs"';
const nodeName = (l: Record<string, string>) => (l.node ?? l.instance ?? '').replace(/:\d+$/, '');

export const PANELS: Panel[] = [
  { id: 'node-cpu', title: 'Node CPU', unit: 'percent', needs: 'node-exporter', warnAbove: 85, legend: nodeName, queries: ['100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))'] },
  { id: 'node-mem', title: 'Node memory', unit: 'percent', needs: 'node-exporter', warnAbove: 90, legend: nodeName, queries: ['100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)'] },
  { id: 'node-disk', title: 'Node disk (/)', unit: 'percent', needs: 'node-exporter', warnAbove: 85, legend: nodeName, queries: [`100 * (1 - node_filesystem_avail_bytes{${ROOT_FS}} / node_filesystem_size_bytes{${ROOT_FS}})`] },
  {
    id: 'api-latency',
    title: 'API server latency (p99)',
    unit: 'seconds',
    needs: 'API server metrics',
    warnAbove: 1,
    legend: () => 'p99',
    queries: ['histogram_quantile(0.99, sum by (le) (rate(apiserver_request_duration_seconds_bucket{verb!~"WATCH|CONNECT"}[5m])))'],
  },
  { id: 'api-errors', title: 'API server errors (5xx)', unit: 'rate', needs: 'API server metrics', warnAbove: 0.5, legend: () => '5xx/s', queries: ['sum(rate(apiserver_request_total{code=~"5.."}[5m]))'] },
  { id: 'etcd-size', title: 'etcd database size', unit: 'bytes', needs: 'etcd metrics', legend: l => nodeName(l) || 'etcd', queries: ['max by (instance) (etcd_mvcc_db_total_size_in_bytes)', 'max by (instance) (etcd_debugging_mvcc_db_total_size_in_bytes)'] },
  { id: 'restarts', title: 'Container restarts (per hour)', unit: 'count', needs: 'kube-state-metrics', warnAbove: 3, legend: l => `${l.namespace}/${l.pod}`, queries: ['topk(6, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h]))) > 0'] },
  { id: 'top-cpu', title: 'Busiest pods (CPU cores)', unit: 'rate', needs: 'cAdvisor (kubelet)', legend: l => `${l.namespace}/${l.pod}`, queries: ['topk(6, sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))'] },
  { id: 'pvc-fill', title: 'Volume fill', unit: 'percent', needs: 'kubelet volume stats', warnAbove: 85, legend: l => `${l.namespace}/${l.persistentvolumeclaim}`, queries: ['topk(8, 100 * kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes)'] },
  { id: 'net-errors', title: 'Network errors', unit: 'rate', needs: 'node-exporter', warnAbove: 1, legend: nodeName, queries: ['sum by (instance) (rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m]))'] },
];

/* ---------------- Forecasts ---------------- */

export interface Forecast {
  what: 'volume' | 'node disk' | 'etcd' | 'node memory';
  subject: string;
  /** Seconds until it runs out, at the last 6 hours' rate. */
  seconds: number;
}

const HORIZON = 14 * 86400;
const falling = (m: string) => `(${m} / -deriv(${m}[6h])) and (deriv(${m}[6h]) < 0) < ${HORIZON}`;

export const FORECASTS: Array<{ what: Forecast['what']; query: string; subject: (l: Record<string, string>) => string }> = [
  { what: 'volume', query: falling('kubelet_volume_stats_available_bytes'), subject: l => `${l.namespace}/${l.persistentvolumeclaim}` },
  { what: 'node disk', query: falling(`node_filesystem_avail_bytes{${ROOT_FS}}`), subject: nodeName },
  {
    what: 'etcd',
    query: `((max by (instance) (etcd_server_quota_backend_bytes) - max by (instance) (etcd_mvcc_db_total_size_in_bytes)) / max by (instance) (deriv(etcd_mvcc_db_total_size_in_bytes[6h]))) and (max by (instance) (deriv(etcd_mvcc_db_total_size_in_bytes[6h])) > 0) < ${HORIZON}`,
    subject: l => nodeName(l) || 'etcd',
  },
  { what: 'node memory', query: `${falling('node_memory_MemAvailable_bytes')} and (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.25)`, subject: nodeName },
];

export const humanDuration = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < 2 * 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

/* ---------------- Alerts ---------------- */

export interface Alert {
  name: string;
  severity: 'critical' | 'warning' | 'info';
  summary?: string;
  namespace?: string;
  since?: string;
}

const QUIET = new Set(['Watchdog', 'InfoInhibitor']);

export function parseAlerts(items: any[]): Alert[] {
  return (Array.isArray(items) ? items : [])
    .filter(a => !QUIET.has(a?.labels?.alertname) && (a?.status?.state ?? 'active') === 'active')
    .map(a => {
      const sev = String(a?.labels?.severity ?? '').toLowerCase();
      return {
        name: String(a?.labels?.alertname ?? 'Alert'),
        severity: sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'info',
        summary: a?.annotations?.summary ?? a?.annotations?.description ?? a?.annotations?.message,
        namespace: a?.labels?.namespace,
        since: a?.startsAt,
      } as Alert;
    });
}

/* ---------------- One cluster's summary ---------------- */

export interface ObservabilitySummary {
  clusterKey: string;
  clusterName: string;
  contextName: string;
  stack: MonitoringStack;
  /** Prometheus answered. */
  reachable: boolean;
  version?: string;
  kpis: Partial<Record<'nodeCpu' | 'nodeMem' | 'apiP99' | 'api5xx' | 'restarts', number>>;
  forecasts: Forecast[];
  alerts: Alert[];
  alertsReadable: boolean;
  error?: string;
}

const KPI_QUERIES: Record<keyof ObservabilitySummary['kpis'], string> = {
  nodeCpu: 'max(100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))))',
  nodeMem: 'max(100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))',
  apiP99: PANELS.find(p => p.id === 'api-latency')!.queries[0],
  api5xx: 'sum(rate(apiserver_request_total{code=~"5.."}[5m]))',
  restarts: 'sum(increase(kube_pod_container_status_restarts_total[1h]))',
};

export async function fetchSummary(client: SupervisorClient, clusterKey: string, clusterName: string, contextName: string): Promise<ObservabilitySummary> {
  const base: ObservabilitySummary = { clusterKey, clusterName, contextName, stack: { nodeExporter: false, kubeStateMetrics: false }, reachable: false, kpis: {}, forecasts: [], alerts: [], alertsReadable: false };
  let services: any[] = [];
  try {
    services = (await client.get<{ items?: any[] }>('/api/v1/services'))?.items ?? [];
  } catch (err) {
    return { ...base, error: `Services not readable: ${describeError(err)}` };
  }
  const stack = discoverStack(services);
  const out: ObservabilitySummary = { ...base, stack };
  if (!stack.prometheus) return out;
  try {
    const info: any = await client.get(`${proxyBase(stack.prometheus)}/api/v1/status/buildinfo`);
    out.reachable = true;
    out.version = info?.data?.version;
  } catch (err) {
    out.error = `Prometheus found (${stack.prometheus.namespace}/${stack.prometheus.service}) but not reachable: ${describeError(err)}`;
    return out;
  }
  const prom = stack.prometheus;
  await Promise.all([
    ...(Object.keys(KPI_QUERIES) as Array<keyof typeof KPI_QUERIES>).map(async k => {
      try {
        const v = (await instant(client, prom, KPI_QUERIES[k]))[0]?.value;
        if (v !== undefined) out.kpis[k] = v;
      } catch {
        // one missing metric doesn't spoil the rest
      }
    }),
    ...FORECASTS.map(async f => {
      try {
        for (const s of await instant(client, prom, f.query)) if (s.value > 0) out.forecasts.push({ what: f.what, subject: f.subject(s.labels), seconds: s.value });
      } catch {
        // not collected here
      }
    }),
    (async () => {
      if (!stack.alertmanager) return;
      try {
        out.alerts = parseAlerts(await client.get(`${proxyBase(stack.alertmanager)}/api/v2/alerts?active=true&silenced=false&inhibited=false`));
        out.alertsReadable = true;
      } catch {
        // Alertmanager not reachable: alerts just aren't shown
      }
    })(),
  ]);
  out.forecasts.sort((a, b) => a.seconds - b.seconds);
  return out;
}

/* ---------------- Issues ---------------- */

export const OBSERVABILITY_PATH = '/vks-fleet/observability';

export function observabilityIssues(summaries: ObservabilitySummary[], clusters: FleetCluster[], now: Date = new Date()): Issue[] {
  const out: Issue[] = [];
  for (const s of summaries) {
    const c = clusters.find(x => x.key === s.clusterKey);
    if (!c) continue;
    const base = {
      supervisorId: c.supervisorId,
      clusterKey: c.key,
      clusterName: c.name,
      namespace: c.namespace,
      affected: { clusters: [c.name], tenants: [c.tenantName], nodes: [], pods: [] },
      links: [],
      findingIds: [],
      detectedAt: now.toISOString(),
      primary: { label: 'Observability', path: `${OBSERVABILITY_PATH}?cluster=${encodeURIComponent(c.key)}` },
    };
    for (const f of s.forecasts.filter(f => f.seconds < 7 * 86400)) {
      out.push({
        ...base,
        id: `${c.key}#forecast#${f.what}#${f.subject}`,
        severity: f.seconds < 2 * 86400 ? 'critical' : 'warning',
        title: `${f.what === 'volume' ? 'Volume' : f.what === 'node disk' ? 'Node disk' : f.what === 'etcd' ? 'etcd' : 'Node memory'} ${f.subject} runs out in about ${humanDuration(f.seconds)} (${c.name})`,
        cause: `At the rate of the last 6 hours (from Prometheus), ${f.subject} runs out of ${f.what === 'node memory' ? 'memory' : 'space'} in about ${humanDuration(f.seconds)}.`,
        evidence: [],
        fix:
          f.what === 'volume'
            ? 'Expand the volume (if its storage class allows it), clean up data, or check what is writing unusually.'
            : f.what === 'etcd'
            ? 'Look for objects piling up (events, secrets, custom resources) and check that etcd compaction and defragmentation run.'
            : f.what === 'node disk'
            ? 'Look for images, logs or emptyDir volumes growing on that node; replacing the node clears it.'
            : 'Find the workload whose memory is growing (Busiest pods, Node memory) before the node starts evicting.',
      });
    }
    const byName = new Map<string, Alert[]>();
    for (const a of s.alerts) byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
    for (const [name, list] of byName) {
      const worst = list.some(a => a.severity === 'critical') ? 'critical' : list.some(a => a.severity === 'warning') ? 'warning' : 'info';
      out.push({
        ...base,
        id: `${c.key}#alert#${name}`,
        severity: worst,
        title: `Alert ${name} firing in ${c.name}${list.length > 1 ? ` (${list.length})` : ''}`,
        cause: 'From the cluster\u2019s Alertmanager.',
        evidence: list.slice(0, 5).map(a => `${a.namespace ? `${a.namespace}: ` : ''}${a.summary ?? name}`),
        fix: 'Follow the alert\u2019s runbook, or silence it here if it is known.',
      });
    }
  }
  return out;
}
