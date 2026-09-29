/** v1.25: change impact analysis. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeConfig } from '../src/config';
import { demoClient, demoStores, DEMO_SUPERVISOR_RAW } from '../src/demo';
import { contextName, DEMO_SUPERVISOR } from '../src/demo/supervisor';
import { fetchSupervisor } from '../src/fleet';
import { blastRadius, fetchLive, preflight } from '../src/preflight';
import { upgradeTargets } from '../src/releases';

const NOW = new Date('2026-09-27T10:00:00Z');
async function demo(name: string) {
  demoStores(NOW);
  const sv = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any] } as any).supervisors[0];
  const r = await fetchSupervisor(sv, demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 }), NOW);
  const cluster = r.clusters.find(c => c.name === name)!;
  const live = await fetchLive(demoClient(contextName(name), { now: NOW, latencyMs: 0 }));
  return { r, cluster, live };
}

describe('pre-flight', () => {
  test('a stuck node stops an upgrade, once (no duplicate blocker)', async () => {
    const { r, cluster, live } = await demo('checkout');
    const target = upgradeTargets(cluster.kubernetesVersion, r.releases ?? [])[0] ?? 'v1.37.1+vmware.1';
    const pf = preflight({ cluster, change: { kind: 'upgrade', target }, releases: r.releases ?? [], vmClasses: r.vmClasses ?? [], live });
    assert.equal(pf.verdict, 'stop');
    assert.equal(pf.checks.filter(x => /deleting/.test(x.text) && x.level === 'block').length, 1);
    assert.ok(!pf.checks.some(x => x.text === 'Cluster healthy, not paused, no rollout in progress.'), 'not called healthy');
    assert.ok(pf.blast!.blockingPdbs.includes('shop/cart'));
  });
  test('an upgrade: control plane counted apart, static pods never "lost"', async () => {
    const { r, cluster, live } = await demo('sandbox');
    const pf = preflight({ cluster, change: { kind: 'upgrade', target: upgradeTargets(cluster.kubernetesVersion, r.releases ?? [])[0] }, releases: r.releases ?? [], vmClasses: r.vmClasses ?? [], live, supervisorScore: 90 });
    assert.equal(pf.verdict, 'caution');
    assert.equal(pf.blast!.controlPlane, 1);
    assert.ok(!pf.blast!.unmanaged.some(p => /etcd-|kube-apiserver-/.test(p)));
    assert.ok(pf.checks.some(x => x.area === 'APIs'), 'deprecated APIs are always addressed');
    assert.ok(pf.plan, 'the upgrade plan is ready for the action dialog');
  });
  test('scale down: nodes that may go, capacity freed, a single node left warned', async () => {
    const { r, cluster, live } = await demo('payments');
    const pf = preflight({ cluster, change: { kind: 'scale', pool: 'np-1', replicas: 1 }, releases: r.releases ?? [], vmClasses: r.vmClasses ?? [], live });
    assert.equal(pf.blast!.removing, 2);
    assert.ok(pf.checks.some(x => /Frees 2 VMs/.test(x.text)));
    assert.ok(pf.checks.some(x => /A single node left/.test(x.text) && x.level === 'warn'));
  });
  test('VM class: unavailable class blocks; a valid one computes during and after', async () => {
    const { r, cluster, live } = await demo('payments');
    const bad = preflight({ cluster, change: { kind: 'vmclass', pool: 'np-1', vmClass: 'guaranteed-8xlarge' }, releases: [], vmClasses: r.vmClasses ?? [], live });
    assert.equal(bad.verdict, 'stop');
    const ok = preflight({
      cluster,
      change: { kind: 'vmclass', pool: 'np-1', vmClass: 'best-effort-xlarge' },
      releases: [],
      vmClasses: r.vmClasses ?? [],
      live,
      limits: { namespace: cluster.namespace, source: 'supervisor', memoryLimitBytes: 64 * 2 ** 30, storage: [], vmClasses: [], zones: [] } as any,
      configured: { vcpu: 20, memoryBytes: 60 * 2 ** 30, reservedBytes: 0 },
    });
    assert.ok(ok.capacity.during && ok.capacity.after);
    assert.ok(ok.checks.some(x => /Afterwards: Memory would be/.test(x.text)), 'the permanent growth is checked against the limit');
    assert.equal(ok.plan, undefined, 'the plugin checks this change but does not make it');
  });
  test('health gates: paused, stale controllers', async () => {
    const { r, cluster, live } = await demo('payments');
    const pf = preflight({ cluster: { ...cluster, paused: true }, change: { kind: 'scale', pool: 'np-1', replicas: 4 }, releases: [], vmClasses: r.vmClasses ?? [], live, staleControllers: ['Cluster API'] });
    assert.equal(pf.verdict, 'stop');
    assert.deepEqual(pf.checks.filter(x => x.area === 'Health' && x.level === 'block').map(x => x.text.split(':')[0]), ['The cluster is paused', 'Controllers not renewing their leases on the Supervisor']);
  });
  test('blast radius: single-replica workloads and pods with no controller', () => {
    const pod = (ns: string, name: string, owner?: string, node = 'w1'): any => ({ namespace: ns, name, phase: 'Running', ready: '1/1', restarts: 0, owner, daemonSet: false });
    const live: any = { packages: [], nodes: new Map([['w1', [pod('a', 'web-1', 'ReplicaSet/web'), pod('a', 'db-0', 'StatefulSet/db'), pod('b', 'debug', undefined)]], ['w2', [pod('a', 'web-2', 'ReplicaSet/web')]]]) };
    const c: any = { machines: [{ name: 'w1', nodeName: 'w1', role: 'worker' }, { name: 'w2', nodeName: 'w2', role: 'worker' }] };
    const b = blastRadius(c, ['w1'], live);
    assert.deepEqual([b.pods, b.workloads, b.namespaces], [3, 2, 2]);
    assert.deepEqual(b.singleReplica, ['a/StatefulSet/db'], 'web has a second replica on w2');
    assert.deepEqual(b.unmanaged, ['b/debug']);
  });
});
