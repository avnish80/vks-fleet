/** Supervisor health: leases, service pods and ProviderFailed leftovers, placement, nodes, score, issues, clean-up. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blocked } from '../src/actions';
import { normalizeConfig } from '../src/config';
import { DEMO_SUPERVISOR_RAW, demoClient, demoStores } from '../src/demo';
import { DEMO_SUPERVISOR } from '../src/demo/supervisor';
import { fetchSupervisor } from '../src/fleet';
import { fetchInventory } from '../src/inventory';
import { servicePodHealth } from '../src/supervisor';
import { analyseService, fetchSupervisorHealth, healthScore, leftoverCleanupPlan, parseLeases, parseNodes, placement, supervisorHealthIssues } from '../src/supervisorHealth';

const NOW = new Date('2026-09-27T10:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const pod = (name: string, host: string, rs: string, st: any, days = 14) => ({
  metadata: { name, creationTimestamp: ago(days * 86400), ownerReferences: [{ kind: 'ReplicaSet', name: rs, uid: rs, controller: true }] },
  spec: { nodeName: host },
  status: st,
});
const running = { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0 }] };
const providerFailed = { phase: 'Failed', reason: 'ProviderFailed' };

describe('controller leases', () => {
  test('renewing, stale and leaderless', () => {
    const l = parseLeases(
      [
        { metadata: { namespace: 'svc-tkg-x', name: 'controller-leader-election-capi' }, spec: { holderIdentity: 'cpvm_1', leaseDurationSeconds: 15, renewTime: ago(5) } },
        { metadata: { namespace: 'svc-tkg-x', name: 'capv-controller-manager-runtime' }, spec: { holderIdentity: 'cpvm_2', leaseDurationSeconds: 15, renewTime: ago(600) } },
        { metadata: { namespace: 'svc-tkg-x', name: 'svc-tkg-x-tkg-controller-runtime' }, spec: { leaseDurationSeconds: 15 } },
      ],
      NOW
    );
    assert.deepEqual(l.map(x => [x.controller, x.state, x.holderNode]), [
      ['Cluster API', 'ok', 'cpvm'],
      ['Cluster API provider for vSphere', 'stale', 'cpvm'],
      ['VKS controller', 'no-holder', undefined],
    ]);
  });
});

describe('service pods', () => {
  test('a ProviderFailed pod next to a running replacement is a leftover (as in the lab)', () => {
    const s = analyseService('svc-auto-attach-idzyz', [pod('auto-attach-57bc947bd7-4dlbr', 'esx-05a', 'rs1', running), pod('auto-attach-57bc947bd7-pzwjb', 'esx-06a', 'rs1', providerFailed, 19)], NOW);
    assert.equal(s.state, 'ok');
    assert.deepEqual(s.leftovers.map(p => [p.name, p.reason, p.host]), [['auto-attach-57bc947bd7-pzwjb', 'ProviderFailed', 'esx-06a']]);
  });
  test('ProviderFailed with no replacement: the service is down', () => {
    const s = analyseService('svc-x', [pod('a-1', 'esx-06a', 'rs1', providerFailed)], NOW);
    assert.equal(s.state, 'down');
    assert.equal(s.failing.length, 1);
  });
  test('the existing leftover count recognises ProviderFailed too (regression)', () => {
    const r = servicePodHealth([pod('a-1', 'h1', 'rs1', running), pod('a-2', 'h2', 'rs1', { phase: 'Pending', reason: 'ProviderFailed' })], NOW);
    assert.equal(r.leftovers, 1);
  });
});

describe('hosts and placement', () => {
  const nodes = parseNodes([
    { metadata: { name: '422fb113dee6', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
    ...['05a', '06a', '07a', '08a'].map(h => ({ metadata: { name: `esx-${h}`, labels: {} }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.34.5-sph-c8d5566' } } })),
  ]);
  test('control-plane VMs and ESXi hosts (spherelet)', () => {
    assert.deepEqual(nodes.map(n => n.role), ['control-plane', 'host', 'host', 'host', 'host']);
  });
  test('every service on one host while others are Ready (the lab after esx-06a recovered)', () => {
    const services = ['a', 'b', 'c', 'd'].map(n => analyseService(`svc-${n}`, [pod(`${n}-1`, 'esx-05a', n, running)], NOW));
    const p = placement(services, nodes);
    assert.equal(p.concentrated, 'esx-05a');
    assert.equal(p.readyHosts, 4);
    const spread = placement([...services.slice(0, 3), analyseService('svc-d', [pod('d-1', 'esx-07a', 'd', running)], NOW)], nodes);
    assert.equal(spread.concentrated, undefined);
  });
  test('score: stale controllers weigh most', () => {
    const base = { nodes, leases: [], services: [], placement: { byHost: [], readyHosts: 4 }, backlog: [] };
    assert.equal(healthScore(base), 100);
    assert.equal(healthScore({ ...base, leases: [{ state: 'stale' } as any] }), 75);
    assert.equal(healthScore({ ...base, placement: { byHost: [], readyHosts: 4, concentrated: 'esx-05a' } }), 90);
  });
});

describe('on the demo Supervisor', () => {
  test('health, issues (no duplicates of existing checks) and the clean-up', async () => {
    demoStores(NOW);
    const sv = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any] } as any).supervisors[0];
    const c = demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 });
    const r = await fetchSupervisor(sv, c, NOW);
    const inv = await fetchInventory(c, sv, r.namespaces!.map(n => n.name), true, new Map());
    const h = await fetchSupervisorHealth(c, r, inv, NOW);
    assert.equal(h.leases.length, 6);
    assert.ok(h.leases.every(l => l.state === 'ok'));
    assert.equal(h.placement.concentrated, 'esx-01.demo.local');
    assert.ok(h.backlog.some(b => b.kind === 'Machines' && b.oldest && Math.round(b.oldest.hours) === 26));
    const titles = supervisorHealthIssues(h, 'ctx', NOW).map(i => `${i.severity}: ${i.title}`);
    assert.deepEqual(titles, ['info: 1 failed Supervisor service pod left behind on Demo Supervisor', 'warning: Every Supervisor service pod on Demo Supervisor runs on esx-01.demo.local']);
    const plan = leftoverCleanupPlan(h);
    assert.equal(blocked(plan), false);
    assert.deepEqual(plan.requests('').map(q => `${q.method} ${q.path}`), ['DELETE /api/v1/namespaces/svc-auto-attach-k2m7q/pods/auto-attach-57bc947bd7-pzwjb']);
    assert.equal(blocked(leftoverCleanupPlan({ ...h, services: h.services.map(s => ({ ...s, leftovers: [] })) })), true);
  });
});
