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

/** Instant-only answers: forecasts (seconds until something runs out) and fleet KPIs. */
function instantFor(c: C, q: string, t: number): Array<[Record<string, string>, number]> | undefined {
  const nodes = machineNames(c).map(m => m.name);
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
