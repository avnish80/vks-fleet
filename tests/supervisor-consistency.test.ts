/** v1.33.4: one Supervisor score everywhere, and the Supervisor blamed only when it's the cause. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { demoClient } from '../src/demo/index';
import { contextName, demoClusters, setDemoScale } from '../src/demo/supervisor';
import { walkDown } from '../src/explain';
import { supervisorScore, vcenterPenalty } from '../src/vcenterStatus';
import { fetchWorkloadHealth } from '../src/workload';

describe('the Supervisor score', () => {
  test("is the API's score less vCenter's findings, and the API's alone without vCenter data", () => {
    const vc: any = { id: 'domain-c10', configStatus: 'RUNNING', kubernetesStatus: 'WARNING', controlPlaneVMs: [], services: [{ id: 'velero', state: 'ERROR' }], alarms: [] };
    assert.equal(supervisorScore(84, undefined, undefined), 84);
    assert.equal(supervisorScore(84, vc, undefined), Math.max(0, 84 - vcenterPenalty(vc)));
    assert.ok(supervisorScore(84, vc, undefined) < 84);
  });
});

describe('the walk-down', () => {
  const cluster: any = { key: 'k', name: 'checkout', namespace: 'ns', supervisorId: 'demo', machines: [{ name: 'checkout-np-1-a', nodeName: 'checkout-np-1-a', ready: true, role: 'worker' }] };
  test('a lower Supervisor score from unrelated causes is shown but not blamed', () => {
    const w = walkDown({ cluster, node: 'checkout-np-1-a', supervisorScore: 64, supervisorStaleControllers: 0 } as any);
    const sv = w.layers.find(l => l.layer === 'Supervisor')!;
    assert.equal(sv.state, 'ok');
    assert.match(sv.facts.join(' '), /Health 64\/100.*Controllers renewing/);
    assert.notEqual(w.likely?.layer, 'Supervisor');
  });
  test('stale controllers make it the likely cause', () => {
    const w = walkDown({ cluster, node: 'checkout-np-1-a', supervisorScore: 70, supervisorStaleControllers: 2 } as any);
    assert.equal(w.likely?.layer, 'Supervisor');
  });
});

describe('the demo', () => {
  test('every in-cluster read succeeds (no "some details not readable")', async () => {
    setDemoScale(4);
    for (const c of demoClusters()) {
      const h = await fetchWorkloadHealth(demoClient(contextName(c.name), { latencyMs: 0, remember: false }), contextName(c.name));
      assert.deepEqual(h.partial, [], c.name);
    }
  });
});
