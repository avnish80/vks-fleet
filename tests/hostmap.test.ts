/** v1.26: the Supervisor by host, host-failure blast radius, and placement from vCenter. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hostPatterns, walkDown } from '../src/explain';
import { hostBlast, hostMap } from '../src/hostmap';
import { placementFor } from '../src/vcenterStatus';

const svc = (name: string, hosts: string[]): any => ({ namespace: `svc-${name}`, name, running: hosts.map(h => ({ name: `${name}-x`, host: h })), leftovers: [], failing: [], state: 'ok' });
const m = (name: string, role = 'worker'): any => ({ name, nodeName: name, role, phase: 'Running', ready: true });
const clusters: any[] = [
  { key: 's/ns/9yfw', name: 'kubernetes-cluster-9yfw', namespace: 'ns', machines: [m('9yfw-cp', 'control-plane'), m('9yfw-w1'), m('9yfw-w2')] },
  { key: 's/ns/mnet', name: 'kubernetes-cluster-mnet', namespace: 'ns', machines: [m('mnet-cp', 'control-plane'), m('mnet-w1')] },
];
// As in the lab: VM Operator reports no host, the collector does.
const placed = new Map([
  ['SupervisorControlPlaneVM (1)', 'esx-05a'],
  ['9yfw-cp', 'esx-05a'], ['9yfw-w1', 'esx-06a'], ['9yfw-w2', 'esx-05a'],
  ['mnet-cp', 'esx-07a'], ['mnet-w1', 'esx-05a'], ['web-vm-3', 'esx-08a'],
]);
const input = {
  hosts: ['esx-05a', 'esx-06a', 'esx-07a', 'esx-08a'].map(name => ({ name, ready: true })),
  load: [{ kind: 'host' as const, name: 'esx-05a', cpuPct: 22, memPct: 43 }],
  alarms: [{ entity: 'esx-07a' }, { entity: 'esx-07a', acknowledged: true }],
  controlPlaneVms: ['SupervisorControlPlaneVM (1)'],
  services: [svc('auto-attach', ['esx-05a']), svc('velero', ['esx-05a', 'esx-06a'])],
  clusters,
  vms: [{ name: 'web-vm-3', namespace: 'ns', supervisorId: 's' } as any, { name: 'orphan-vm', namespace: 'ns', supervisorId: 's' } as any],
  hostOf: (n: string) => placed.get(n),
};

describe('host view', () => {
  test('what runs on each host', () => {
    const map = hostMap(input);
    const h5 = map.cards.find(c => c.name === 'esx-05a')!;
    assert.deepEqual(h5.controlPlaneVms, ['SupervisorControlPlaneVM (1)']);
    assert.deepEqual(h5.services, ['auto-attach', 'velero']);
    assert.deepEqual(h5.clusters.map(x => [x.cluster, x.nodes.length, x.controlPlane]), [['kubernetes-cluster-9yfw', 2, 1], ['kubernetes-cluster-mnet', 1, 0]]);
    assert.equal(h5.cpuPct, 22);
    assert.equal(map.cards.find(c => c.name === 'esx-07a')!.alarms, 1, 'acknowledged alarms are not counted');
    assert.deepEqual(map.cards.find(c => c.name === 'esx-08a')!.vms, ['web-vm-3']);
    assert.equal(map.unplaced, 1, 'the VM with no known host');
  });
  test('if a host fails: services down or degraded, clusters losing nodes or their control plane', () => {
    const map = hostMap(input);
    const b5 = hostBlast(map.cards.find(c => c.name === 'esx-05a')!, input.services, clusters);
    assert.deepEqual(b5.supervisorControlPlane, ['SupervisorControlPlaneVM (1)']);
    assert.deepEqual(b5.servicesDown, ['auto-attach']);
    assert.deepEqual(b5.servicesDegraded, ['velero']);
    assert.deepEqual(b5.clusters, [{ cluster: 'kubernetes-cluster-9yfw', nodes: 2, total: 3, controlPlaneLost: true }, { cluster: 'kubernetes-cluster-mnet', nodes: 1, total: 2, controlPlaneLost: false }]);
    const b7 = hostBlast(map.cards.find(c => c.name === 'esx-07a')!, input.services, clusters);
    assert.deepEqual(b7.clusters.map(x => x.controlPlaneLost), [true], 'mnet\u2019s single control-plane node is on esx-07a');
  });
});

describe('placement from vCenter feeds the walk-down and host patterns', () => {
  test('the walk-down finds the host without VM Operator\u2019s status.host', () => {
    const c = clusters[0];
    const w = walkDown({ cluster: c, node: '9yfw-w1', inventory: { vms: [{ name: '9yfw-w1', namespace: 'ns', power: 'PoweredOn' }] } as any, hosts: input.hosts, hostOf: n => placed.get(n) });
    assert.equal(w.layers.find(l => l.layer === 'Host')?.name, 'esx-06a');
  });
  test('host patterns use it too', () => {
    const wl: any = { podIssues: [{ namespace: 'a', name: 'p', reason: 'CrashLoopBackOff', node: '9yfw-cp' }, { namespace: 'a', name: 'q', reason: 'CrashLoopBackOff', node: '9yfw-w2' }], sandboxFailures: [] };
    assert.deepEqual(hostPatterns(clusters[0], wl, { vms: [] } as any, n => placed.get(n)).map(p => p.host), ['esx-05a']);
  });
  test('placementFor filters to one Supervisor', () => {
    const st: any = { placement: { vms: [{ name: 'a', host: 'h1', supervisor: 'domain-c9' }, { name: 'b', host: 'h2', supervisor: 'domain-c20' }] } };
    assert.deepEqual(Array.from(placementFor(st, 'domain-c9').entries()), [['a', 'h1']]);
  });
});
