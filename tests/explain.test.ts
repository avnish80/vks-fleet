/** v1.19: chart maths, the walk-down, host patterns, the incident timeline and post-mortem, host-based vCenter matching. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { niceMax, smoothPath } from '../src/components/TimeSeriesChart';
import { hostPatterns, walkDown } from '../src/explain';
import { buildIncident, postMortemMarkdown } from '../src/incident';
import { matchSupervisor } from '../src/vcenterStatus';

describe('chart maths', () => {
  test('smooth curves never overshoot the data (monotone)', () => {
    const pts: Array<[number, number]> = [[0, 100], [10, 100], [20, 20], [30, 20], [40, 60]];
    const ys = (smoothPath(pts).match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 1);
    assert.ok(Math.max(...ys) <= 100 && Math.min(...ys) >= 20, `control points stay within the data range: ${Math.min(...ys)}..${Math.max(...ys)}`);
    assert.equal(smoothPath([]), '');
    assert.match(smoothPath([[0, 1], [5, 2]]), /^M0\.0,1\.0L5\.0,2\.0$/);
  });
  test('nice axis maximums', () => {
    assert.deepEqual([0.42, 0.9, 7, 13, 180, 2600].map(niceMax), [0.5, 1, 10, 20, 200, 5000]);
  });
});

const machine = (name: string, o: any = {}) => ({ name, nodeName: name, role: 'worker', phase: 'Running', ready: true, ...o });
const cluster: any = { key: 'k', name: 'checkout', namespace: 'ns', supervisorId: 's', machines: [machine('n1'), machine('n2'), machine('n3', { phase: 'Deleting', ready: false, deletingSince: '2026-09-26T08:00:00Z' })] };
const vm = (name: string, host: string, power = 'PoweredOn') => ({ name, namespace: 'ns', host, power, className: 'best-effort-medium', cluster: 'checkout' });

describe('walk-down', () => {
  test('the deepest unhealthy layer is named (a powered-off VM under a failing machine)', () => {
    const inv: any = { vms: [vm('n3', 'esx-02', 'PoweredOff')] };
    const w = walkDown({ cluster, node: 'n3', inventory: inv, hosts: [{ name: 'esx-02', ready: true }] });
    assert.deepEqual(w.layers.map(l => [l.layer, l.state]), [['Node', 'unknown'], ['Machine', 'bad'], ['VM', 'bad'], ['Host', 'ok'], ['Namespace', 'unknown']]);
    assert.equal(w.likely?.layer, 'VM');
  });
  test('a host that is not Ready is the likely layer', () => {
    const inv: any = { vms: [vm('n1', 'esx-06a')] };
    const w = walkDown({ cluster, node: 'n1', inventory: inv, hosts: [{ name: 'esx-06a', ready: false }] });
    assert.equal(w.likely?.layer, 'Host');
    assert.match(w.summary, /host \(esx-06a\)/);
  });
  test('all healthy', () => {
    const w = walkDown({ cluster, node: 'n1', workload: { podIssues: [], sandboxFailures: [] } as any, inventory: { vms: [vm('n1', 'esx-05a')] } as any, hosts: [{ name: 'esx-05a', ready: true }] });
    assert.equal(w.likely, undefined);
    assert.match(w.summary, /looks healthy/);
  });
  test('host patterns: most problem nodes on one host', () => {
    const inv: any = { vms: [vm('n1', 'esx-02'), vm('n2', 'esx-02'), vm('n3', 'esx-03')] };
    const wl: any = { podIssues: [{ namespace: 'a', name: 'p1', reason: 'CrashLoopBackOff', node: 'n1' }, { namespace: 'a', name: 'p2', reason: 'CrashLoopBackOff', node: 'n2' }], sandboxFailures: [] };
    assert.deepEqual(hostPatterns(cluster, wl, inv), [{ host: 'esx-02', problemNodes: ['n1', 'n2'], totalProblemNodes: 3 }]);
    const spread: any = { vms: [vm('n1', 'esx-02'), vm('n2', 'esx-03'), vm('n3', 'esx-04')] };
    assert.deepEqual(hostPatterns(cluster, wl, spread), []);
  });
});

describe('incident timeline', () => {
  const NOW = new Date('2026-09-27T10:00:00Z');
  const at = (h: number) => new Date(NOW.getTime() - h * 3600e3).toISOString();
  const change = (h: number, text: string): any => ({ time: at(h), kind: 'action', text, tone: 'info', clusterKey: 'k', clusterName: 'c' });
  test('a change shortly before the first symptom is suggested as the trigger', () => {
    const inc = buildIncident({ cluster: 'c', now: NOW, hours: 24, timeline: [change(5, 'Scaled np-1 to 1'), change(3, 'Package fluent-bit updated')], alerts: [{ name: 'KubePodCrashLooping', severity: 'warning', since: at(2.5) }] });
    assert.equal(inc.trigger?.text, 'Package fluent-bit updated');
    assert.equal(inc.firstSymptom?.source, 'alert');
    assert.match(inc.summary, /followed a change 30 min earlier: Package fluent-bit updated\. That may be the trigger; check before concluding\./);
  });
  test('no change within two hours: said plainly, no trigger', () => {
    const inc = buildIncident({ cluster: 'c', now: NOW, hours: 24, timeline: [change(8, 'Scaled np-1 to 1')], alerts: [{ name: 'X', severity: 'critical', since: at(2) }] });
    assert.equal(inc.trigger, undefined);
    assert.match(inc.summary, /No change by the fleet preceded it within two hours/);
  });
  test('a quiet window', () => {
    assert.match(buildIncident({ cluster: 'c', now: NOW, hours: 6, timeline: [] }).summary, /Nothing went wrong in c/);
  });
  test('the post-mortem draft: sections, timeline table, follow-ups, review notice', () => {
    const inc = buildIncident({ cluster: 'c', now: NOW, hours: 24, timeline: [change(3, 'Package a|b updated')], alerts: [{ name: 'X', severity: 'warning', since: at(2.5) }], issues: [{ title: 'Node n3 stuck deleting', severity: 'warning' } as any] });
    const md = postMortemMarkdown(inc);
    for (const h of ['## Summary', '## Impact', '## Timeline', '## Likely trigger', '## Actions taken', '## Follow-ups']) assert.ok(md.includes(h), h);
    assert.match(md, /Review everything before sharing/);
    assert.match(md, /Package a\\\|b updated/, 'pipes escaped in the table');
    assert.match(md, /- \[ \] Node n3 stuck deleting/);
  });
});

describe('vCenter matching by hosts', () => {
  test('the lab case: vCenter lists management addresses, not the load-balanced one', () => {
    const st: any = {
      collectedAt: 't',
      errors: [],
      supervisors: [
        { id: 'domain-c9', apiEndpoints: ['10.1.1.165', '172.16.201.2', '10.1.1.166'], hosts: [{ name: 'esx-05a.site-a.vcf.lab' }, { name: 'esx-06a.site-a.vcf.lab' }] },
        { id: 'domain-c20', apiEndpoints: ['10.2.1.165'], hosts: [{ name: 'esx-01b.site-b.vcf.lab' }] },
      ],
    };
    assert.equal(matchSupervisor(st, { id: 'wld', headlampCluster: '10.150.4.2' } as any, 2, ['esx-05a.site-a.vcf.lab', 'esx-07a.site-a.vcf.lab'])?.id, 'domain-c9');
    assert.equal(matchSupervisor(st, { id: 'wld', headlampCluster: '10.150.4.2' } as any, 2), undefined, 'without hosts or an address, two of each: no guess');
  });
});

describe('chart detail statistics', () => {
  test('min, average, p95, max, latest', async () => {
    const { seriesStats } = await import('../src/observability');
    const st = seriesStats(Array.from({ length: 20 }, (_, i) => [i, i + 1] as [number, number]))!;
    assert.deepEqual([st.min, st.max, st.latest, st.avg], [1, 20, 20, 10.5]);
    assert.equal(st.p95, 20);
    assert.equal(seriesStats([]), undefined);
  });
});
