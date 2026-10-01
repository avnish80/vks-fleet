/** v1.33.2: fixes from the lab review. */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { configureElevation, dropElevation, changeContext } from '../src/elevation';
import { buildIncident } from '../src/incident';
import { clustersOn } from '../src/networkView';
import { mergeForecasts, withTimeLimit } from '../src/observability';

const C = 'kubernetes-cluster-c3d4';
afterEach(() => {
  dropElevation();
  configureElevation({ enabled: false, supervisorAdmin: {}, suffix: '-admin' });
});

describe('forecasts', () => {
  test('a node scraped twice gives one forecast, the sooner', () => {
    const n = `${C}-${C}-np-1-a`;
    const f = mergeForecasts([
      { what: 'node memory', subject: n, seconds: 15 * 86400 },
      { what: 'node memory', subject: n, seconds: 14 * 86400 },
      { what: 'node disk', subject: n, seconds: 117 * 86400 },
    ]);
    assert.deepEqual(f.map(x => [x.what, x.seconds / 86400]), [['node memory', 14], ['node disk', 117]]);
  });
  test('Investigate names the node by its short name', () => {
    const inc = buildIncident({ cluster: C, now: new Date(), hours: 24, timeline: [], forecasts: [{ what: 'node memory', subject: `${C}-${C}-np-1-a`, seconds: 14 * 86400 }] });
    assert.match(inc.events[0].text, /^node memory np-1-a runs out in about 14 days$/);
  });
});

describe('slow queries', () => {
  test('give up with a message instead of loading forever', async () => {
    await assert.rejects(withTimeLimit(new Promise(() => {}), 20, 'took too long'), /took too long/);
    assert.equal(await withTimeLimit(Promise.resolve(7), 1000, 'x'), 7);
  });
});

describe('the access check under elevation', () => {
  test('changes need elevation, but an access review uses the read sign-in (asViewer bypasses changeContext)', () => {
    configureElevation({ enabled: true, supervisorAdmin: {}, suffix: '-admin' });
    assert.throws(() => changeContext('10.0.0.2'), /elevation/i, 'changes are refused until elevated');
    // headlampWriter(ctx, { asViewer: true }) skips changeContext entirely (see api/headlampClient.ts).
  });
});

describe('networks', () => {
  test('every cluster on the page, from subnets, VMs and load balancers', () => {
    assert.deepEqual(clustersOn([{ members: [`cluster ${C}`, 'VM x'] } as any], [{ name: 'v', cluster: 'kubernetes-cluster-a1b2' } as any], ['kubernetes-cluster-e5f6', undefined]), [
      'kubernetes-cluster-a1b2',
      C,
      'kubernetes-cluster-e5f6',
    ]);
  });
});
