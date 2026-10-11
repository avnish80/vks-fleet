/** v1.39: the security overview, built from what the Posture, Compliance and Vulnerabilities tabs collect. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { complianceIssueId } from '../src/compliance';
import { recommendations } from '../src/recommendations';
import { securityIssueId } from '../src/scanIssues';
import { acceptedRisks, evidencePack, failingControls, securityRows, securityScore } from '../src/securityOverview';
import { FORECASTS } from '../src/observability';

const NOW = new Date('2026-10-10T08:00:00Z');
const control = (id: string, status: string, owner = 'you', o: any = {}): any => ({ id, frameworks: ['cis'], ref: `CIS ${id}`, section: 's', title: `Control ${id}`, level: 1, owner, method: 'api', status, evidence: '', remediation: `Fix ${id}`, ...o });
const finding = (kind: string, severity: string, objects: string[], title = `${kind} finding`): any => ({ clusterKey: '', clusterName: '', kind, severity, title, detail: '', objects });
const scan = (name: string, compliance: any[], o: any = {}): any => ({ clusterKey: `s/ns/${name}`, clusterName: name, contextName: name, workloads: [], security: [], gitops: [], namespaces: [], compliance, stuckNodes: [], at: NOW.toISOString(), errors: [], ...o });
const silence = (issueId: string, until: string, label = 'accepted'): any => ({ id: issueId, match: { issueId }, label, reason: 'agreed with the owner', createdAt: '2026-10-01T00:00:00Z', until });

const a = scan('a', [control('1', 'pass'), control('2', 'fail'), control('3', 'fail', 'vks'), control('4', 'review'), control('9', 'fail', 'you', { frameworks: ['nsa'] })], {
  psaDefault: 'baseline',
  namespaces: [{ name: 'x', enforce: 'privileged' }, { name: 'y', enforce: 'baseline' }],
  security: [finding('privileged', 'warning', ['ns/p1', 'ns/p2']), finding('cluster-admin', 'warning', ['bob']), finding('psa', 'info', ['z']), finding('cert', 'critical', ['c1'])],
});
const b = scan('b', [control('1', 'pass'), control('2', 'fail'), control('3', 'pass', 'vks'), control('4', 'pass')]);
const input = (o: any = {}) => ({ scans: [a, b], silences: [], now: NOW, ...o });

describe('security overview', () => {
  test('one row per cluster, the lowest compliance first, CIS controls only', () => {
    const rows = securityRows(input());
    assert.deepEqual(rows.map(r => [r.clusterName, r.compliance.pct, r.failing]), [['a', 33, 2], ['b', 75, 1]]);
    const ra = rows[0];
    assert.deepEqual([ra.psaDefault, ra.privilegedNamespaces, ra.namespaces, ra.privilegedPods, ra.adminGrants, ra.criticalFindings, ra.accepted], ['baseline', 1, 2, 2, 1, 1, 0]);
    // No scanner and no node scan: said so, not shown as zero.
    assert.deepEqual([ra.vulns, ra.nodeScanDays], [undefined, undefined]);
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
    assert.deepEqual([ra.compliance.pct, ra.failing, ra.adminGrants, ra.accepted], [67, 1, 0, 2]);
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
  test('vulnerabilities and node scans, when a cluster has them', () => {
    const counts = (c: number, h: number) => ({ CRITICAL: c, HIGH: h, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
    const reports: any[] = [
      { clusterKey: a.clusterKey, clusterName: 'a', trivy: true, images: [{ counts: counts(2, 5), top: [] }, { counts: counts(1, 0), top: [] }], audits: [], exposedSecrets: [], compliance: [], policy: [] },
      { clusterKey: b.clusterKey, clusterName: 'b', trivy: false, images: [] },
    ];
    const nodeScans = new Map<string, any[]>([[a.clusterKey, [{ at: '2026-10-07T07:00:00Z', target: 'worker', tests: [] }, { at: '2026-09-01T00:00:00Z', target: 'control-plane', tests: [] }]]]);
    const rows = securityRows(input({ reports, nodeScans }));
    const ra = rows.find(r => r.clusterName === 'a')!;
    const rb = rows.find(r => r.clusterName === 'b')!;
    assert.deepEqual([ra.vulns, ra.nodeScanDays, rb.vulns, rb.nodeScanDays], [{ critical: 3, high: 5 }, 3, undefined, undefined]);
  });
  test('the evidence pack is one document with every part', () => {
    const md = evidencePack(input({ silences: [silence(complianceIssueId(a.clusterKey, '2'), '2026-11-01T00:00:00Z', 'Control 2 on a')] }));
    for (const heading of ['# VKS fleet security evidence', '## Summary', '## Clusters', '## Controls failing across the fleet', '## Posture findings', '## Vulnerabilities']) assert.ok(md.includes(heading), heading);
    assert.match(md, /Security score: 71%/);
    assert.match(md, /Accepted risks: 1 \(the first acceptance ends 2026-11-01: Control 2 on a\)/);
    assert.match(md, /\| a \| 67% \| 1 \| baseline \| 1 of 2 \| 2 \| 1 \| — \| — \| never \| 1 \|/);
    assert.match(md, /No cluster has a vulnerability scanner/);
    assert.match(md, /Not a certified CIS assessment/);
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
