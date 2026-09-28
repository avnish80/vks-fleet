/** Compare: deprecated APIs, unusual-for-this-time, right-sizing, the same app across clusters, and the fixes from the lab. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareApps, podOwner, sizeCluster, sizeWorkloads } from '../src/compare';
import { apiName, discoverStack, parseDeprecated, removedBy, serverSetupCommands, unusualKpis } from '../src/observability';
import { readiness } from '../src/planner';

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const smp = (ns: string, pod: string, value: number) => ({ labels: { namespace: ns, pod }, value });

describe('fixes from the lab', () => {
  test('the Helm chart names Alertmanager prometheus-alertmanager', () => {
    const s = discoverStack([
      { metadata: { namespace: 'monitoring', name: 'prometheus-server' }, spec: { ports: [{ port: 80 }] } },
      { metadata: { namespace: 'monitoring', name: 'prometheus-alertmanager' }, spec: { ports: [{ name: 'http', port: 9093 }] } },
      { metadata: { namespace: 'monitoring', name: 'prometheus-alertmanager-headless' }, spec: { ports: [{ port: 9093 }] } },
    ]);
    assert.deepEqual(s.alertmanager, { namespace: 'monitoring', service: 'prometheus-alertmanager', port: '9093' });
  });
  test('exporters without a server (VKS managed add-on): commands add one next to them', () => {
    const s = discoverStack([
      { metadata: { namespace: 'tanzu-system-monitoring', name: 'prometheus-node-exporter' }, spec: { ports: [{ port: 9100 }] } },
      { metadata: { namespace: 'tanzu-system-monitoring', name: 'prometheus-kube-state-metrics' }, spec: { ports: [{ port: 80 }, { port: 81 }] } },
    ]);
    assert.equal(s.prometheus, undefined);
    assert.equal(s.exporterNamespace, 'tanzu-system-monitoring');
    const cmd = serverSetupCommands('kubernetes-cluster-mnet', s.exporterNamespace);
    assert.match(cmd, /^C=kubernetes-cluster-mnet\n/);
    assert.match(cmd, /prometheus-node-exporter:\n  enabled: false/);
    assert.match(cmd, /namespaces: \{ names: \[tanzu-system-monitoring\] \}/);
    assert.match(cmd, /<<'VALUES'[\s\S]*\nVALUES\n/, 'a here-document marker that cannot collide with EOF');
  });
});

describe('deprecated APIs', () => {
  const samples = [
    { labels: { group: 'resource.k8s.io', version: 'v1beta1', resource: 'resourceclaims', removed_release: '1.37' }, value: 1 },
    { labels: { group: 'resource.k8s.io', version: 'v1beta1', resource: 'resourceclaims', removed_release: '1.37' }, value: 1 },
    { labels: { group: '', version: 'v1', resource: 'componentstatuses', removed_release: '' }, value: 1 },
    { labels: { group: 'x', version: 'v1', resource: 'y' }, value: 0 },
  ];
  test('parsed once each; core group named; only requested ones', () => {
    const d = parseDeprecated(samples);
    assert.deepEqual(d.map(apiName), ['resource.k8s.io/v1beta1 resourceclaims', 'v1 componentstatuses']);
  });
  test('removed by a target release', () => {
    const [claims] = parseDeprecated(samples);
    assert.equal(removedBy(claims, 'v1.37.1+vmware.1'), true);
    assert.equal(removedBy(claims, 'v1.36.2+vmware.2'), false);
    assert.equal(removedBy(claims, 'v2.0.0'), true);
  });
  test('the Upgrade Planner warns before an upgrade that would break callers', () => {
    const c: any = { key: 'k', name: 'checkout', namespace: 'ns', kubernetesVersion: 'v1.36.2+vmware.2', health: 'healthy', machines: [], nodePools: [], conditions: [], issues: [] };
    const entry = { wave: 1, target: 'v1.37.1+vmware.1', moveClass: false };
    const withApis = readiness(c, entry, ['v1.37.1+vmware.1'], [], [], undefined, undefined, parseDeprecated(samples));
    assert.ok(withApis.checks.some(x => x.level === 'warn' && /removed by v1\.37\.1\+vmware\.1: resource\.k8s\.io\/v1beta1 resourceclaims/.test(x.text)));
    const without = readiness(c, entry, ['v1.37.1+vmware.1'], [], [], undefined, undefined, []);
    assert.ok(without.checks.some(x => x.level === 'ok' && /No deprecated APIs in use/.test(x.text)));
  });
});

describe('unusual for this time of week', () => {
  test('needs both a ratio and a real difference', () => {
    assert.deepEqual(unusualKpis({ apiP99: 0.58, nodeCpu: 30, nodeMem: 50 }, { apiP99: 0.12, nodeCpu: 18, nodeMem: 45 }).map(u => u.kpi), ['apiP99']);
    assert.deepEqual(unusualKpis({ nodeCpu: 4 }, { nodeCpu: 1 }), [], 'tripled but tiny: not unusual');
    assert.deepEqual(unusualKpis({ nodeCpu: 60 }, {}), [], 'no history a week ago: no badge');
  });
});

describe('right-sizing', () => {
  test('pod names to workloads', () => {
    assert.equal(podOwner('api-6b7f9c4d8-bx2kq'), 'api');
    assert.equal(podOwner('prometheus-server-5d4d9b6887-mbj5p'), 'prometheus-server');
    assert.equal(podOwner('kafka-2'), 'kafka');
    assert.equal(podOwner('prometheus-node-exporter-68shw'), 'prometheus-node-exporter');
  });
  test('over-asking and under-asking workloads; platform namespaces left out', () => {
    const w = sizeWorkloads(
      [smp('app', 'worker-5d4d9b688-bcb2c', 0.2), smp('app', 'cart-6b7f9c4d8-bclq9', 0.4), smp('kube-system', 'coredns-7db6d8ff4d-x8k2p', 0.02)],
      [smp('app', 'worker-5d4d9b688-bcb2c', 700 * MiB), smp('app', 'cart-6b7f9c4d8-bclq9', 400 * MiB), smp('kube-system', 'coredns-7db6d8ff4d-x8k2p', 60 * MiB)],
      [smp('app', 'worker-5d4d9b688-bcb2c', 2), smp('app', 'cart-6b7f9c4d8-bclq9', 0.25), smp('kube-system', 'coredns-7db6d8ff4d-x8k2p', 0.1)],
      [smp('app', 'worker-5d4d9b688-bcb2c', 4 * GiB), smp('app', 'cart-6b7f9c4d8-bclq9', 512 * MiB), smp('kube-system', 'coredns-7db6d8ff4d-x8k2p', GiB)]
    );
    assert.deepEqual(w.map(x => [x.workload, x.verdict]), [['worker', 'over'], ['cart', 'under']]);
    assert.ok(Math.abs(w[0].memSuggest - 700 * MiB * 1.3) < 1);
  });
  test('a single pool: fewer nodes, and the overcommit effect', () => {
    const c: any = { namespace: 'ns', nodePools: [{ name: 'np-1', desired: 3, vmClass: 'large' }] };
    const classes = [{ namespace: 'ns', name: 'large', cpus: 4, memoryBytes: 16 * GiB }];
    const workloads: any[] = [{ verdict: 'over', memRequest: 8 * GiB, memSuggest: 1.8 * GiB }];
    const s = sizeCluster(c, classes, [], [{ labels: {}, value: 10.5 * GiB }], [], [{ labels: {}, value: 2.3 * GiB }], workloads, { namespace: 'ns', source: 'supervisor', memoryLimitBytes: 96 * GiB, storage: [], vmClasses: [], zones: [] }, { vcpu: 0, memoryBytes: 104 * GiB, reservedBytes: 0 });
    assert.equal(s.pool!.suggestedNodes, 2, 'never below two for availability');
    assert.equal(s.freedMem, 16 * GiB);
    assert.equal(s.overcommitBefore!.toFixed(2), '1.08');
    assert.equal(s.overcommitAfter!.toFixed(2), '0.92');
    const twoPools = sizeCluster({ namespace: 'ns', nodePools: [{ name: 'a', desired: 2 }, { name: 'b', desired: 1 }] } as any, classes, [], [], [], [], [], undefined, undefined);
    assert.equal(twoPools.pool, undefined, 'several pools: no node-count guess');
  });
});

describe('the same app across clusters', () => {
  test('matched by workload and image; differences called out', () => {
    const u = (cluster: string, tag: string, cpu: number, restarts = 0): any => ({ cluster, namespace: 'x', workload: 'api', image: `registry.acme.example/payments/api:${tag}`, tag, replicas: 2, cpuPerReplica: cpu, memPerReplica: 300 * MiB, restarts24h: restarts });
    const [a] = compareApps([u('payments', '2.14.1', 0.1), u('checkout', '2.13.0', 0.27, 5), { ...u('solo', '1', 1), workload: 'other' }]);
    assert.equal(a.app, 'api');
    assert.equal(a.rows.length, 2);
    assert.ok(a.notes.some(n => /checkout uses 2\.7× the CPU per replica/.test(n)));
    assert.ok(a.notes.some(n => /Restarts only in checkout/.test(n)));
    assert.ok(a.notes.some(n => /Different versions/.test(n)));
  });
});
