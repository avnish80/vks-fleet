/** v1.24: the demo fleet at scale, and the fleet roll-ups the scaled pages rely on. */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { demoClient, demoStores, DEMO_SUPERVISOR_RAW } from '../src/demo';
import { baseName, DEMO_SUPERVISOR, demoClusters, demoContexts, setDemoScale } from '../src/demo/supervisor';
import { normalizeConfig } from '../src/config';
import { fetchSupervisor } from '../src/fleet';

afterEach(() => setDemoScale(4));

describe('demo fleet size', () => {
  test('four by default; clones with numbered names beyond that', () => {
    assert.equal(demoClusters().length, 4);
    setDemoScale(20);
    const cs = demoClusters();
    assert.equal(cs.length, 20);
    assert.equal(new Set(cs.map(c => c.name)).size, 20, 'names are unique');
    assert.deepEqual(cs.slice(4, 8).map(c => c.name), ['payments-2', 'checkout-2', 'sandbox-2', 'analytics-2']);
    assert.equal(baseName(cs[5]), 'checkout', 'special cases key on the base name');
    assert.equal(demoContexts().length, 21, 'the Supervisor and one context per cluster');
  });
  test('bounded, and the stores rebuild when the size changes', async () => {
    setDemoScale(1000);
    assert.equal(demoClusters().length, 200);
    setDemoScale(12);
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const sv = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any] } as any).supervisors[0];
    const r = await fetchSupervisor(sv, demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 }), NOW);
    assert.equal(r.clusters.length, 12);
    assert.ok(r.clusters.some(c => c.name === 'checkout-3' && c.machines.some(m => m.deletingSince)), 'problems repeat in the clones');
  });
});
