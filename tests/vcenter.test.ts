/** vCenter's view (from the collector): reading, matching to Supervisors, scoring, issues; the demo end to end. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { demoClient, demoStores } from '../src/demo';
import { contextName } from '../src/demo/supervisor';
import { fetchVcenterStatus, matchSupervisor, parseStatus, vcenterIssues, vcenterPenalty, VcSupervisor } from '../src/vcenterStatus';

const sup = (o: Partial<VcSupervisor> = {}): VcSupervisor => ({
  id: 'domain-c10', name: 'wld-cl01', configStatus: 'RUNNING', kubernetesStatus: 'READY', messages: [], apiEndpoints: ['10.150.4.2:443'],
  controlPlaneVMs: [{ name: 'SupervisorControlPlaneVM (1)', power: 'POWERED_ON' }], hosts: [], services: [], alarms: [], ...o,
});
const cfg = (headlampCluster: string): any => ({ id: 'wld', headlampCluster });

describe('reading and matching', () => {
  test('the ConfigMap', () => {
    assert.equal(parseStatus({ data: { 'status.json': '{"collectedAt":"t","supervisors":[]}' } })?.collectedAt, 't');
    assert.equal(parseStatus({ data: {} }), undefined);
    assert.equal(parseStatus({ data: { 'status.json': 'not json' } }), undefined);
  });
  test('by API address (port and scheme ignored), including the -admin context', () => {
    const st: any = { collectedAt: 't', supervisors: [sup(), sup({ id: 'domain-c20', apiEndpoints: ['https://10.160.4.2'] })], errors: [] };
    assert.equal(matchSupervisor(st, cfg('10.150.4.2'), 2)?.id, 'domain-c10');
    assert.equal(matchSupervisor(st, cfg('10.160.4.2-admin'), 2)?.id, 'domain-c20');
    assert.equal(matchSupervisor(st, cfg('some-name'), 2), undefined, 'two of each and no address match: no guess');
  });
  test('one Supervisor on each side: matched without an address', () => {
    const st: any = { collectedAt: 't', supervisors: [sup({ apiEndpoints: [] })], errors: [] };
    assert.equal(matchSupervisor(st, cfg('my-supervisor'), 1)?.id, 'domain-c10');
  });
});

describe('scoring and issues', () => {
  test('healthy: nothing', () => {
    assert.equal(vcenterPenalty(sup()), 0);
    assert.deepEqual(vcenterIssues(sup(), 'wld', 'wld'), []);
  });
  test('status, control plane, services and red alarms', () => {
    const v = sup({
      configStatus: 'ERROR',
      kubernetesStatus: 'WARNING',
      messages: [{ severity: 'ERROR', text: 'Failed to configure the load balancer.' }],
      controlPlaneVMs: [{ name: 'SupervisorControlPlaneVM (1)', power: 'POWERED_OFF' }],
      services: [{ id: 'velero.vsphere.vmware.com', state: 'ERROR' }],
      alarms: [{ entity: 'esx-06a', name: 'Host connection lost', status: 'red' }, { entity: 'esx-07a', name: 'x', status: 'red', acknowledged: true }],
    });
    assert.equal(vcenterPenalty(v), 40 + 10 + 40 + 5 + 10);
    const titles = vcenterIssues(v, 'wld', 'wld').map(i => `${i.severity}: ${i.title}`);
    assert.deepEqual(titles, [
      'critical: vCenter reports wld: configuration error, Kubernetes warning',
      'critical: Supervisor control-plane VM SupervisorControlPlaneVM (1) is powered off',
      'warning: 1 Supervisor Service not configured on wld (vCenter)',
      "warning: 1 red alarm on wld's cluster, hosts or control plane",
    ]);
  });
});

describe('on the demo fleet', () => {
  test('the collector ConfigMap in payments, matched to the demo Supervisor', async () => {
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const read = await fetchVcenterStatus(demoClient(contextName('payments'), { now: NOW, latencyMs: 0 }), 'vks-fleet', 'vks-fleet-vcenter', NOW);
    assert.equal(read.error, undefined);
    assert.ok(read.ageMinutes! <= 3);
    const v = matchSupervisor(read.status!, cfg('vks-demo-supervisor'), 1)!;
    assert.equal(v.kubernetesStatus, 'WARNING');
    assert.deepEqual(vcenterIssues(v, 'demo', 'Demo Supervisor').map(i => i.severity), ['warning', 'warning']);
    const missing = await fetchVcenterStatus(demoClient(contextName('sandbox'), { now: NOW, latencyMs: 0 }), 'vks-fleet', 'vks-fleet-vcenter', NOW);
    assert.match(missing.error!, /Couldn't read vks-fleet\/vks-fleet-vcenter/);
  });
});

describe('utilisation of the control-plane VM and hosts', () => {
  test('series from the history, the fullest disk, and the forecast', async () => {
    const { diskForecast, fullestDisk, historySeries } = await import('../src/vcenterStatus');
    const t0 = Date.parse('2026-09-27T00:00:00Z');
    const history = Array.from({ length: 13 }, (_, i) => ({ t: new Date(t0 + i * 3600e3).toISOString(), v: { cp: [30, 80, 100, 50, 70 + i], 'esx-05a': [40, 60, null, null, null] } }));
    const m: any = { sampledAt: 't', entities: [], history };
    assert.equal(historySeries(m, ['cp', 'esx-05a'], 'cpuPct').length, 2);
    assert.equal(historySeries(m, ['esx-05a'], 'diskFullPct').length, 0, 'hosts have no guest disks');
    const eta = diskForecast(m, 'cp')!;
    assert.ok(Math.abs(eta - 18 * 3600) < 60, `1% per hour from 82%: about 18 h, got ${eta}`);
    assert.equal(diskForecast(m, 'esx-05a'), undefined);
    assert.deepEqual(fullestDisk({ kind: 'vm', name: 'cp', supervisor: 'x', disks: [{ path: '/', capacityBytes: 100, freeBytes: 60 }, { path: '/var/lib/etcd', capacityBytes: 100, freeBytes: 15 }] }), { path: '/var/lib/etcd', pct: 85 });
  });
  test('penalties and issues', async () => {
    const { utilisationIssues, utilisationPenalty } = await import('../src/vcenterStatus');
    const vm: any = { kind: 'vm', name: 'SupervisorControlPlaneVM (1)', supervisor: 'x', memPct: 92, disks: [{ path: '/var/lib/etcd', capacityBytes: 100, freeBytes: 8 }] };
    const host: any = { kind: 'host', name: 'esx-05a', supervisor: 'x', cpuPct: 95, memPct: 50 };
    assert.equal(utilisationPenalty([vm, host]), 20 + 10 + 5);
    const titles = utilisationIssues([vm, host], undefined, 'wld', 'wld').map(i => `${i.severity}: ${i.title}`);
    assert.deepEqual(titles, ['critical: SupervisorControlPlaneVM (1) disk /var/lib/etcd is 92% full', 'warning: SupervisorControlPlaneVM (1) memory is 92% used', 'warning: 1 ESXi host above 90% on wld: esx-05a']);
    assert.equal(utilisationPenalty([{ kind: 'host', name: 'h', supervisor: 'x', cpuPct: 30, memPct: 40 }]), 0);
  });
  test('on the demo Supervisor: the etcd disk forecast', async () => {
    const { diskForecast, entitiesFor } = await import('../src/vcenterStatus');
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const read = await fetchVcenterStatus(demoClient(contextName('payments'), { now: NOW, latencyMs: 0 }), 'vks-fleet', 'vks-fleet-vcenter', NOW);
    const ents = entitiesFor(read.status!.metrics, 'domain-c10');
    assert.equal(ents.length, 5);
    const eta = diskForecast(read.status!.metrics, 'SupervisorControlPlaneVM (1)')!;
    assert.ok(eta > 2 * 86400 && eta < 4 * 86400, `about three days, got ${(eta / 86400).toFixed(1)} days`);
  });
});
