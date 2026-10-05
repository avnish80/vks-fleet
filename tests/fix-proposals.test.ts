/** v1.35: fix proposals, the simulated score and the cluster wall. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fixCounts, fleetScore, iconFor, issueFix, scoreDrivers, simulatedScore, tileTitle, wallTiles } from '../src/fixes';

const cluster = (name: string, o: any = {}): any => ({ key: `s/ns/${name}`, supervisorId: 's', namespace: 'ns', name, tenantId: 't', tenantName: 'acme', health: 'healthy', machines: [{}, {}, {}], kubernetesVersion: 'v1.34.1', ...o });
const issue = (c: any, rule: string, severity = 'warning', title = rule): any => ({ id: `${c.key}#${rule}`, severity, title, clusterKey: c.key, affected: { clusters: [], nodes: [], pods: [], tenants: [] } });
const check = (id: string, status: string, weight = 1): any => ({ id, title: id, status, weight });
const card = (checks: any[]): any => {
  const ev = checks.filter(x => x.status !== 'unknown');
  const all = ev.reduce((n, x) => n + x.weight, 0);
  const got = ev.reduce((n, x) => n + x.weight * (x.status === 'pass' ? 1 : x.status === 'warn' ? 0.5 : 0), 0);
  return { clusterKey: 'k', checks, score: Math.round((got / all) * 100), evaluated: ev.length, total: checks.length };
};

describe('fix proposals', () => {
  const c = cluster('checkout');
  test('only issues with an existing action get a fix', () => {
    assert.match(issueFix(issue(c, 'stuck-np-1-abc'), c)!.path, /\/machines\/np-1-abc$/);
    assert.match(issueFix(issue(c, 'vm-off-np-1-abc'), c)!.label, /Replace/);
    assert.match(issueFix(issue(c, 'paused'), c)!.path, /action=resume/);
    assert.match(issueFix(issue(c, 'timeouts-np-1'), c)!.path, /action=timeouts.*pool=np-1/);
    assert.ok(issueFix(issue(c, 'single-cp'), c));
    assert.ok(issueFix(issue(c, 'scan#sec-psa-Namespaces that allow privileged pods'), c));
    for (const rule of ['behind', 'upgrade', 'packages', 'net-node1', 'pvc', 'dns', 'stuck-node-n1', 'scan#sec-latest-x']) assert.equal(issueFix(issue(c, rule), c), undefined, rule);
  });
  test('certificates: a fix only while rotation is off', () => {
    assert.ok(issueFix(issue(c, 'certs'), c));
    assert.equal(issueFix(issue(c, 'certs'), cluster('checkout', { certificateRotation: { enabled: true } })), undefined);
  });
  test('an issue without its cluster has no fix', () => {
    assert.equal(issueFix(issue(c, 'paused'), undefined), undefined);
  });
});

describe('simulated score', () => {
  const a = card([check('cp-ha', 'fail', 3), check('version', 'fail', 2), check('certs', 'warn', 1), check('limits', 'pass', 2), check('pdb', 'unknown', 5)]);
  test('fixable checks pass, the rest stay as they are, unknown stays out', () => {
    assert.equal(a.score, 31); // (0 + 0 + 0.5 + 2) / 8
    assert.equal(simulatedScore(a), 75); // (3 + 0 + 1 + 2) / 8
  });
  test('the fleet score averages the clusters, simulated or not', () => {
    const b = card([check('cp-ha', 'pass', 3), check('version', 'pass', 2)]);
    assert.equal(fleetScore([a, b]), 66);
    assert.equal(fleetScore([a, b], true), 88);
    assert.equal(fleetScore([]), undefined);
  });
  test('drivers: largest first, add up to the points lost, and name the fix', () => {
    const b = card([check('cp-ha', 'pass', 3), check('version', 'pass', 2)]);
    const d = scoreDrivers([a, b]);
    assert.deepEqual(d.map(x => x.id), ['cp-ha', 'version', 'certs']);
    assert.ok(Math.abs(d.reduce((n, x) => n + x.points, 0) - (100 - (31.25 + 100) / 2)) < 0.2);
    assert.equal(d[0].fix, 'Scale the control plane to 3');
    assert.equal(d[1].fix, undefined);
    assert.equal(d[0].clusters, 1);
  });
});

describe('cluster wall', () => {
  const a = cluster('kubernetes-cluster-a1');
  const b = cluster('kubernetes-cluster-b2');
  const h = cluster('kubernetes-cluster-c3', { machines: [{}] });
  const issues = [
    issue(a, 'paused', 'warning', 'Paused'),
    issue(a, 'net-n1', 'critical', `Pods can't start on node ${a.name}-${a.name}-np-1-x: pod networking fails`),
    issue(b, 'single-cp', 'warning', 'Single control-plane node'),
    issue(h, 'idle', 'info', 'Idle'),
  ];
  test('each tile names the worst issue and whether a fix is ready', () => {
    const [ta, tb, th] = wallTiles([a, b, h], issues, false, n => n.replace('kubernetes-cluster-', ''));
    assert.deepEqual([ta.name, ta.state, ta.icon, ta.more], ['a1', 'critical', 'network', 1]);
    assert.equal(ta.line1, "Pods can't start on node np-1-x: pod networking fails");
    assert.equal(ta.line2, 'Needs a decision');
    assert.deepEqual([tb.state, tb.line2], ['warning', 'Fix ready: Scale the control plane to 3']);
    assert.deepEqual([th.state, th.line1, th.line2], ['healthy', 'Healthy', 'v1.34.1 · 1 node']);
  });
  test('simulated: fixable issues go, what is left stays', () => {
    const [ta, tb, th] = wallTiles([a, b, h], issues, true);
    assert.deepEqual([ta.state, ta.more], ['critical', 0]);
    assert.deepEqual([tb.state, tb.line1, tb.line2], ['fixed', 'Fixed in simulation', '1 fix applied']);
    assert.equal(th.state, 'healthy');
  });
  test('counts, titles and icons', () => {
    assert.deepEqual(fixCounts(issues, new Map([a, b, h].map(c => [c.key, c]))), { open: 3, fixable: 2 });
    assert.equal(tileTitle('Privileged pods in web', 'web'), 'Privileged pods');
    assert.equal(iconFor(issue(a, 'certs')), 'certificate');
    assert.equal(iconFor(issue(a, 'hot-n1')), 'memory');
    assert.equal(iconFor(issue(a, 'something-new')), 'alert');
  });
});
