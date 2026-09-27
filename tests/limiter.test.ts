import assert from 'node:assert/strict';
import { test } from 'node:test';
import { limited, MAX_PER_CLUSTER, MAX_TOTAL, requestStats } from '../src/api/limiter';
test('caps concurrency per cluster and overall, and counts', async () => {
  let now = 0, peakTotal = 0; const peak = new Map<string, number>(); const cur = new Map<string, number>();
  const job = (c: string, fail = false) => limited(c, async () => {
    now++; cur.set(c, (cur.get(c) ?? 0) + 1); peakTotal = Math.max(peakTotal, now); peak.set(c, Math.max(peak.get(c) ?? 0, cur.get(c)!));
    await new Promise(r => setTimeout(r, 5));
    now--; cur.set(c, cur.get(c)! - 1);
    if (fail) throw new Error('boom'); return c;
  });
  const all = [];
  for (let i = 0; i < 10; i++) for (let k = 0; k < 20; k++) all.push(job(`c${i}`, k === 0).catch(() => 'err'));
  const out = await Promise.all(all);
  assert.equal(out.length, 200);
  assert.ok(Math.max(...peak.values()) <= MAX_PER_CLUSTER, 'per-cluster cap');
  assert.ok(peakTotal <= MAX_TOTAL, 'overall cap');
  const st = requestStats();
  assert.equal(st.clusters.reduce((n, c) => n + c.requests, 0), 200);
  assert.equal(st.clusters.reduce((n, c) => n + c.errors, 0), 10);
  assert.equal(st.inFlight, 0); assert.equal(st.waiting, 0);
});

import { forgetServed, isListPath, rememberingGet } from '../src/api/served';

test('lists that are not installed are remembered; named objects never are', async () => {
  forgetServed();
  assert.equal(isListPath('/apis/argoproj.io/v1alpha1/applications'), true);
  assert.equal(isListPath('/api/v1/namespaces/x/pods?labelSelector=a%3Db'), true);
  assert.equal(isListPath('/api/v1/namespaces/vks-fleet-scan/configmaps/kube-bench-results'), false);
  assert.equal(isListPath('/api/v1/namespaces/default'), false);
  let calls = 0;
  const notFound = async () => { calls++; throw Object.assign(new Error('nf'), { status: 404 }); };
  await assert.rejects(rememberingGet('c', '/apis/argoproj.io/v1alpha1/applications', notFound));
  await assert.rejects(rememberingGet('c', '/apis/argoproj.io/v1alpha1/applications', notFound));
  assert.equal(calls, 1, 'second list is answered from memory');
  await assert.rejects(rememberingGet('other', '/apis/argoproj.io/v1alpha1/applications', notFound));
  assert.equal(calls, 2, 'memory is per cluster');
  await assert.rejects(rememberingGet('c', '/api/v1/namespaces/vks-fleet-scan/configmaps/kube-bench-results', notFound));
  await assert.rejects(rememberingGet('c', '/api/v1/namespaces/vks-fleet-scan/configmaps/kube-bench-results', notFound));
  assert.equal(calls, 4, 'a named object is always asked for (it may appear any moment)');
  await assert.rejects(rememberingGet('c', '/apis/argoproj.io/v1alpha1/applications', notFound, Date.now() + 11 * 60 * 1000));
  assert.equal(calls, 5, 'forgotten after ten minutes, so newly installed tools show up');
});
