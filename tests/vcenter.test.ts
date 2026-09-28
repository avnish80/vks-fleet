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
