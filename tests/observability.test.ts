/** Observability: finding the stack, parsing Prometheus answers, alerts, forecasts, and the demo fleet end to end. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { demoClient, demoStores } from '../src/demo';
import { contextName } from '../src/demo/supervisor';
import { discoverStack, fetchSummary, firstWith, humanDuration, instant, observabilityIssues, parseAlerts, parseMatrix, parseVector, proxyBase } from '../src/observability';

const svc = (ns: string, name: string, ports: Array<{ name?: string; port: number }>) => ({ metadata: { namespace: ns, name }, spec: { ports } });

describe('finding the monitoring stack', () => {
  test('the VKS Prometheus package', () => {
    const s = discoverStack([svc('tanzu-system-monitoring', 'prometheus-server', [{ name: 'http', port: 80 }]), svc('tanzu-system-monitoring', 'alertmanager', [{ port: 80 }]), svc('tanzu-system-monitoring', 'prometheus-node-exporter', [{ port: 9100 }]), svc('tanzu-system-monitoring', 'prometheus-kube-state-metrics', [{ port: 8080 }])]);
    assert.deepEqual(s.prometheus, { namespace: 'tanzu-system-monitoring', service: 'prometheus-server', port: '80' });
    assert.equal(s.alertmanager?.service, 'alertmanager');
    assert.equal(s.nodeExporter && s.kubeStateMetrics, true);
    assert.equal(proxyBase(s.prometheus!), '/api/v1/namespaces/tanzu-system-monitoring/services/prometheus-server:80/proxy');
  });
  test('kube-prometheus-stack, preferring the main service over the headless one', () => {
    const s = discoverStack([svc('monitoring', 'prometheus-operated', [{ name: 'web', port: 9090 }]), svc('monitoring', 'kps-kube-prometheus-prometheus', [{ name: 'http-web', port: 9090 }, { name: 'reloader-web', port: 8080 }])]);
    assert.deepEqual(s.prometheus, { namespace: 'monitoring', service: 'kps-kube-prometheus-prometheus', port: '9090' });
  });
  test('nothing installed', () => {
    assert.equal(discoverStack([svc('kube-system', 'kube-dns', [{ port: 53 }])]).prometheus, undefined);
  });
});

describe('Prometheus and Alertmanager answers', () => {
  test('vectors, matrices and scalars; NaN dropped', () => {
    assert.deepEqual(parseVector({ data: { resultType: 'vector', result: [{ metric: { a: '1' }, value: [1, '2.5'] }, { metric: {}, value: [1, 'NaN'] }] } }), [{ labels: { a: '1' }, value: 2.5 }]);
    assert.deepEqual(parseVector({ data: { resultType: 'scalar', result: [1, '7'] } }), [{ labels: {}, value: 7 }]);
    assert.deepEqual(parseMatrix({ data: { resultType: 'matrix', result: [{ metric: {}, values: [[10, '1'], [20, '2']] }] } })[0].points, [[10000, 1], [20000, 2]]);
  });
  test('alerts: Watchdog left out; severities mapped', () => {
    const a = parseAlerts([
      { labels: { alertname: 'Watchdog', severity: 'none' }, status: { state: 'active' } },
      { labels: { alertname: 'KubePodCrashLooping', severity: 'warning', namespace: 'shop' }, annotations: { summary: 'crash looping' }, status: { state: 'active' } },
      { labels: { alertname: 'EtcdNoLeader', severity: 'critical' }, annotations: { description: 'no leader' } },
      { labels: { alertname: 'Old', severity: 'critical' }, status: { state: 'suppressed' } },
    ]);
    assert.deepEqual(a.map(x => [x.name, x.severity, x.summary]), [['KubePodCrashLooping', 'warning', 'crash looping'], ['EtcdNoLeader', 'critical', 'no leader']]);
  });
  test('the first query with data wins (exporters name metrics differently)', async () => {
    const r = await firstWith(['a', 'b', 'c'], async q => (q === 'b' ? [1] : []));
    assert.equal(r.query, 'b');
  });
  test('durations', () => {
    assert.equal(humanDuration(1800), '30 min');
    assert.equal(humanDuration(38 * 3600), '38 h');
    assert.equal(humanDuration(3.1 * 86400), '3 days');
  });
});

describe('on the demo fleet', () => {
  const NOW = new Date('2026-09-27T10:00:00Z');
  demoStores(NOW);
  const run = (n: string) => fetchSummary(demoClient(contextName(n), { now: NOW, latencyMs: 0 }), n, n, contextName(n));

  test('each cluster answers for itself (regression: a shared cache once mixed clusters)', async () => {
    const [p, c] = [await run('payments'), await run('checkout')];
    assert.ok(c.kpis.nodeCpu! > p.kpis.nodeCpu!, 'checkout is busier');
    assert.ok(c.kpis.apiP99! > p.kpis.apiP99!);
    const q = 'max(100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))))';
    const prom = p.stack.prometheus!;
    const a = await instant(demoClient(contextName('payments'), { now: NOW, latencyMs: 0 }), prom, q);
    const b = await instant(demoClient(contextName('checkout'), { now: NOW, latencyMs: 0 }), prom, q);
    assert.notEqual(a[0].value, b[0].value);
  });
  test('forecasts, alerts, and a cluster without monitoring', async () => {
    const [checkout, analytics, sandbox] = [await run('checkout'), await run('analytics'), await run('sandbox')];
    assert.equal(checkout.forecasts[0].what, 'node disk');
    assert.ok(checkout.forecasts[0].seconds < 2 * 86400);
    assert.deepEqual(analytics.forecasts.map(f => f.subject), ['streaming/data-kafka-1', 'streaming/data-kafka-2']);
    assert.deepEqual(checkout.alerts.map(a => a.name), ['KubePodCrashLooping', 'NodeFilesystemAlmostOutOfSpace']);
    assert.equal(sandbox.stack.prometheus, undefined);
    assert.equal(sandbox.reachable, false);
    const clusters: any[] = ['checkout', 'analytics', 'sandbox'].map(n => ({ key: n, name: n, namespace: 'ns', supervisorId: 's', tenantName: 'acme' }));
    const issues = observabilityIssues([checkout, analytics, sandbox], clusters, NOW);
    const titles = issues.map(i => `${i.severity}: ${i.title}`);
    assert.ok(titles.some(t => /^critical: Node disk .* runs out in about \d+ h \(checkout\)/.test(t)));
    assert.ok(titles.some(t => /^warning: Volume streaming\/data-kafka-1 runs out in about 3 days/.test(t)));
    assert.ok(!titles.some(t => /data-kafka-2/.test(t)), 'ten days away is not an issue yet');
    assert.ok(titles.some(t => /^warning: Alert KubePodCrashLooping firing in checkout/.test(t)));
    assert.equal(new Set(issues.map(i => i.id)).size, issues.length);
  });
});
