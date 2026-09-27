/**
 * The plugin's real fetchers and rules, end to end, on the demo fleet.
 * Guards both the logic and demo mode itself (what it shows at a talk).
 */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { normalizeConfig } from '../src/config';
import { matchContexts } from '../src/contexts';
import { fetchClusterScan } from '../src/clusterScan';
import { scoreResults } from '../src/compliance';
import { DEMO_SUPERVISOR_RAW, DEMO_WRITE_REFUSED, demoClient, demoStores, demoWriter } from '../src/demo';
import { DEMO_SUPERVISOR, demoContexts } from '../src/demo/supervisor';
import { fetchSupervisor } from '../src/fleet';
import { fetchInventory } from '../src/inventory';
import { buildIssues } from '../src/issues';
import { mergeNodeScan, readRuns } from '../src/nodeScan';
import { fetchClusterPackages } from '../src/packages';
import { detectPersona } from '../src/persona';
import { fetchScannerReports } from '../src/scanners';
import { scannerIssues } from '../src/scannerIssues';
import { orgsOf } from '../src/scope';
import { fetchWorkloadHealth } from '../src/workload';
import { fetchBackups } from '../src/backups';

const NOW = new Date('2026-09-27T10:00:00Z');
const cfg = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any], demo: true } as any);
const sv = cfg.supervisors[0];
const C = (ctx: string) => demoClient(ctx, { now: NOW, latencyMs: 0 });

describe('demo fleet through the real pipeline', () => {
  let r: Awaited<ReturnType<typeof fetchSupervisor>>;
  let ctxs: Map<string, string>;
  before(async () => {
    demoStores(NOW);
    r = await fetchSupervisor(sv, C(DEMO_SUPERVISOR), NOW);
    ctxs = matchContexts(r.clusters, demoContexts());
  });

  test('settings: demo Supervisor with named orgs', () => {
    assert.equal(sv.headlampCluster, DEMO_SUPERVISOR);
    assert.deepEqual(Object.values(sv.tenantNames).sort(), ['acme', 'globex']);
    assert.equal(cfg.demo, true);
  });

  test('fleet: four clusters, checkout degraded, sandbox behind', () => {
    assert.equal(r.error, undefined);
    assert.deepEqual(r.warnings, []);
    const by = new Map(r.clusters.map(c => [c.name, c]));
    assert.deepEqual([...by.keys()].sort(), ['analytics', 'checkout', 'payments', 'sandbox']);
    assert.equal(by.get('checkout')!.health, 'degraded');
    assert.equal(by.get('payments')!.health, 'healthy');
    assert.match(by.get('sandbox')!.kubernetesVersion, /^v1\.35/);
    assert.equal(by.get('analytics')!.nodePools.length, 2);
  });

  test('orgs: acme with two namespaces, globex with one', () => {
    const orgs = orgsOf([r]);
    assert.deepEqual(orgs.map(o => [o.name, o.namespaces.length, o.clusters]), [['acme', 2, 3], ['globex', 1, 1]]);
  });

  test('persona: operator, with the demo user', async () => {
    const p = await detectPersona(sv, demoWriter(DEMO_SUPERVISOR, { now: NOW }), undefined, false);
    assert.equal(p.persona, 'operator');
    assert.equal(p.user, 'demo@vsphere.local');
  });

  test('inventory: VMs, load balancers, VPCs, quotas', async () => {
    const inv = await fetchInventory(C(DEMO_SUPERVISOR), sv, r.namespaces!.map(n => n.name), true, new Map(r.clusters.map(c => [c.namespace, [c.name]])));
    assert.deepEqual(inv.vms.filter(v => !v.cluster).map(v => v.name).sort(), ['jupyter-gpu', 'reporting-db']);
    assert.equal(inv.vpcs.length, 3);
    assert.equal(inv.quotas.length, 3);
    assert.ok(inv.lbs.length >= 4);
  });

  test('every cluster matches its demo context', () => {
    assert.equal(ctxs.size, 4);
  });

  test('inside clusters: Pod Security default, compliance, storage classes, kube-bench', async () => {
    const byName: Record<string, any> = {};
    for (const c of r.clusters) {
      const ctx = ctxs.get(c.key)!;
      const s = await fetchClusterScan(C(ctx), c.key, c.name, ctx, [], NOW, demoWriter(ctx, { now: NOW }));
      assert.equal(s.psaDefault, 'restricted', `${c.name}: VKS enforces restricted by default`);
      assert.deepEqual(s.errors, [], `${c.name}: no read errors`);
      byName[c.name] = s;
    }
    assert.ok(scoreResults(byName.payments.compliance).pct > scoreResults(byName.checkout.compliance).pct, 'payments is better hardened than checkout');
    assert.deepEqual(byName.sandbox.storageClasses.defaults, []);
    const runs = readRuns(await C(ctxs.get(r.clusters.find(c => c.name === 'payments')!.key)!).get('/api/v1/namespaces/vks-fleet-scan/configmaps/kube-bench-results'));
    assert.equal(mergeNodeScan(byName.payments.compliance, runs).find(x => x.id === 'NODE-FILES')!.status, 'fail');
  });

  test('issues: the problems the demo is meant to show', async () => {
    const wl = new Map<string, any>();
    const pk = new Map<string, any>();
    const bk = new Map<string, any>();
    const scans = [];
    const reps = [];
    for (const c of r.clusters) {
      const ctx = ctxs.get(c.key)!;
      wl.set(c.key, { ...(await fetchWorkloadHealth(C(ctx), ctx, NOW)), contextName: ctx });
      pk.set(c.key, await fetchClusterPackages(C(ctx), c.key, ctx));
      bk.set(c.key, await fetchBackups(C(ctx), c.key, ctx));
      scans.push(await fetchClusterScan(C(ctx), c.key, c.name, ctx, [], NOW, demoWriter(ctx, { now: NOW })));
      reps.push(await fetchScannerReports(C(ctx), c.key, c.name, ctx));
    }
    const issues = buildIssues([r], wl, NOW, pk, bk, 26, undefined, scans, scannerIssues(reps, r.clusters, NOW));
    const titles = issues.map(i => i.title).join('\n');
    for (const expected of [
      /certificates expire in 18 days/,
      /stuck deleting for 26h/,
      /No default StorageClass in sandbox/,
      /cluster-admin granted to people or apps in checkout/,
      /failing to reconcile in checkout: fluent-bit/,
      /images with critical vulnerabilities in checkout/,
      /policy results failing in analytics/,
      /Upgrade available/,
    ]) {
      assert.match(titles, expected);
    }
    assert.equal(new Set(issues.map(i => i.id)).size, issues.length, 'issue ids are unique');
  });

  test('demo writer: dry runs work, real changes are refused', async () => {
    const w = demoWriter(DEMO_SUPERVISOR, { now: NOW });
    const req = { method: 'PATCH' as const, path: '/apis/cluster.x-k8s.io/v1beta1/namespaces/acme-prod-7kq2p/machines/x', contentType: 'application/merge-patch+json', body: { a: 1 } };
    assert.deepEqual(await w.send(req, true), { a: 1 });
    await assert.rejects(w.send(req, false), (e: Error) => e.message === DEMO_WRITE_REFUSED);
  });
});
