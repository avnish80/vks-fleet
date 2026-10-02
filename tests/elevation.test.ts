/** Read by default, elevate to change; and the fixes from the Supervisor health review. */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { limited, requestStats } from '../src/api/limiter';
import { changeContext, configureElevation, current, dropElevation, elevate, ElevationRequired, stamp } from '../src/elevation';
import { analyseService } from '../src/supervisorHealth';

const cfg = { enabled: true, supervisorAdmin: { '10.150.4.2': '10.150.4.2-admin' }, suffix: '-admin' };
afterEach(() => {
  dropElevation();
  configureElevation({ enabled: false, supervisorAdmin: {}, suffix: '-admin' });
});

describe('elevation', () => {
  test('off: changes use the context they are given', () => {
    assert.deepEqual(changeContext('kubernetes-cluster-mnet'), { context: 'kubernetes-cluster-mnet', elevated: false });
  });
  test('on but not elevated: changes are refused with a clear message', () => {
    configureElevation(cfg);
    assert.throws(() => changeContext('10.150.4.2'), (e: Error) => e instanceof ElevationRequired && /Elevate/.test(e.message));
  });
  test('elevated: Supervisor and cluster changes go to the admin contexts', () => {
    configureElevation(cfg);
    elevate(15, 'replace a stuck node');
    assert.deepEqual(changeContext('10.150.4.2'), { context: '10.150.4.2-admin', elevated: true });
    assert.deepEqual(changeContext('kubernetes-cluster-mnet'), { context: 'kubernetes-cluster-mnet-admin', elevated: true });
  });
  test('ends by itself when the time is up', () => {
    configureElevation(cfg);
    const now = Date.now();
    elevate(5, 'short job', now);
    assert.ok(current(now + 4 * 60_000));
    assert.equal(current(now + 5 * 60_000 + 1), null);
    assert.throws(() => changeContext('10.150.4.2', now + 6 * 60_000));
  });
  test('turning elevation off drops an active elevation', () => {
    configureElevation(cfg);
    elevate(15, 'x y z');
    configureElevation({ ...cfg, enabled: false });
    assert.equal(current(), null);
  });
  test('the reason is stamped on created objects and merge patches only', () => {
    const e = { since: Date.parse('2026-09-28T01:00:00Z'), until: Date.parse('2026-09-28T01:15:00Z'), reason: 'replace a stuck node' };
    const post = stamp({ method: 'POST', path: '/x', body: { metadata: { name: 'a', annotations: { keep: '1' } } } }, e) as any;
    assert.deepEqual(post.body.metadata.annotations, { keep: '1', 'vks-fleet/elevated': '2026-09-28T01:00:00.000Z', 'vks-fleet/elevation-reason': 'replace a stuck node' });
    const merge = stamp({ method: 'PATCH', path: '/x', contentType: 'application/merge-patch+json', body: { spec: { paused: true } } }, e) as any;
    assert.equal(merge.body.metadata.annotations['vks-fleet/elevation-reason'], 'replace a stuck node');
    const jsonPatch = { method: 'PATCH' as const, path: '/x', contentType: 'application/json-patch+json', body: [{ op: 'remove', path: '/spec/nodeName' }] };
    assert.equal(stamp(jsonPatch, e), jsonPatch, 'JSON patches are left alone');
    const del = { method: 'DELETE' as const, path: '/x' };
    assert.equal(stamp(del, e), del);
    const plain = { method: 'POST' as const, path: '/x', body: { a: 1 } };
    assert.equal(stamp(plain, null), plain, 'not elevated: unchanged');
  });
});

describe('fixes from the Supervisor health review', () => {
  test('a service with only finished Jobs is not "down" (it was: 6/7 and health 70 in the lab)', () => {
    const job = (n: string) => ({ metadata: { name: n, ownerReferences: [{ kind: 'Job', name: 'j', uid: 'j' }] }, spec: { nodeName: 'esx-05a' }, status: { phase: 'Succeeded' } });
    const s = analyseService('svc-tkg-g6r11', [job('install-1'), job('install-2')], new Date());
    assert.equal(s.state, 'ok');
    assert.equal(s.failing.length, 0);
  });
  test('denied and not-found answers are not counted as errors', async () => {
    const fail = (status?: number) => limited('ctx-review', async () => {
      throw Object.assign(new Error('x'), { status });
    }).catch(() => undefined);
    await Promise.all([fail(403), fail(404), fail(404), fail(500), fail(undefined)]);
    const st = requestStats().clusters.find(c => c.cluster === 'ctx-review')!;
    assert.deepEqual([st.requests, st.errors, st.expected], [5, 2, 3]);
  });
});

describe('elevation needs its admin contexts', () => {
  test("lists the admin contexts Headlamp doesn't have", async () => {
    const { configureElevation, missingAdminContexts } = await import('../src/elevation');
    configureElevation({ enabled: true, suffix: '-admin', supervisorAdmin: { '10.0.0.2': '10.0.0.2-admin' } });
    assert.deepEqual(missingAdminContexts(['10.0.0.2', 'kubernetes-cluster-a1b2']), ['10.0.0.2-admin']);
    assert.deepEqual(missingAdminContexts(['10.0.0.2', '10.0.0.2-admin']), []);
    configureElevation({ enabled: false, suffix: '-admin', supervisorAdmin: {} });
  });
});
