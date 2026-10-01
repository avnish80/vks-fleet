/** v1.33.3: the demo stays right at fleet scale and over time; fixes found in its review. */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { demoClient, demoStores } from '../src/demo/index';
import { contextName, DEMO_SUPERVISOR, demoClusterNet, demoClusters, setDemoScale } from '../src/demo/supervisor';
import { buildIncident } from '../src/incident';
import { ownSubnetOf } from '../src/inventory';
import { shortHost } from '../src/names';
import { impact } from '../src/provision';

afterEach(() => setDemoScale(4));

describe('the demo', () => {
  test("leases look renewed whenever they're read, however old the demo data is", async () => {
    const built = new Date('2026-09-30T10:00:00Z');
    demoStores(built);
    const later = new Date(built.getTime() + 9 * 60 * 1000);
    const r: any = await demoClient(DEMO_SUPERVISOR, { now: later, latencyMs: 0, remember: false }).get('/apis/coordination.k8s.io/v1/namespaces/svc-tkg-d7x2k/leases');
    for (const l of r.items) assert.ok(later.getTime() - new Date(l.spec.renewTime).getTime() < 15_000, l.metadata.name);
  });
  test('cloned clusters get valid, distinct addresses and their own network', () => {
    setDemoScale(12);
    const st = demoStores(new Date());
    const vms = st.supervisor.objects.get('vmoperator.vmware.com|virtualmachines') ?? [];
    const ips = vms.filter((v: any) => v.metadata.labels?.['capv.vmware.com/cluster.name']).map((v: any) => v.status.network.primaryIP4);
    assert.ok(ips.every((ip: string) => /^172\.16\.\d+\.\d+$/.test(ip)), 'no negative octets');
    assert.equal(new Set(ips).size, ips.length, 'every node its own address');
    for (const c of demoClusters()) assert.ok(ownSubnetOf(demoClusterNet(c), c.name), c.name);
  });
  test('clones are monitored like the cluster they copy', async () => {
    setDemoScale(12);
    const clone = demoClusters().find(c => c.name === 'payments-2')!;
    const r: any = await demoClient(contextName(clone.name), { latencyMs: 0, remember: false }).get('/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy/api/v1/query?query=up');
    assert.ok(r, 'answers instead of "not reachable"');
  });
});

describe('fixes from the demo review', () => {
  test("a cluster's own subnet matches exactly: payments-2's network isn't payments'", () => {
    assert.equal(ownSubnetOf('payments-ab12c', 'payments'), true);
    assert.equal(ownSubnetOf('payments-2-ab12c', 'payments'), false);
    assert.equal(ownSubnetOf('kubernetes-cluster-9yfw-bk97w', 'kubernetes-cluster-9yfw'), true);
  });
  test('vCPUs against a GHz limit: not comparable, rather than "fits"', () => {
    const r = impact({ cpus: 6, memoryBytes: 0 } as any, { vcpu: 122, memoryBytes: 0, reservedBytes: 0 } as any, { cpuLimitMHz: 60000 } as any, []);
    assert.equal(r.rows[0].status, 'na');
    assert.match(r.rows[0].note!, /Not comparable/);
  });
  test('short host names; addresses stay whole', () => {
    assert.equal(shortHost('esx-02.demo.local'), 'esx-02');
    assert.equal(shortHost('10.0.0.5'), '10.0.0.5');
  });
  test('an alert is named once, and the summary still says it was an alert', () => {
    const t = new Date('2026-09-30T14:39:00Z');
    const inc = buildIncident({ cluster: 'checkout', now: new Date(t.getTime() + 3600e3), hours: 24, timeline: [], alerts: [{ name: 'NodeFilesystemAlmostOutOfSpace', summary: 'less than 12% left', severity: 'warning', since: t.toISOString() } as any] });
    assert.equal(inc.events[0].text, 'NodeFilesystemAlmostOutOfSpace: less than 12% left');
    assert.match(inc.summary, /: alert NodeFilesystemAlmostOutOfSpace/);
  });
});
