/** v1.39.1: each cluster is measured against the CIS benchmark written for its Kubernetes version. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alignToBenchmark, cisBenchmark, cisCoverage, CIS_ITEMS, controlRef, kubeMinor } from '../src/benchmark';
import { CONTROL_COUNT, evaluateCompliance } from '../src/compliance';
import { securityRows, vulnCounts } from '../src/securityOverview';

const EMPTY: any = { kubelets: [], pods: [], namespaces: [], networkPolicies: [], clusterRoles: [], clusterRoleBindings: [], serviceAccounts: [] };

describe('CIS benchmark by Kubernetes version', () => {
  test('the benchmark follows the cluster\'s Kubernetes version', () => {
    const b = (v?: string) => { const x = cisBenchmark(v); return [x.version, x.profile, x.exact, x.beyond]; };
    assert.deepEqual(b('v1.35.0+vmware.1'), ['2.0', 'cis-2.0', true, false]);
    assert.deepEqual(b('v1.34.1+vmware.2-fips'), ['2.0', 'cis-2.0', true, false]);
    // Newer than any benchmark covers: the newest one, and marked.
    assert.deepEqual(b('v1.36.2+vmware.1'), ['2.0', 'cis-2.0', true, true]);
    assert.deepEqual(b('v1.33.4'), ['1.12', 'cis-1.12', true, false]);
    assert.deepEqual(b('1.32.0'), ['1.12', 'cis-1.12', true, false]);
    assert.deepEqual(b('v1.31.9'), ['1.11', 'cis-1.11', false, false]);
    assert.deepEqual(b('v1.28.2'), ['1.10', 'cis-1.10', false, false]);
    // Not known: the newest, not marked as beyond.
    assert.deepEqual(b(undefined), ['2.0', 'cis-2.0', true, false]);
    assert.equal(cisBenchmark('v1.35.0').fallbackProfile, 'cis-1.12');
    assert.equal(cisBenchmark('v1.33.0').fallbackProfile, undefined);
    assert.deepEqual([kubeMinor('v1.36.2+vmware.1'), kubeMinor('1.9.0'), kubeMinor('main'), kubeMinor(undefined)], [36, 9, undefined, undefined]);
  });
  test('every check is mapped to recommendation numbers, or is deliberately outside CIS', () => {
    const results = evaluateCompliance(EMPTY);
    assert.equal(results.length, CONTROL_COUNT);
    const unmapped = results.filter(r => r.frameworks.includes('cis') && !CIS_ITEMS[r.id]).map(r => r.id);
    // Kernel defaults was a recommendation in older benchmarks; v1.12 and v2.0 have no counterpart.
    assert.deepEqual(unmapped, ['KUBELET-KERNEL']);
    for (const id of Object.keys(CIS_ITEMS)) assert.ok(results.some(r => r.id === id), `${id} is a real check`);
    for (const items of Object.values(CIS_ITEMS)) for (const i of items) assert.match(i, /^\d(\.\d+){1,2}(-\d(\.\d+){1,2})?$/);
  });
  test('coverage of CIS v2.0: what is assessed, and what is not, by number', () => {
    const c = cisCoverage();
    assert.deepEqual([c.total, c.assessed, c.notAssessed.length], [131, 98, 33]);
    assert.ok(c.notAssessed.includes('1.2.9') && c.notAssessed.includes('2.7') && c.notAssessed.includes('5.5.1') && c.notAssessed.includes('4.3.1'));
    assert.ok(!c.notAssessed.includes('1.1.21') && !c.notAssessed.includes('2.3') && !c.notAssessed.includes('5.6.4'));
  });
  test('a check\'s reference names the benchmark and the recommendation; older benchmarks keep the section', () => {
    const v2 = cisBenchmark('v1.35.0');
    const v112 = cisBenchmark('v1.33.0');
    const v111 = cisBenchmark('v1.30.0');
    assert.equal(controlRef({ id: 'API-AUTHZ', ref: 'CIS 1.2' }, v2), 'CIS 2.0: 1.2.6-1.2.8');
    assert.equal(controlRef({ id: 'API-AUTHZ', ref: 'CIS 1.2' }, v112), 'CIS 1.12: 1.2.6-1.2.8');
    assert.equal(controlRef({ id: 'API-AUTHZ', ref: 'CIS 1.2' }, v111), 'CIS 1.11: section 1.2');
    assert.equal(controlRef({ id: 'GEN-SECCOMP', ref: 'CIS 5.6' }, v2), 'CIS 2.0: 5.6.2');
    assert.equal(controlRef({ id: 'API-AUDIT', ref: 'CIS 1.2 / 3.2' }, v2), 'CIS 2.0: 1.2.16, 3.2.1');
    assert.equal(controlRef({ id: 'GEN-QUOTAS', ref: 'NSA/CISA' }, v2), 'NSA/CISA');
  });
  test('aligning a cluster\'s results: references rewritten, a check outside the benchmark left out, NSA-only kept', () => {
    const results = evaluateCompliance(EMPTY);
    const v2 = alignToBenchmark(results, cisBenchmark('v1.36.2+vmware.1'));
    assert.equal(v2.length, results.length - 1);
    assert.ok(!v2.some(r => r.id === 'KUBELET-KERNEL'));
    assert.ok(v2.some(r => r.id === 'GEN-QUOTAS' && r.ref === 'NSA/CISA'));
    assert.ok(v2.filter(r => r.frameworks.includes('cis')).every(r => r.ref.startsWith('CIS 2.0: ')));
    assert.equal(v2.find(r => r.id === 'NODE-FILES')!.ref, 'CIS 2.0: 4.1.1-4.1.10');
    // An older cluster keeps every check, with section references.
    const v111 = alignToBenchmark(results, cisBenchmark('v1.30.0'));
    assert.equal(v111.length, results.length);
    assert.equal(v111.find(r => r.id === 'KUBELET-KERNEL')!.ref, 'CIS 1.11: section 4.2');
  });
});

describe('vulnerabilities, counted as the Vulnerabilities tab counts them', () => {
  const counts = (c: number, h: number) => ({ CRITICAL: c, HIGH: h, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
  const img = (image: string, owner: string, c: number, h: number): any => ({ image, owner, namespace: 'ns', workload: 'w', counts: counts(c, h), top: [], fixable: 0 });
  const report = (cluster: string, images: any[], o: any = {}): any => ({ clusterKey: `s/ns/${cluster}`, clusterName: cluster, contextName: cluster, trivy: true, images, audits: [], exposedSecrets: [], compliance: [], policyEngine: false, policy: [], policySummary: {}, errors: [], ...o });
  test('an image is counted once however many pods run it; yours apart from VKS-managed', () => {
    const r = report('a', [img('app:1', 'you', 3, 4), img('app:1', 'you', 3, 4), img('app:1', 'you', 3, 4), img('db:2', 'you', 1, 0), img('calico:3', 'vks', 10, 50), img('calico:3', 'vks', 10, 50)]);
    assert.deepEqual(vulnCounts([r]), { critical: 4, high: 4, vksCritical: 10, vksHigh: 50 });
    // Across clusters, the same image is still one image.
    assert.deepEqual(vulnCounts([r, report('b', [img('app:1', 'you', 3, 4)])]), { critical: 4, high: 4, vksCritical: 10, vksHigh: 50 });
  });
  test('a cluster row says what it is measured with, and a missing scanner is "not measured"', () => {
    const scan = (name: string): any => ({ clusterKey: `s/ns/${name}`, clusterName: name, contextName: name, workloads: [], security: [], gitops: [], namespaces: [], compliance: [], stuckNodes: [], at: '', errors: [], benchmark: '2.0', benchmarkBeyond: name === 'a' });
    const rows = securityRows({
      scans: [scan('a'), scan('b')],
      reports: [report('a', [img('app:1', 'you', 2, 0), img('app:1', 'you', 2, 0)], { policyEngine: true }), report('b', [], { trivy: false })],
      nodeScans: new Map([['s/ns/b', [{ at: '2026-10-01T00:00:00Z', target: 'worker', tests: [] } as any]]]),
      silences: [],
      now: new Date('2026-10-12T00:00:00Z'),
    });
    const a = rows.find(r => r.clusterName === 'a')!;
    const b = rows.find(r => r.clusterName === 'b')!;
    assert.deepEqual([a.vulns, a.sources, a.benchmark, a.benchmarkBeyond], [{ critical: 2, high: 0, vksCritical: 0, vksHigh: 0 }, { nodeScan: false, scanner: true, policyEngine: true }, '2.0', true]);
    assert.deepEqual([b.vulns, b.sources, b.nodeScanDays], [undefined, { nodeScan: true, scanner: false, policyEngine: false }, 11]);
  });
});
