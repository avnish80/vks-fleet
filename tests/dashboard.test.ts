/** v1.36: the fleet dashboard's blocks, its tabs, and the score history kept in the browser. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blockNumbers, BlocksInput, compactNow, dashboardBlocks, fleetTabPath, headline, scoreLine, tabFromLocation } from '../src/dashboard';
import { daysBetween, dayOf, demoHistory, MAX_SCOPES, recordPoint, sinceLast, sinceLastText, sparkline, trendPoints } from '../src/scoreHistory';

const NOW = Date.UTC(2026, 9, 9);
const tile = (state: string, o: any = {}): any => ({ key: state + Math.random(), name: 'c', fullName: 'c', tenantId: 't', tenantName: 'org1', state, icon: 'ok', line1: '', line2: '', more: 0, path: '/x', ...o });
const issue = (id: string, severity = 'warning'): any => ({ id, severity, title: id, supervisorId: 's', affected: { clusters: [], nodes: [], pods: [], tenants: [] } });
const input = (o: Partial<BlocksInput> = {}): BlocksInput => ({
  tiles: [tile('critical'), tile('advisory')],
  supervisor: { visible: true, score: 70, staleControllers: 0 },
  capacity: { cpus: 26, memoryText: '104 GiB' },
  horizon: [],
  now: NOW,
  lifecycle: { failing: 1, drift: 0, upgrading: 0, upgradable: 1 },
  issues: [issue('k#scan#sec-psa'), issue('k#scan#sec-privileged'), issue('k#packages', 'critical'), issue('k#scan#sec-admin', 'info')],
  governance: { backupsKnown: 2, backedUp: 0 },
  subnet: { name: 'org1-ns1', pct: 38 },
  ...o,
});
const by = (blocks: ReturnType<typeof dashboardBlocks>) => Object.fromEntries(blocks.map(b => [b.id, b]));

describe('dashboard blocks', () => {
  test('eight blocks in a fixed order, each with a page to open', () => {
    const blocks = dashboardBlocks(input());
    assert.deepEqual(blocks.map(b => b.id), ['clusters', 'supervisor', 'capacity', 'next30', 'lifecycle', 'security', 'governance', 'network']);
    for (const b of blocks) assert.match(b.path, /^\/vks-fleet/);
    assert.equal(by(blocks).clusters.path, '/vks-fleet?tab=clusters');
    assert.equal(by(blocks).next30.path, '/vks-fleet?tab=issues#next-30-days');
  });
  test('a small lab: one critical cluster, a failing package, no backups', () => {
    const b = by(dashboardBlocks(input()));
    assert.deepEqual([b.clusters.value, b.clusters.unit, b.clusters.tone, b.clusters.reason], ['1', 'of 2', 'bad', 'needs attention, 1 critical']);
    assert.deepEqual([b.supervisor.value, b.supervisor.tone, b.supervisor.reason], ['70', 'warn', 'Controllers renewing']);
    assert.deepEqual([b.capacity.value, b.capacity.unit, b.capacity.tone], ['26', 'vCPU', 'none']);
    assert.deepEqual([b.next30.value, b.next30.tone, b.next30.reason], ['0', 'ok', 'Nothing expires or runs out']);
    assert.deepEqual([b.lifecycle.value, b.lifecycle.tone, b.lifecycle.path], ['1', 'bad', '/vks-fleet/packages']);
    // Information-level findings are not counted, and a failing package is not a security finding.
    assert.deepEqual([b.security.value, b.security.tone], ['2', 'warn']);
    assert.deepEqual([b.governance.value, b.governance.unit, b.governance.tone], ['0', 'of 2', 'warn']);
    assert.deepEqual([b.network.value, b.network.tone], ['38%', 'ok']);
  });
  test('the clusters block counts as the wall does: advisory-only clusters do not need attention', () => {
    const b = by(dashboardBlocks(input({ tiles: [tile('advisory'), tile('healthy'), tile('healthy')] })));
    assert.deepEqual([b.clusters.value, b.clusters.tone, b.clusters.reason], ['0', 'ok', 'need attention; 1 advisory only']);
    const w = by(dashboardBlocks(input({ tiles: [tile('warning'), tile('warning'), tile('healthy')] })));
    assert.deepEqual([w.clusters.value, w.clusters.tone, w.clusters.reason], ['2', 'warn', 'need attention']);
  });
  test('a controller that stopped renewing outranks a good Supervisor score', () => {
    const b = by(dashboardBlocks(input({ supervisor: { visible: true, score: 95, staleControllers: 2 } })));
    assert.deepEqual([b.supervisor.tone, b.supervisor.reason], ['bad', '2 controllers not renewing']);
    const hidden = by(dashboardBlocks(input({ supervisor: { visible: false, staleControllers: 0 } })));
    assert.deepEqual([hidden.supervisor.value, hidden.supervisor.tone, hidden.supervisor.n], ['—', 'none', undefined]);
  });
  test('capacity: the busiest node, and a forecast takes the reason and raises the tone', () => {
    const busy = { cluster: 'checkout', node: 'np-1-abc', pct: 62, what: 'memory' as const };
    const calm = by(dashboardBlocks(input({ capacity: { cpus: 26, memoryText: '104 GiB', busiest: busy } })));
    assert.deepEqual([calm.capacity.value, calm.capacity.unit, calm.capacity.tone, calm.capacity.reason], ['62%', 'memory', 'ok', 'Busiest node: checkout np-1-abc']);
    const horizon: any[] = [
      { at: NOW + 5 * 86400e3, kind: 'certificate', tone: 'warning', text: 'a: certificate expires' },
      { at: NOW + 6 * 86400e3, kind: 'capacity', tone: 'warning', text: 'checkout: node disk full on np-1' },
    ];
    const soon = by(dashboardBlocks(input({ capacity: { cpus: 26, memoryText: '104 GiB', busiest: busy }, horizon })));
    // Something running out becomes the figure: how long is left.
    assert.deepEqual([soon.capacity.value, soon.capacity.unit, soon.capacity.tone, soon.capacity.reason, soon.capacity.n], ['6 days', 'until full', 'warn', 'checkout: node disk full on np-1', 6]);
    assert.deepEqual([soon.next30.value, soon.next30.tone, soon.next30.reason], ['2', 'warn', '1 certificate expiring, 1 running out; first in 5 days']);
    const urgent = by(dashboardBlocks(input({ horizon: [{ at: NOW + 38 * 3600e3, kind: 'capacity', tone: 'error', text: 'checkout: node disk full on np-1' }] })));
    assert.deepEqual([urgent.capacity.value, urgent.capacity.tone, urgent.capacity.n], ['2 days', 'bad', 1.6]);
    const hot = by(dashboardBlocks(input({ capacity: { cpus: 26, memoryText: '104 GiB', busiest: { ...busy, pct: 93 } } })));
    assert.equal(hot.capacity.tone, 'bad');
  });
  test('next 30 days: a silence ending is shown but not counted as running out', () => {
    const b = by(dashboardBlocks(input({ horizon: [{ at: NOW + 86400e3, kind: 'silence', tone: 'info', text: 'Silence ends' }] })));
    assert.deepEqual([b.next30.value, b.next30.tone, b.next30.reason], ['0', 'ok', '1 silence ending; first in 1 day']);
    // A certificate that rotation renews first is information too: it doesn't join the count or the kinds.
    const mixed = by(dashboardBlocks(input({ horizon: [{ at: NOW + 2 * 86400e3, kind: 'capacity', tone: 'error', text: 'x' }, { at: NOW + 18 * 86400e3, kind: 'certificate', tone: 'info', text: 'y' }] })));
    assert.deepEqual([mixed.next30.value, mixed.next30.unit, mixed.next30.tone, mixed.next30.reason], ['1', 'item', 'bad', '1 running out; first in 2 days']);
  });
  test('lifecycle: failing packages first, then upgrades, then drift, then all current', () => {
    const l = (x: any) => by(dashboardBlocks(input({ lifecycle: { failing: 0, drift: 0, upgrading: 0, upgradable: 0, ...x } }))).lifecycle;
    assert.deepEqual([l({ upgrading: 1 }).tone, l({ upgrading: 1 }).path], ['warn', '/vks-fleet/upgrades']);
    assert.deepEqual([l({ upgradable: 3 }).value, l({ upgradable: 3 }).tone], ['3', 'none']);
    assert.deepEqual([l({ drift: 2 }).reason, l({ drift: 2 }).tone], ['packages at different versions', 'warn']);
    assert.deepEqual([l({}).value, l({}).tone], ['0', 'ok']);
    assert.deepEqual([l({ failing: undefined }).value, l({ failing: undefined }).tone], ['—', 'none']);
  });
  test('governance: the baseline leads when one is set; missing backups keep it from green', () => {
    const g = (x: any) => by(dashboardBlocks(input({ governance: x }))).governance;
    assert.deepEqual([g({ baselinePct: 96, backupsKnown: 2, backedUp: 2 }).value, g({ baselinePct: 96, backupsKnown: 2, backedUp: 2 }).tone], ['96%', 'ok']);
    assert.deepEqual([g({ baselinePct: 96, backupsKnown: 2, backedUp: 1 }).tone, g({ baselinePct: 96, backupsKnown: 2, backedUp: 1 }).reason], ['warn', '1 cluster without a backup']);
    assert.deepEqual([g({ backupsKnown: 0, backedUp: 0 }).value, g({ backupsKnown: 0, backedUp: 0 }).tone], ['—', 'none']);
  });
  test('the numbers kept for the history leave out blocks without one', () => {
    const n = blockNumbers(dashboardBlocks(input({ supervisor: { visible: false, staleControllers: 0 }, subnet: undefined })));
    assert.deepEqual(n, { clusters: 1, capacity: 26, next30: 0, lifecycle: 1, security: 2, governance: 0 });
  });
  test('the headline and the score line', () => {
    assert.equal(headline([tile('critical'), tile('advisory')]), '1 of 2 clusters needs attention');
    assert.equal(headline([tile('warning'), tile('critical'), tile('healthy')]), '2 of 3 clusters need attention');
    assert.equal(headline([tile('healthy'), tile('advisory')]), 'All 2 clusters are healthy');
    assert.equal(headline([]), 'No clusters yet');
    const drivers: any[] = [{ id: 'cp-ha', title: 'Highly available control plane', points: 13 }];
    assert.equal(scoreLine(71, 'up 3 since your last visit yesterday', drivers), 'Fleet score 71, up 3 since your last visit yesterday. Biggest drag: highly available control plane (−13).');
    assert.equal(scoreLine(100, undefined, []), 'Fleet score 100. Every check that could run is passing.');
    assert.match(scoreLine(undefined, undefined, []), /No score yet/);
  });
});

describe('fleet page tabs', () => {
  test('the tab comes from the address; older links land where their section moved', () => {
    assert.equal(tabFromLocation('', ''), 'dashboard');
    assert.equal(tabFromLocation('?tab=issues', ''), 'issues');
    assert.equal(tabFromLocation('?tab=clusters&attention=1', ''), 'clusters');
    assert.equal(tabFromLocation('?supervisor=sg', ''), 'dashboard');
    assert.equal(tabFromLocation('?health=degraded', '#clusters'), 'clusters');
    assert.equal(tabFromLocation('?upgradable=1', ''), 'clusters');
    assert.equal(tabFromLocation('', '#issues'), 'issues');
    assert.equal(tabFromLocation('', '#scorecard'), 'clusters');
    assert.equal(tabFromLocation('?tab=nonsense', ''), 'dashboard');
    assert.equal(tabFromLocation('?tab=dashboard&attention=1', ''), 'dashboard');
  });
  test('tab links', () => {
    assert.equal(fleetTabPath('dashboard'), '/vks-fleet');
    assert.equal(fleetTabPath('issues'), '/vks-fleet?tab=issues');
    assert.equal(tabFromLocation('?tab=issues', '#next-30-days'), 'issues');
  });
});

describe('score history', () => {
  test('one point per day: a later value the same day replaces the earlier one', () => {
    let h = recordPoint(undefined, 'all', { d: '2026-10-08', s: 68 });
    h = recordPoint(h, 'all', { d: '2026-10-09', s: 70 });
    h = recordPoint(h, 'all', { d: '2026-10-09', s: 71, b: { clusters: 1 } });
    assert.deepEqual(h.all, [{ d: '2026-10-08', s: 68 }, { d: '2026-10-09', s: 71, b: { clusters: 1 } }]);
  });
  test('nothing changed: the same object comes back, so nothing is written', () => {
    const h = recordPoint(undefined, 'all', { d: '2026-10-09', s: 71, b: { clusters: 1 } });
    assert.equal(recordPoint(h, 'all', { d: '2026-10-09', s: 71, b: { clusters: 1 } }), h);
    assert.notEqual(recordPoint(h, 'all', { d: '2026-10-09', s: 72, b: { clusters: 1 } }), h);
  });
  test('scopes are kept apart, old days and the least recent scopes are dropped', () => {
    let h = recordPoint(undefined, 'sg|org1', { d: '2026-06-01', s: 50 });
    h = recordPoint(h, 'sg|org1', { d: '2026-10-09', s: 71 });
    h = recordPoint(h, 'sg|org2', { d: '2026-10-09', s: 90 });
    assert.deepEqual(h['sg|org1'], [{ d: '2026-10-09', s: 71 }]);
    assert.deepEqual(h['sg|org2'], [{ d: '2026-10-09', s: 90 }]);
    for (let k = 0; k < MAX_SCOPES + 5; k += 1) h = recordPoint(h, `scope-${k}`, { d: '2026-10-10', s: 80 });
    assert.equal(Object.keys(h).length, MAX_SCOPES);
    assert.ok(!('sg|org1' in h) && `scope-${MAX_SCOPES + 4}` in h);
  });
  test('a clock set back does not leave points from the future', () => {
    let h = recordPoint(undefined, 'all', { d: '2026-10-12', s: 80 });
    h = recordPoint(h, 'all', { d: '2026-10-09', s: 71 });
    assert.deepEqual(h.all, [{ d: '2026-10-09', s: 71 }]);
  });
  test('since the last visit: against the last earlier day, not today', () => {
    const points = [{ d: '2026-10-05', s: 64 }, { d: '2026-10-07', s: 68 }, { d: '2026-10-09', s: 70 }];
    assert.deepEqual(sinceLast(points, '2026-10-09', 71), { delta: 3, days: 2 });
    assert.equal(sinceLastText(sinceLast(points, '2026-10-09', 71)), 'up 3 since your last visit 2 days ago');
    assert.equal(sinceLastText({ delta: -4, days: 1 }), 'down 4 since your last visit yesterday');
    assert.equal(sinceLastText({ delta: 0, days: 6 }), 'unchanged since your last visit 6 days ago');
    assert.equal(sinceLast([{ d: '2026-10-09', s: 70 }], '2026-10-09', 71), undefined);
    assert.equal(sinceLastText(undefined), undefined);
  });
  test('the trend window and day arithmetic', () => {
    assert.equal(daysBetween('2026-09-30', '2026-10-09'), 9);
    assert.equal(daysBetween('2026-02-27', '2026-03-01'), 2);
    assert.equal(dayOf(new Date(2026, 9, 9, 23, 59)), '2026-10-09');
    const points = [{ d: '2026-08-01', s: 50 }, { d: '2026-09-10', s: 60 }, { d: '2026-10-09', s: 71 }];
    assert.deepEqual(trendPoints(points, '2026-10-09').map(p => p.d), ['2026-09-10', '2026-10-09']);
    assert.deepEqual(trendPoints(undefined, '2026-10-09'), []);
  });
  test('demo: a made-up month that ends at today\'s score; real days replace made-up ones', () => {
    const demo = demoHistory(74, '2026-10-09');
    assert.equal(demo.length, 30);
    assert.deepEqual([demo[0].d, demo[29].d, demo[29].s], ['2026-09-10', '2026-10-09', 74]);
    assert.ok(demo[0].s < 74 && demo.every(p => p.s >= 0 && p.s <= 100));
    assert.deepEqual(demoHistory(74, '2026-10-09'), demo);
    const mixed = demoHistory(74, '2026-10-09', [{ d: '2026-10-08', s: 99 }]);
    assert.equal(mixed[28].s, 99);
    // The demo's last step is up, so the header reads "up 2 since your last visit yesterday".
    assert.deepEqual(sinceLast(demo, '2026-10-09', 74), { delta: 2, days: 1 });
  });
  test('the trend line stays inside its box, newest point at the right', () => {
    const s = sparkline(demoHistory(74, '2026-10-09'), '2026-10-09', 150, 40);
    const xy = s.line.split(' ').map(p => p.split(',').map(Number));
    assert.equal(xy.length, 30);
    assert.ok(xy.every(([x, y]) => x >= 0 && x <= 150 && y >= 0 && y <= 40));
    assert.equal(s.last!.x, 146);
    assert.equal(sparkline([], '2026-10-09', 150, 40).line, '');
    // One point (the first day): a dot at the right edge, mid-height.
    assert.deepEqual(sparkline([{ d: '2026-10-09', s: 71 }], '2026-10-09', 150, 40).last, { x: 146, y: 20 });
  });
});

describe('needs you now, on one line', () => {
  test('an issue leads with the cluster\'s short name and drops the long one', () => {
    const short = (n: string) => n.replace('kubernetes-cluster-', '');
    const items = compactNow(
      [
        { id: 'a', severity: 'critical', title: "Pods can't start on node kubernetes-cluster-mnet-kubernetes-cluster-mnet-np-1-7d8j: pod networking fails", sub: 'kubernetes-cluster-mnet · org1', clusterName: 'kubernetes-cluster-mnet' },
        { id: 'b', severity: 'critical', title: '1 package failing to reconcile in kubernetes-cluster-mnet: pinniped', clusterName: 'kubernetes-cluster-mnet' },
        { id: 'soon|x', severity: 'warning', title: 'checkout: node disk runs out on np-1', sub: 'in 2 days' },
      ] as any[],
      short
    );
    assert.deepEqual(items.map((i: any) => [i.title, i.sub]), [
      ["mnet: pods can't start on node np-1-7d8j: pod networking fails", undefined],
      ['mnet: 1 package failing to reconcile: pinniped', undefined],
      ['checkout: node disk runs out on np-1', 'in 2 days'],
    ]);
  });
});
