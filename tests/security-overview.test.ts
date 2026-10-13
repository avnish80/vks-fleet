/** The security overview, built from what the Posture, Compliance and Vulnerabilities tabs collect. Generic CIS checks join it only when switched on (v1.40). */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { complianceIssueId } from '../src/compliance';
import { recommendations } from '../src/recommendations';
import { securityIssueId } from '../src/scanIssues';
import { acceptedRisks, evidencePack, failingControls, securityRows, securityScore } from '../src/securityOverview';
import { FORECASTS } from '../src/observability';

const NOW = new Date('2026-10-10T08:00:00Z');
const control = (id: string, status: string, owner = 'you', o: any = {}): any => ({ id, ref: `CIS ${id}`, section: 's', title: `Control ${id}`, level: 1, owner, method: 'api', status, evidence: '', remediation: `Fix ${id}`, ...o });
const finding = (kind: string, severity: string, objects: string[], title = `${kind} finding`): any => ({ clusterKey: '', clusterName: '', kind, severity, title, detail: '', objects });
const scan = (name: string, compliance: any[], o: any = {}): any => ({ clusterKey: `s/ns/${name}`, clusterName: name, contextName: name, workloads: [], security: [], gitops: [], namespaces: [], compliance, stuckNodes: [], at: NOW.toISOString(), errors: [], ...o });
const silence = (issueId: string, until: string, label = 'accepted'): any => ({ id: issueId, match: { issueId }, label, reason: 'agreed with the owner', createdAt: '2026-10-01T00:00:00Z', until });

const a = scan('a', [control('1', 'pass'), control('2', 'fail'), control('3', 'fail', 'vks'), control('4', 'review')], {
  psaDefault: 'baseline',
  namespaces: [{ name: 'x', enforce: 'privileged' }, { name: 'y', enforce: 'baseline' }],
  security: [finding('privileged', 'warning', ['ns/p1', 'ns/p2']), finding('cluster-admin', 'warning', ['bob']), finding('psa', 'info', ['z']), finding('cert', 'critical', ['c1'])],
});
const b = scan('b', [control('1', 'pass'), control('2', 'fail'), control('3', 'pass', 'vks'), control('4', 'pass')]);
/** With the generic CIS checks switched on, unless a test says otherwise. */
const input = (o: any = {}) => ({ scans: [a, b], cis: true, silences: [], now: NOW, ...o });

describe('security overview', () => {
  test('with the generic CIS checks on: one row per cluster, the lowest result first', () => {
    const rows = securityRows(input());
    assert.deepEqual(rows.map(r => [r.clusterName, r.compliance!.pct, r.failing]), [['a', 33, 2], ['b', 75, 1]]);
    const ra = rows[0];
    assert.deepEqual([ra.psaDefault, ra.privilegedNamespaces, ra.namespaces, ra.privilegedPods, ra.adminGrants, ra.criticalFindings, ra.accepted], ['baseline', 1, 2, 2, 1, 1, 0]);
    // No scanner: said so, not shown as zero.
    assert.equal(ra.vulns, undefined);
  });
  test('the score is every cluster\'s checks together, the same arithmetic as Compliance', () => {
    const s = securityScore(input())!;
    assert.deepEqual([s.pass, s.fail, s.scored, s.pct], [4, 3, 7, 57]);
    assert.equal(securityScore(input({ scans: [] })), undefined);
    assert.equal(securityScore(input({ scans: [scan('c', [control('1', 'review')])] })), undefined);
  });
  test('an accepted control counts as passing, and is counted as an accepted risk', () => {
    const silences = [silence(complianceIssueId(a.clusterKey, '2'), '2026-11-01T00:00:00Z', 'Control 2 on a'), silence(securityIssueId(a.clusterKey, a.security[1]), '2026-10-20T00:00:00Z', 'bob is the admin')];
    const rows = securityRows(input({ silences }));
    const ra = rows.find(r => r.clusterName === 'a')!;
    assert.deepEqual([ra.compliance!.pct, ra.failing, ra.adminGrants, ra.accepted], [67, 1, 0, 2]);
    assert.equal(securityScore(input({ silences }))!.pct, 71);
    const risks = acceptedRisks(input({ silences }));
    assert.deepEqual([risks.count, risks.next?.label, risks.next?.days], [2, 'bob is the admin', 10]);
    assert.deepEqual(acceptedRisks(input()), { count: 0, next: undefined });
  });
  test('fix once: the most widespread control first; yours before what VKS manages', () => {
    const failing = failingControls(input());
    assert.deepEqual(failing.map(f => [f.id, f.owner, f.clusters]), [['2', 'you', ['a', 'b']], ['3', 'vks', ['a']]]);
    const waived = failingControls(input({ silences: [silence(complianceIssueId(b.clusterKey, '2'), '2026-11-01T00:00:00Z')] }));
    assert.deepEqual(waived.map(f => [f.id, f.clusters]), [['2', ['a']], ['3', ['a']]]);
    const tie = failingControls(input({ scans: [scan('c', [control('7', 'fail', 'vks'), control('8', 'fail', 'you'), control('6', 'fail', 'shared')])] }));
    assert.deepEqual(tie.map(f => f.id), ['8', '6', '7']);
  });
  test('vulnerabilities, when a cluster has a scanner', () => {
    const counts = (c: number, h: number) => ({ CRITICAL: c, HIGH: h, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
    const reports: any[] = [
      { clusterKey: a.clusterKey, clusterName: 'a', trivy: true, images: [{ image: 'app:1', owner: 'you', namespace: 'n', workload: 'w', counts: counts(2, 5), top: [] }, { image: 'db:1', owner: 'you', namespace: 'n', workload: 'w', counts: counts(1, 0), top: [] }, { image: 'cni:1', owner: 'vks', namespace: 'n', workload: 'w', counts: counts(7, 9), top: [] }], audits: [], exposedSecrets: [], compliance: [], policy: [] },
      { clusterKey: b.clusterKey, clusterName: 'b', trivy: false, images: [] },
    ];
    const rows = securityRows(input({ reports }));
    const ra = rows.find(r => r.clusterName === 'a')!;
    const rb = rows.find(r => r.clusterName === 'b')!;
    assert.deepEqual([ra.vulns, rb.vulns], [{ critical: 3, high: 5, vksCritical: 7, vksHigh: 9 }, undefined]);
  });
  test('by default there is no benchmark anywhere: no score, no failing controls, no benchmark columns', () => {
    const off = input({ cis: false, silences: [silence(complianceIssueId(a.clusterKey, '2'), '2026-11-01T00:00:00Z', 'Control 2 on a')] });
    assert.equal(securityScore(off), undefined);
    assert.equal(securityScore({ scans: [a, b], silences: [], now: NOW }), undefined, 'off when not said');
    assert.deepEqual(failingControls(off), []);
    const rows = securityRows(off);
    // The cluster with the most open comes first; a has a critical finding, b has nothing.
    assert.deepEqual(rows.map(r => [r.clusterName, r.compliance, r.failing, r.benchmark]), [['a', undefined, undefined, undefined], ['b', undefined, undefined, undefined]]);
    assert.deepEqual([rows[0].privilegedPods, rows[0].adminGrants, rows[0].privilegedNamespaces], [2, 1, 1]);
    // A waived benchmark control is not an accepted risk while the checks are off.
    assert.equal(acceptedRisks(off).count, 0);
    const md = evidencePack(off);
    for (const heading of ['# VKS fleet security evidence', '## How this is measured', '## Summary', '## Clusters', '## Posture findings', '## Vulnerabilities']) assert.ok(md.includes(heading), heading);
    assert.match(md, /VMware does not publish or support a CIS benchmark for VKS, so this document makes no benchmark claim/);
    assert.ok(!md.includes('Benchmark result') && !md.includes('Control 2') && !md.includes('## Generic CIS'));
    assert.match(md, /\| a \| baseline \| 1 of 2 \| 2 \| 1 \| not measured \| not measured \| not measured \| 0 \|/);
  });
  test('with the generic CIS checks on, the evidence pack says they are generic and not a VKS benchmark', () => {
    const md = evidencePack(input({ silences: [silence(complianceIssueId(a.clusterKey, '2'), '2026-11-01T00:00:00Z', 'Control 2 on a')] }));
    for (const heading of ['# VKS fleet security evidence', '## Summary', '## Clusters', '## Generic CIS benchmark controls failing across the fleet', '## Posture findings', '## Vulnerabilities']) assert.ok(md.includes(heading), heading);
    assert.match(md, /Generic CIS benchmark result: 71%/);
    assert.match(md, /Accepted risks: 1 \(the first acceptance ends 2026-11-01: Control 2 on a\)/);
    assert.match(md, /\| a \| — \| 67% \| 1 \| baseline \| 1 of 2 \| 2 \| 1 \| not measured \| not measured \| not measured \| 1 \|/);
    assert.match(md, /VMware does not publish or support a CIS benchmark for VKS/);
    assert.match(md, /Of the 131 recommendations in v2\.0, 65 are assessed automatically through the Kubernetes API and 33 are listed for a person to review/);
    assert.match(md, /no cluster has a vulnerability scanner/);
    assert.match(md, /not a certified CIS assessment/);
  });
});

describe('1.39 follow-ups', () => {
  test('a backup tool that never produced a backup gets its own step, unless a baseline already flags it', () => {
    const c = (name: string): any => ({ key: `s/ns/${name}`, supervisorId: 's', namespace: 'ns', name, machines: [], nodePools: [] });
    const clusters = new Map([c('a'), c('b'), c('c'), c('d')].map(x => [x.key, x]));
    const backups = new Map<string, any>([['s/ns/a', { missing: true }], ['s/ns/b', { schedules: [] }], ['s/ns/c', { lastSuccess: {} }], ['s/ns/d', { error: 'forbidden' }]]);
    const recs = recommendations({ issues: [], clusters, cards: [], backups });
    assert.deepEqual(recs.map(r => [r.key, r.title, r.clusters.map(x => x.name)]).sort(), [
      ['first-backup', 'Schedule a first backup on 1 cluster', ['b']],
      ['install-backups', 'Install Velero and schedule backups on 1 cluster', ['a']],
    ]);
    const stale: any = { id: 's/ns/b#backup-stale', severity: 'warning', supervisorId: 's', clusterKey: 's/ns/b', title: 't', affected: { clusters: [], nodes: [], pods: [], tenants: [] } };
    assert.deepEqual(recommendations({ issues: [stale], clusters, cards: [], backups }).map(r => r.key).sort(), ['fix-backups', 'install-backups']);
  });
  test('node memory is forecast only when it falls over six hours and over a day', () => {
    const q = FORECASTS.find(f => f.what === 'node memory')!.query;
    assert.ok(q.includes('deriv(node_memory_MemAvailable_bytes[6h]) < 0') && q.includes('deriv(node_memory_MemAvailable_bytes[24h]) < 0'));
    // The later of the two estimates is the one reported.
    assert.match(q, /\[6h\]\)\) >= \(node_memory_MemAvailable_bytes \/ -deriv\(node_memory_MemAvailable_bytes\[24h\]\)\)\) or /);
    // The other forecasts are as they were.
    assert.ok(!FORECASTS.find(f => f.what === 'node disk')!.query.includes('24h'));
  });
});
