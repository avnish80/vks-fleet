/** v1.43: one Supervisor score on every page, a version check that agrees with the table, and a demo that doesn't contradict itself. */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { scorecard } from '../src/checks';
import { normalizeConfig } from '../src/config';
import { DEMO_SUPERVISOR_RAW, demoClient, demoStores } from '../src/demo';
import { DEMO_SUPERVISOR, demoContexts } from '../src/demo/supervisor';
import { matchContexts } from '../src/contexts';
import { fetchSupervisor } from '../src/fleet';
import { supervisorScore, supervisorScoreOf } from '../src/vcenterStatus';

const NOW = new Date('2026-10-13T08:00:00Z');

describe('one Supervisor score on every page', () => {
  const sup: any = { id: 's1', headlampCluster: '10.0.0.2' };
  const h = { supervisorId: 's1', score: 86, nodes: [{ role: 'host', name: 'esx-01' }] };
  const vc: any = { id: 'domain-c10', configStatus: 'RUNNING', kubernetesStatus: 'WARNING', messages: [], apiEndpoints: ['10.0.0.2'], controlPlaneVMs: [], hosts: [], services: [{ id: 'velero', state: 'ERROR' }, { id: 'tkg', state: 'CONFIGURED' }], alarms: [] };
  test('what vCenter reports counts wherever the score is shown', () => {
    const status: any = { supervisors: [vc], metrics: undefined };
    const full = supervisorScoreOf(h, status, [sup]);
    assert.equal(full, supervisorScore(86, vc, undefined));
    assert.ok(full < 86, 'a Kubernetes warning and a failed service lower it');
  });
  test('without the collector, or for a Supervisor it does not know, the API score stands', () => {
    assert.equal(supervisorScoreOf(h, undefined, [sup]), 86);
    assert.equal(supervisorScoreOf({ ...h, supervisorId: 'other' }, { supervisors: [vc] } as any, [sup]), 86);
  });
});

describe('Kubernetes version check', () => {
  const c = (minorsBehind?: number): any => ({ key: 's/ns/c', supervisorId: 's', namespace: 'ns', name: 'c', machines: [], nodePools: [], conditions: [], issues: [], kubernetesVersion: 'v1.35.0', minorsBehind });
  const status = (n?: number) => scorecard(c(n), undefined, 3, NOW).checks.find(x => x.id === 'version')!.status;
  test('one minor behind passes, as in the clusters table; two warns; more fails', () => {
    assert.deepEqual([status(0), status(1), status(2), status(3), status(undefined)], ['pass', 'pass', 'warn', 'fail', 'unknown']);
  });
});

describe('the demo does not contradict itself', () => {
  const cfg = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any], demo: true } as any);
  let ctx: string;
  let checkout: any;
  before(async () => {
    demoStores(NOW);
    const r = await fetchSupervisor(cfg.supervisors[0], demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 }), NOW);
    checkout = r.clusters.find(c => c.name === 'checkout')!;
    ctx = matchContexts(r.clusters, demoContexts()).get(checkout.key)!;
  });
  const get = (path: string) => demoClient(ctx, { now: NOW, latencyMs: 0 }).get<any>(path);
  test('the pod that blocks the stuck node\'s drain is on that node', async () => {
    const stuck = checkout.machines.find((m: any) => m.deletingSince)!;
    const pods = (await get('/api/v1/pods')).items.filter((p: any) => p.spec.nodeName === (stuck.nodeName ?? stuck.name));
    assert.ok(pods.some((p: any) => p.metadata.namespace === 'shop' && p.metadata.name.startsWith('cart-')), 'shop/cart runs there');
    // The other cart replica is the one crash-looping, which is why the budget refuses the eviction.
    const cart = (await get('/api/v1/pods')).items.filter((p: any) => p.metadata.name.startsWith('cart-'));
    assert.equal(cart.filter((p: any) => p.status.containerStatuses[0].ready).length, 1);
  });
  test('a node is as large as its VM class, and uses less than it has', async () => {
    const nodes = (await get('/api/v1/nodes')).items;
    const metrics = new Map<string, any>((await get('/apis/metrics.k8s.io/v1beta1/nodes')).items.map((m: any) => [m.metadata.name, m.usage]));
    for (const n of nodes) {
      const worker = !('node-role.kubernetes.io/control-plane' in n.metadata.labels);
      assert.deepEqual([n.status.capacity.cpu, n.status.capacity.memory], worker ? ['2', '8Gi'] : ['4', '16Gi'], n.metadata.name);
      assert.ok(parseInt(metrics.get(n.metadata.name).cpu) < parseInt(n.status.allocatable.cpu), `${n.metadata.name} CPU`);
      assert.ok(parseInt(metrics.get(n.metadata.name).memory) < parseInt(n.status.allocatable.memory) * 1024, `${n.metadata.name} memory`);
    }
  });
  test('what monitoring runs on is an installed package, and every kind a search reads is served', async () => {
    const installed = (await get('/apis/packaging.carvel.dev/v1alpha1/packageinstalls')).items.map((p: any) => p.spec.packageRef.refName);
    assert.ok(installed.includes('prometheus.tanzu.vmware.com'));
    const { SEARCH_KINDS } = await import('../src/search');
    for (const k of SEARCH_KINDS) await assert.doesNotReject(get(k.path), `${k.kind} at ${k.path}`);
  });
});
