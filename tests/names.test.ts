/** v1.29: readable names, and a certificate finding keeps its identity as its days count down. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { commonPrefix, shortener, shortNode } from '../src/names';
import { securityIssueId } from '../src/scanIssues';

describe('names', () => {
  test('a shared prefix is dropped only when it leaves every name something', () => {
    assert.equal(commonPrefix(['kubernetes-cluster-9yfw', 'kubernetes-cluster-mnet']), 'kubernetes-cluster-');
    assert.equal(commonPrefix(['payments', 'checkout']), '');
    assert.equal(commonPrefix(['kubernetes-cluster-9yfw']), '', 'a single cluster keeps its name');
    assert.equal(shortener(['kubernetes-cluster-9yfw', 'kubernetes-cluster-mnet'])('kubernetes-cluster-mnet'), 'mnet');
  });
  test("a node's name without its cluster's (VKS can repeat it)", () => {
    assert.equal(shortNode('kubernetes-cluster-mnet', 'kubernetes-cluster-mnet-kubernetes-cluster-mnet-np-1-7d8jrql2vq'), 'np-1-7d8jrql2vq');
    assert.equal(shortNode('kubernetes-cluster-mnet', 'kubernetes-cluster-mnet-qmdg9-zqwqq'), 'qmdg9-zqwqq');
    assert.equal(shortNode('a', 'other-node'), 'other-node');
  });
});

describe('certificate findings keep one identity', () => {
  test('the same certificate on different days is the same issue (so silences and "since you last looked" hold)', () => {
    const f = (days: number) => ({ kind: 'cert' as const, title: `Certificate vks-system-ingress/contour-cert expires in ${days} days`, key: 'expiry:vks-system-ingress/contour-cert' });
    assert.equal(securityIssueId('k', f(20)), securityIssueId('k', f(17)));
    assert.notEqual(securityIssueId('k', { kind: 'psa', title: 'A' }), securityIssueId('k', { kind: 'psa', title: 'B' }), 'findings without a key still use their title');
  });
});
