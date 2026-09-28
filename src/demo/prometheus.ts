/**
 * A fake Prometheus and Alertmanager for demo mode: answers the plugin's
 * queries with plausible, deterministic series, carrying the demo's stories
 * (a node disk filling on checkout, a Kafka volume filling on analytics, a
 * crash-looping pod, a slower API on checkout).
 */
import { DEMO_CLUSTERS, machineNames } from './supervisor';

type C = (typeof DEMO_CLUSTERS)[number];

export const MONITORED = new Set(['payments', 'checkout', 'analytics']);

const wave = (t: number, base: number, amp: number, phase = 0) => base + amp * Math.sin(t / 3600 / 24 * 2 * Math.PI * 3 + phase) + (amp / 3) * Math.sin(t / 900 + phase * 7);

/** Series for a query: [labels, value at time t (seconds)]. */
function seriesFor(c: C, q: string): Array<[Record<string, string>, (t: number) => number]> {
  const nodes = machineNames(c).map(m => m.name);
  const inst = (n: string) => ({ instance: `${n}:9100`, node: n });
  const busy = c.name === 'checkout' ? 25 : 0;
  if (/node_cpu_seconds_total/.test(q)) return nodes.map((n, i) => [inst(n), t => Math.min(97, wave(t, 30 + busy + i * 6, 12, i))]);
  if (/MemAvailable_bytes \/ node_memory_MemTotal_bytes\)\)?$/.test(q) || /1 - node_memory_MemAvailable_bytes/.test(q)) return nodes.map((n, i) => [inst(n), t => wave(t, 55 + busy / 2 + i * 4, 6, i)]);
  if (/node_filesystem_avail_bytes.*node_filesystem_size_bytes/.test(q)) return nodes.map((n, i) => [inst(n), t => (c.name === 'checkout' && i === nodes.length - 1 ? 88 + ((t % 86400) / 86400) * 2 : 38 + i * 5)]);
  if (/apiserver_request_duration_seconds_bucket/.test(q)) return [[{}, t => wave(t, c.name === 'checkout' ? 0.42 : 0.08, c.name === 'checkout' ? 0.15 : 0.02)]];
  if (/apiserver_request_total\{code=~"5\.\."\}/.test(q)) return [[{}, t => Math.max(0, wave(t, c.name === 'checkout' ? 0.2 : 0.01, 0.05))]];
  if (/etcd_mvcc_db_total_size_in_bytes/.test(q) && !/deriv/.test(q)) return [[inst(nodes[0]), t => 90e6 + ((t % (7 * 86400)) / (7 * 86400)) * 20e6]];
  if (/kube_pod_container_status_restarts_total/.test(q)) return c.name === 'checkout' ? [[{ namespace: 'shop', pod: 'cart-6b7f9c-2lq9x' }, t => 4 + Math.round(Math.abs(Math.sin(t / 5000)) * 3)]] : [];
  if (/container_cpu_usage_seconds_total/.test(q)) {
    const pods = c.name === 'payments' ? ['payments/api-1', 'payments/api-2', 'payments/worker-1'] : c.name === 'checkout' ? ['shop/cart-1', 'shop/api-1', 'legacy/sync-agent-1'] : ['streaming/kafka-0', 'streaming/kafka-1', 'ml/notebook-1'];
    return pods.map((p, i) => [{ namespace: p.split('/')[0], pod: p.split('/')[1] }, t => Math.max(0.02, wave(t, 0.6 - i * 0.15, 0.2, i))]);
  }
  if (/kubelet_volume_stats_used_bytes/.test(q)) return c.name === 'analytics' ? [0, 1, 2].map(i => [{ namespace: 'streaming', persistentvolumeclaim: `data-kafka-${i}` }, () => [71, 91, 83][i]]) : [];
  if (/node_network_receive_errs_total/.test(q)) return nodes.map(n => [inst(n), () => 0]);
  return [];
}

const GiB = 2 ** 30;
const MiB = 2 ** 20;

/** Pods for usage, requests and image answers: [namespace, pod, image, cpu request, memory request, cpu p95, memory p95, cpu now, restarts 24 h]. */
type DemoPod = [string, string, string, number, number, number, number, number, number];
const POD_TABLE: Record<string, DemoPod[]> = {
  payments: [
    ...[0, 1, 2].map((i): DemoPod => ['payments', `api-6b7f9c4d8-${'bcd'[i]}x2kq`, 'registry.acme.example/payments/api:2.14.1', 0.25, 512 * MiB, 0.12, 300 * MiB, 0.1, 0]),
    ...[0, 1].map((i): DemoPod => ['payments', `worker-5d4d9b688-${'bc'[i]}wq7m`, 'registry.acme.example/payments/worker:2.14.1', 2, 4 * GiB, 0.2, 700 * MiB, 0.15, 0]),
    ['kube-system', 'coredns-7db6d8ff4d-x8k2p', 'localhost:5000/tkg/coredns:v1.11', 0.1, 1 * GiB, 0.02, 60 * MiB, 0.01, 0],
  ],
  checkout: [
    ...[0, 1].map((i): DemoPod => ['shop', `cart-6b7f9c4d8-${'bc'[i]}clq9`, 'registry.acme.example/shop/cart:1.9.0', 0.25, 512 * MiB, 0.4, 420 * MiB, 0.35, i ? 41 : 0]),
    ...[0, 1].map((i): DemoPod => ['shop', `api-7c8d9f2f2-${'bc'[i]}sp4t`, 'registry.acme.example/payments/api:2.13.0', 0.25, 512 * MiB, 0.2, 380 * MiB, 0.27, 0]),
    ['legacy', 'sync-agent-5f6d7b8c9-lqg2n', 'registry.acme.example/legacy/sync:0.4', 0.5, 1 * GiB, 0.05, 90 * MiB, 0.04, 0],
  ],
  analytics: [
    ...[0, 1, 2].map((i): DemoPod => ['streaming', `kafka-${i}`, 'docker.io/bitnami/kafka:3.8', 1, 8 * GiB, 0.8, 6.5 * GiB, 0.7, 0]),
    ['ml', 'notebook-8d9b2c4d2-nztb2', 'docker.io/jupyter/base-notebook:2026-06-01', 4, 16 * GiB, 0.3, 1.2 * GiB, 0.2, 0],
  ],
};

/** Deprecated APIs in use (illustrative; the demo fleet is fictional). */
const DEPRECATED: Record<string, Array<Record<string, string>>> = {
  checkout: [{ group: 'resource.k8s.io', version: 'v1beta1', resource: 'resourceclaims', removed_release: '1.37' }],
  analytics: [{ group: 'flowcontrol.apiserver.k8s.io', version: 'v1beta3', resource: 'flowschemas', removed_release: '1.39' }],
};

/** Instant-only answers: forecasts (seconds until something runs out) and fleet KPIs. */
function instantFor(c: C, q: string, t: number): Array<[Record<string, string>, number]> | undefined {
  const nodes = machineNames(c).map(m => m.name);
  const pods = POD_TABLE[c.name] ?? [];
  const perPod = (i: number) => pods.map(p => [{ namespace: p[0], pod: p[1] }, p[i] as number] as [Record<string, string>, number]);
  // The same time last week: checkout's API was much faster then.
  const week = /^last_over_time\(\((.*)\)\[10m:1m\] offset 1w\)$/.exec(q);
  if (week) {
    if (c.name === 'checkout' && /apiserver_request_duration/.test(week[1])) return [[{}, 0.12]];
    const now = instantFor(c, week[1], t - 7 * 86400);
    return now?.map(([l, v]) => [l, v * 0.95]);
  }
  if (q === 'apiserver_requested_deprecated_apis') return (DEPRECATED[c.name] ?? []).map(l => [l, 1]);
  if (/^time\(\) - min\(prometheus_tsdb_lowest_timestamp_seconds\)$/.test(q)) return [[{}, 12 * 86400]];
  if (/^quantile_over_time\(0\.95, sum by \(namespace, pod\) \(rate\(container_cpu/.test(q)) return perPod(5);
  if (/^quantile_over_time\(0\.95, sum by \(namespace, pod\) \(container_memory/.test(q)) return perPod(6);
  if (/kube_pod_container_resource_requests\{resource="cpu"\}/.test(q)) return perPod(3);
  if (/kube_pod_container_resource_requests\{resource="memory"\}/.test(q)) return perPod(4);
  if (/^count by \(namespace, pod, image\) \(kube_pod_container_info/.test(q)) return pods.map(p => [{ namespace: p[0], pod: p[1], image: p[2] }, 1]);
  if (/^sum by \(namespace, pod\) \(rate\(container_cpu_usage_seconds_total\{container!="",container!="POD"\}\[1h\]\)\)$/.test(q)) return perPod(7);
  if (/^sum by \(namespace, pod\) \(avg_over_time\(container_memory_working_set_bytes/.test(q)) return perPod(6);
  if (/^sum by \(namespace, pod\) \(increase\(kube_pod_container_status_restarts_total\[24h\]\)\)$/.test(q)) return perPod(8);
  if (/deriv\(kubelet_volume_stats_available_bytes/.test(q)) return c.name === 'analytics' ? [[{ namespace: 'streaming', persistentvolumeclaim: 'data-kafka-1' }, 3.1 * 86400], [{ namespace: 'streaming', persistentvolumeclaim: 'data-kafka-2' }, 9.5 * 86400]] : [];
  if (/deriv\(node_filesystem_avail_bytes/.test(q)) return c.name === 'checkout' ? [[{ instance: `${nodes[nodes.length - 1]}:9100` }, 1.6 * 86400]] : [];
  if (/deriv\(etcd_mvcc_db_total_size_in_bytes/.test(q) || /deriv\(node_memory_MemAvailable_bytes/.test(q)) return [];
  if (/^max\(/.test(q) || /^sum\(/.test(q) || /^histogram_quantile/.test(q)) {
    const s = seriesFor(c, q);
    if (/^sum\(increase\(kube_pod_container_status_restarts_total/.test(q)) return [[{}, c.name === 'checkout' ? 6 : 0]];
    if (!s.length) return [];
    return [[{}, Math.max(...s.map(([, f]) => f(t)))]];
  }
  return undefined;
}

export function demoPrometheus(c: C, path: string, now: Date): unknown {
  const [p, qs = ''] = path.split('?');
  const params = new URLSearchParams(qs);
  const t = Math.floor(now.getTime() / 1000);
  if (/\/alertmanager:[^/]+\/proxy\/api\/v2\/alerts$/.test(p)) {
    return c.name === 'checkout'
      ? [
          { labels: { alertname: 'KubePodCrashLooping', severity: 'warning', namespace: 'shop', pod: 'cart-6b7f9c-2lq9x' }, annotations: { summary: 'Pod shop/cart-6b7f9c-2lq9x is crash looping' }, startsAt: new Date(now.getTime() - 3 * 3600e3).toISOString(), status: { state: 'active' } },
          { labels: { alertname: 'NodeFilesystemAlmostOutOfSpace', severity: 'warning', instance: 'np-1' }, annotations: { summary: 'Filesystem on a checkout node has less than 12% space left' }, startsAt: new Date(now.getTime() - 5 * 3600e3).toISOString(), status: { state: 'active' } },
          { labels: { alertname: 'Watchdog', severity: 'none' }, annotations: {}, status: { state: 'active' } },
        ]
      : [{ labels: { alertname: 'Watchdog', severity: 'none' }, annotations: {}, status: { state: 'active' } }];
  }
  if (p.endsWith('/api/v1/status/buildinfo')) return { status: 'success', data: { version: '2.54.1' } };
  const q = params.get('query') ?? '';
  if (p.endsWith('/api/v1/query')) {
    const special = instantFor(c, q, t);
    const result = (special ?? seriesFor(c, q).map(([l, f]) => [l, f(t)] as [Record<string, string>, number])).map(([metric, v]) => ({ metric, value: [t, String(v)] }));
    return { status: 'success', data: { resultType: 'vector', result } };
  }
  if (p.endsWith('/api/v1/query_range')) {
    const start = Number(params.get('start'));
    const end = Number(params.get('end'));
    const step = Number(params.get('step')) || 60;
    const result = seriesFor(c, q).map(([metric, f]) => {
      const values: Array<[number, string]> = [];
      for (let x = start; x <= end; x += step) values.push([x, String(f(x))]);
      return { metric, values };
    });
    return { status: 'success', data: { resultType: 'matrix', result } };
  }
  return { status: 'success', data: { resultType: 'vector', result: [] } };
}
