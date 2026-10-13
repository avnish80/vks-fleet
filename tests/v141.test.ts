/** v1.41: figures that contradicted each other, and what the demo was missing. */
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { fetchAccess } from '../src/access';
import { scorecard } from '../src/checks';
import { normalizeConfig } from '../src/config';
import { DEMO_SUPERVISOR_RAW, demoClient, demoStores } from '../src/demo';
import { DEMO_SUPERVISOR } from '../src/demo/supervisor';
import { fetchClusterExtras } from '../src/extras';
import { fetchSupervisor } from '../src/fleet';
import { fetchInventory } from '../src/inventory';
import { buildIssues } from '../src/issues';
import { diskTone } from '../src/supervisorHealth';

const NOW = new Date('2026-10-13T04:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();

describe('the backup check and the backup issue agree', () => {
  const cluster: any = { key: 's/ns/c', supervisorId: 's', namespace: 'ns', name: 'c', machines: [], nodePools: [], conditions: [], issues: [] };
  const backups = (h?: number, o: any = {}): any => ({ clusterKey: 's/ns/c', contextName: 'c', schedules: [{ name: 'daily' }], recent: [], lastSuccess: h === undefined ? undefined : { name: 'b', phase: 'Completed', completed: hoursAgo(h) }, ...o });
  const check = (b: any, within?: number) => scorecard(cluster, undefined, 3, NOW, undefined, b, within).checks.find(c => c.id === 'backup')!;
  test('within the expected time passes; stale is a warning; a week without one fails', () => {
    assert.equal(check(backups(6)).status, 'pass');
    // 146 hours used to pass (anything under a week did) beside a "no successful backup for 146 hours" issue.
    const stale = check(backups(146));
    assert.equal(stale.status, 'warn');
    assert.match(stale.detail, /146 hours ago \(expected within 26\)/);
    assert.equal(check(backups(200)).status, 'fail');
    assert.equal(check(backups(undefined)).status, 'fail');
  });
  test('the threshold is the baseline\'s, the one the issue uses', () => {
    assert.equal(check(backups(40), 48).status, 'pass');
    assert.equal(check(backups(40), 26).status, 'warn');
    // "Don't check" in the baseline falls back to a day.
    assert.equal(check(backups(40), 0).status, 'warn');
    for (const [h, within] of [[20, 26], [30, 26], [40, 48], [60, 48]] as const) {
      const issue = buildIssues([{ supervisor: { id: 's' } as any, clusters: [cluster], warnings: [], orgs: [] } as any], new Map(), NOW, undefined, new Map([[cluster.key, backups(h)]]), within).some(i => i.id.endsWith('backup-stale'));
      assert.equal(check(backups(h), within).status !== 'pass', issue, `${h}h against ${within}h`);
    }
  });
});

describe('a disk that fills soon is never shown as fine', () => {
  test('colour follows the time left as well as the space used', () => {
    assert.equal(diskTone(78), 'success');
    assert.equal(diskTone(78, 3 * 86400), 'error');
    assert.equal(diskTone(78, 5 * 86400), 'warning');
    assert.equal(diskTone(78, 30 * 86400), 'success');
    assert.equal(diskTone(85), 'warning');
    assert.equal(diskTone(95, 5 * 86400), 'error');
    assert.equal(diskTone(undefined), '');
  });
});

describe('the demo fills the sections a newcomer opens', () => {
  const cfg = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any], demo: true } as any);
  const client = demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 });
  before(() => { demoStores(NOW); });
  test('access: people and groups per namespace, not an error', async () => {
    for (const ns of ['acme-prod-7kq2p', 'acme-dev-3xm9d', 'globex-ml-9w4tz']) {
      const a = await fetchAccess(client, ns);
      assert.equal(a.error, undefined, ns);
      assert.ok(a.entries.filter(e => !e.system).length >= 3, ns);
      assert.ok(a.entries.some(e => e.system), 'platform accounts are there, marked as such');
    }
  });
  test('a cluster has add-ons and a change audit', async () => {
    const x = await fetchClusterExtras(client, 'acme-prod-7kq2p', 'checkout');
    assert.deepEqual(x.addons.map(a => a.role), ['Networking (CNI)', 'Storage (CSI)', 'Cloud provider (CPI)', 'Package controller', 'Additional']);
    assert.ok(x.changes.length >= 3);
    assert.ok(x.changes.some(c => /Headlamp/.test(c.who)), 'a change made through the plugin');
    assert.deepEqual(x.warnings, []);
  });
  test('volumes and VM disks exist, belong to something, and are not leftovers', async () => {
    const r = await fetchSupervisor(cfg.supervisors[0], client, NOW);
    const inv = await fetchInventory(client, cfg.supervisors[0], r.namespaces!.map(n => n.name), true, new Map(r.clusters.map(c => [c.namespace, [c.name]])));
    assert.ok(inv.volumes.length >= 8);
    assert.ok(inv.volumes.every(v => v.usedBy && (v.size ?? 0) > 0));
    const db = inv.vms.find(v => v.name === 'reporting-db')!;
    assert.deepEqual([db.image, db.volumes], ['acme-hardened-rhel-9.4', ['reporting-db-data']]);
    // A machine stuck deleting reads the same whichever clock reads it.
    const stuck = r.clusters.find(c => c.name === 'checkout')!;
    assert.ok(stuck.issues.some(i => /has been deleting for 26h/.test(i)));
  });
});
