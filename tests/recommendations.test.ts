/** v1.38: recommended steps, between "Fix ready" and "Needs a decision". */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fleetScore, wallTiles } from '../src/fixes';
import { effectText, issueRecommendation, recommendations, recommendationsByIssue, recommendedChecks, triage } from '../src/recommendations';

const cluster = (name: string, o: any = {}): any => ({ key: `s/ns/${name}`, supervisorId: 's', namespace: 'ns', name, tenantId: 't', tenantName: 'org1', health: 'healthy', machines: [], nodePools: [], ...o });
const issue = (c: any | undefined, rule: string, severity = 'warning', o: any = {}): any => ({
  id: `${c?.key ?? 's'}#${rule}`, severity, supervisorId: 's', clusterKey: c?.key, clusterName: c?.name, title: rule, cause: '', evidence: [], fix: '', links: [], findingIds: [], detectedAt: '',
  affected: { clusters: [], nodes: [], pods: [], tenants: [] }, ...o,
});
const check = (id: string, status: string, weight = 2): any => ({ id, category: 'x', title: id, status, detail: '', weight });
const card = (c: any, checks: any[]): any => {
  const all = checks.reduce((n, x) => n + x.weight, 0);
  const got = checks.reduce((n, x) => n + x.weight * (x.status === 'pass' ? 1 : x.status === 'warn' ? 0.5 : 0), 0);
  return { clusterKey: c.key, score: Math.round((got / all) * 100), checks, evaluated: checks.length, total: checks.length };
};
const a = cluster('a');
const b = cluster('b');
const map = new Map([[a.key, a], [b.key, b]]);

describe('recommendations', () => {
  test('an issue has a recommended step only when there is no guaranteed fix, and never for information', () => {
    const r = issueRecommendation(issue(a, 'packages', 'critical'), a)!;
    assert.deepEqual([r.key, r.label, r.effort, r.simulated, r.path], ['reconcile-packages', 'Re-reconcile', 'one-click', true, '/vks-fleet/clusters/s/ns/a#packages']);
    // A paused cluster has a fix (Resume), so the fix comes first.
    assert.equal(issueRecommendation(issue(a, 'paused'), a), undefined);
    assert.equal(issueRecommendation(issue(a, 'behind', 'info'), a), undefined);
    // Things only the operator can judge stay a decision.
    for (const rule of ['scan#sec-cluster-admin-x', 'scan#sec-privileged-x', 'vulns#critical', 'limits#mem-ns', 'pods', 'unreachable']) assert.equal(issueRecommendation(issue(a, rule), a), undefined, rule);
  });
  test('each rule leads to the page where it is done', () => {
    const step = (rule: string, c: any | undefined = a) => issueRecommendation(issue(c, rule), c)!;
    assert.deepEqual([step('behind').key, step('behind').path, step('behind').simulated], ['upgrade', '/vks-fleet/upgrades', false]);
    assert.deepEqual([step('backup-stale').key, step('backup-failed').path], ['fix-backups', '/vks-fleet/clusters/s/ns/a#backups']);
    assert.equal(step('scan#storage-default').key, 'default-storageclass');
    assert.deepEqual([step('scan#sec-netpol-Namespaces without a network policy').key, step('scan#sec-netpol-x').path], ['network-policy', '/vks-fleet/security']);
    assert.deepEqual([step('forecast#volume#ns/data').key, step('forecast#volume#ns/data').effort], ['expand-volume', 'window']);
    assert.deepEqual([step('forecast#node memory#np-1').key, step('hot-np-1').key, step('hot-np-1').path], ['node-capacity', 'node-capacity', '/vks-fleet/preflight']);
    // A node's disk filling up: replacing the node clears it, from that node's own page when the cluster still has it.
    const withNode = cluster('a', { machines: [{ name: 'a-np-1-xyz', nodeName: 'np-1' }] });
    assert.deepEqual([step('forecast#node disk#np-1', withNode).key, step('forecast#node disk#np-1', withNode).effort, step('forecast#node disk#np-1', withNode).path], ['replace-node', 'one-click', '/vks-fleet/clusters/s/ns/a/machines/a-np-1-xyz']);
    assert.equal(step('forecast#node disk#gone').path, '/vks-fleet/clusters/s/ns/a#machines');
    // etcd filling up is not something a larger pool solves.
    assert.equal(issueRecommendation(issue(a, 'forecast#etcd#x'), a), undefined);
    // Supervisor-level leftovers: no cluster, and each kind is cleaned up on its own page.
    assert.deepEqual([step('cleanup', undefined).path, step('cleanup-cluster-ns/x', undefined).path], ['/vks-fleet/cleanup', '/vks-fleet/cleanup']);
    assert.deepEqual([step('svc-leftovers', undefined).path, step('service-leftovers', undefined).path], ['/vks-fleet/supervisor-health', '/vks-fleet/supervisor-health']);
  });
  test('the same step for several clusters is one recommendation, with what it clears', () => {
    const issues = [issue(a, 'packages', 'critical'), issue(b, 'packages'), issue(a, 'scan#sec-cluster-admin-x')];
    const cards = [card(a, [check('packages-ok', 'fail'), check('limits', 'pass', 6)]), card(b, [check('packages-ok', 'fail'), check('limits', 'pass', 6)])];
    const recs = recommendations({ issues, clusters: map, cards });
    assert.equal(recs.length, 1);
    const r = recs[0];
    assert.deepEqual([r.key, r.title, r.clusters.map(c => c.name), r.issueIds.length, r.urgent, r.points, r.path], ['reconcile-packages', 'Re-reconcile failing packages on 2 clusters', ['a', 'b'], 2, true, 25, '/vks-fleet/packages']);
    assert.equal(effectText(r), 'clears 2 issues · +25 points');
  });
  test('one cluster: the step opens that cluster, not the fleet page', () => {
    const r = recommendations({ issues: [issue(a, 'backup-stale')], clusters: map, cards: [] })[0];
    assert.deepEqual([r.title, r.path, effectText(r)], ['Get backups running again on 1 cluster', '/vks-fleet/clusters/s/ns/a#backups', 'clears 1 issue']);
  });
  test('gaps the score counts become recommendations without an issue; fixable checks are left to the fixes', () => {
    const cards = [card(a, [check('version', 'warn', 2), check('cp-ha', 'fail', 3), check('zones', 'warn', 2), check('health-check', 'warn', 3)])];
    const recs = recommendations({ issues: [], clusters: map, cards });
    assert.deepEqual(recs.map(r => r.key).sort(), ['node-repair', 'spread-zones', 'upgrade']);
    assert.ok(recs.every(r => r.issueIds.length === 0 && r.points > 0 && r.clusters.length === 1));
    // The control plane of 1 has a fix (scale to 3): it is not recommended a second time.
    assert.ok(!recs.some(r => r.key.includes('cp')));
    assert.match(effectText(recs[0]), /^\+\d+(\.\d)? points?$/);
  });
  test('no backup tool at all is a recommendation, though nothing failed', () => {
    const backups = new Map<string, any>([[a.key, { missing: true }], [b.key, { lastSuccess: {} }], ['gone', { missing: true }]]);
    const recs = recommendations({ issues: [], clusters: map, cards: [], backups });
    assert.deepEqual(recs.map(r => [r.key, r.title, r.clusters.map(c => c.name)]), [['install-backups', 'Install Velero and schedule backups on 1 cluster', ['a']]]);
    assert.equal(effectText(recs[0]), 'no open issue: a gap to close');
  });
  test('ranking: urgent first, then score points, then issues cleared, the cheaper step on a tie', () => {
    const issues = [issue(a, 'backup-stale'), issue(b, 'backup-failed'), issue(a, 'forecast#volume#ns/data'), issue(undefined, 'cleanup'), issue(a, 'scan#storage-default')];
    const cards = [card(a, [check('version', 'fail', 2), check('limits', 'pass', 8)])];
    const recs = recommendations({ issues, clusters: map, cards });
    assert.deepEqual(recs.map(r => r.key), ['expand-volume', 'upgrade', 'fix-backups', 'cleanup', 'default-storageclass']);
    assert.equal(recs[3].title, 'Clean up 1 set of leftovers');
  });
  test('short names are used for clusters', () => {
    const r = recommendations({ issues: [issue(a, 'packages')], clusters: map, cards: [], short: n => n.toUpperCase() })[0];
    assert.deepEqual(r.clusters.map(c => c.name), ['A']);
  });
  test('triage: every open issue is a fix, a recommendation or a decision', () => {
    const issues = [issue(a, 'paused'), issue(a, 'packages'), issue(a, 'behind'), issue(a, 'scan#sec-cluster-admin-x'), issue(a, 'upgrade', 'info')];
    assert.deepEqual(triage(issues, map), { open: 4, fixable: 1, recommended: 2, decision: 1 });
    assert.deepEqual(Array.from(recommendationsByIssue(issues, map).keys()), [`${a.key}#packages`, `${a.key}#behind`]);
  });
});

describe('simulate with recommendations', () => {
  test('the score counts recommended checks, but not an upgrade', () => {
    const cards = [card(a, [check('version', 'fail', 2), check('packages-ok', 'fail', 2), check('cp-ha', 'fail', 2), check('limits', 'pass', 2)])];
    const recs = recommendations({ issues: [issue(a, 'packages'), issue(a, 'behind')], clusters: map, cards });
    const also = recommendedChecks(recs);
    assert.deepEqual(Array.from(also), ['packages-ok']);
    assert.deepEqual([fleetScore(cards), fleetScore(cards, true), fleetScore(cards, true, also)], [25, 50, 75]);
  });
  test('the wall: a tile names the recommended step, and clears it in the third view', () => {
    const issues = [issue(a, 'packages', 'critical'), issue(b, 'behind')];
    const recs = recommendationsByIssue(issues, map);
    const label = (i: any) => recs.get(i.id)?.label;
    const cleared = (i: any) => recs.get(i.id)?.simulated === true;
    const now = wallTiles([a, b], issues, false, n => n, undefined, label);
    assert.deepEqual(now.map(t => [t.state, t.line2]), [['critical', 'Recommended: Re-reconcile'], ['advisory', 'Recommended: Plan the upgrade']]);
    // With fixes only, nothing here changes: neither has a guaranteed fix.
    assert.deepEqual(wallTiles([a, b], issues, true, n => n, undefined, label).map(t => t.state), ['critical', 'advisory']);
    // With recommendations: the package issue is cleared; the upgrade is a project and stays.
    const after = wallTiles([a, b], issues, true, n => n, cleared, label);
    assert.deepEqual(after.map(t => [t.state, t.line1, t.line2]), [['fixed', 'Fixed in simulation', '1 issue cleared'], ['advisory', 'behind', 'Recommended: Plan the upgrade']]);
  });
});
