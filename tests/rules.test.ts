/** Focused tests for the rules where a regression would mislead someone. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { cidrContains, cidrOverlap } from '../src/ip';
import { parseQuantity } from '../src/quantity';
import { componentFlags, evaluateCompliance, parseFlags, scoreResults } from '../src/compliance';
import { complianceOscal, complianceDrift, snapshot } from '../src/complianceReport';
import { levelFromError, probeNamespace, probePsaDefault } from '../src/psaProbe';
import { isForeignBenchmark, jobManifest, mergeNodeScan, parseKubeBench } from '../src/nodeScan';
import { runNodeScan } from '../src/nodeScanRunner';
import { imageOwner, vksSource } from '../src/scanners';
import { stuckNodes } from '../src/clusterScan';
import { isolationReport } from '../src/isolation';
import { newSilence, activeSilences } from '../src/silences';
import { complianceIssueId } from '../src/compliance';

describe('units and addresses', () => {
  test('quantities', () => {
    assert.equal(parseQuantity('1Gi'), 2 ** 30);
    assert.equal(parseQuantity('500m'), 0.5);
    assert.equal(parseQuantity('20000Mi'), 20000 * 2 ** 20);
  });
  test('CIDRs', () => {
    assert.equal(cidrContains('172.30.0.64/27', '172.30.0.66'), true);
    assert.equal(cidrContains('172.30.0.64/27', '172.30.0.96'), false);
    assert.equal(cidrOverlap('172.30.0.0/27', '172.30.0.16/28'), true);
    assert.equal(cidrOverlap('172.30.0.0/27', '172.30.0.32/27'), false);
  });
});

describe('compliance', () => {
  const empty = { kubelets: [], pods: [], namespaces: [], networkPolicies: [], clusterRoles: [], clusterRoleBindings: [], serviceAccounts: [] };
  test('flags from static pods', () => {
    assert.deepEqual(Object.fromEntries(parseFlags(['--a=1', '--b', 'x'])), { a: '1', b: 'true' });
    const pods = [{ metadata: { namespace: 'kube-system', name: 'kube-apiserver-cp', labels: { component: 'kube-apiserver' } }, spec: { containers: [{ name: 'kube-apiserver', command: ['kube-apiserver', '--profiling=false'] }] } }];
    assert.equal(componentFlags(pods, 'kube-apiserver')?.get('profiling'), 'false');
  });
  test('unreadable data is never a pass (regression: once scored 100%)', () => {
    const r = evaluateCompliance({ ...empty, unreadable: ['pods', 'namespaces', 'networkPolicies', 'clusterRoles', 'clusterRoleBindings', 'serviceAccounts'] } as any);
    const sc = scoreResults(r);
    assert.equal(sc.pass, 0);
    assert.equal(sc.scored, 0);
  });
  test('Pod Security: unlabelled namespaces count as the cluster default (regression: false "not set")', () => {
    const nss = [{ metadata: { name: 'shop', labels: {} } }, { metadata: { name: 'secure', labels: { 'pod-security.kubernetes.io/enforce': 'baseline' } } }];
    const withDefault = evaluateCompliance({ ...empty, namespaces: nss, psaDefault: 'restricted' } as any).find(x => x.id === 'PSS-ADMISSION')!;
    assert.equal(withDefault.status, 'pass');
    assert.match(withDefault.evidence, /1 by the cluster default \(restricted\)/);
    const unknownDefault = evaluateCompliance({ ...empty, namespaces: nss } as any).find(x => x.id === 'PSS-ADMISSION')!;
    assert.equal(unknownDefault.status, 'review');
  });
  test('NSA/CISA-only controls stay out of the CIS view', () => {
    const r = evaluateCompliance({ ...empty, resourceQuotas: [], limitRanges: [] } as any);
    assert.deepEqual(r.find(x => x.id === 'GEN-QUOTAS')!.frameworks, ['nsa']);
    assert.ok(r.filter(x => x.frameworks.includes('cis')).length > 50);
  });
  test('drift and OSCAL', () => {
    const r = evaluateCompliance({ ...empty, pods: [{ metadata: { namespace: 'a', name: 'p' }, spec: { containers: [{ securityContext: { privileged: true } }] }, status: { phase: 'Running' } }] } as any);
    const base = snapshot(r.map(x => (x.id === 'PSS-PRIV' ? { ...x, status: 'pass' as const } : x)));
    assert.deepEqual(complianceDrift(base, r).filter(d => d.worse).map(d => d.id), ['PSS-PRIV']);
    const sil = activeSilences([newSilence({ issueId: complianceIssueId('k', 'PSS-PRIV') }, 'x', 'accepted for the demo', 24)]);
    const oscal = JSON.parse(complianceOscal([{ clusterKey: 'k', clusterName: 'c', contextName: 'c', compliance: r, at: '2026-09-27T00:00:00Z' } as any], sil, 'cis'));
    const res = oscal['assessment-results'].results[0];
    assert.equal(oscal['assessment-results'].metadata['oscal-version'], '1.1.2');
    assert.ok(res.findings.some((f: any) => f.target.status.state === 'not-satisfied' && f['related-risks']));
    assert.equal(res.risks[0].status, 'deviation-approved');
  });
});

describe('Pod Security cluster default probe', () => {
  // The exact refusal a VKS cluster returned.
  const real = 'pods "pulltest" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false';
  const writer = (plain: string | null, priv: string | null): any => ({
    async send(req: any, dry: boolean) {
      assert.equal(dry, true, 'the probe must only ever dry-run');
      const err = req.body.spec.containers[0].securityContext?.privileged ? priv : plain;
      if (err) throw new Error(err);
      return {};
    },
  });
  test('reads the level from the refusal', () => {
    assert.equal(levelFromError(real), 'restricted');
    assert.equal(levelFromError('forbidden: cannot create pods'), undefined);
    assert.equal(probeNamespace([{ metadata: { name: 'default', labels: {} } }]), 'default');
  });
  test('restricted, baseline, none, and no permission', async () => {
    assert.equal(await probePsaDefault(writer(real, real), 'default'), 'restricted');
    assert.equal(await probePsaDefault(writer(null, 'violates PodSecurity "baseline:latest"'), 'default'), 'baseline');
    assert.equal(await probePsaDefault(writer(null, null), 'default'), 'privileged');
    assert.equal(await probePsaDefault(writer('pods is forbidden: User cannot create', null), 'default'), undefined);
  });
});

describe('node scan (kube-bench)', () => {
  const bench = { Controls: [{ version: 'cis-1.10', tests: [{ results: [{ test_number: '1.1.1', test_desc: 'x (Automated)', status: 'PASS' }, { test_number: '1.1.12', test_desc: 'y', status: 'FAIL', remediation: 'chown' }] }] }] };
  test('names the benchmark explicitly (regression: VKS detected as TKGI)', () => {
    const cmd = jobManifest('worker', 'kb').spec.template.spec.containers[0].command;
    assert.deepEqual(cmd.slice(cmd.indexOf('--benchmark'), cmd.indexOf('--benchmark') + 2), ['--benchmark', 'cis-1.10']);
    assert.equal(isForeignBenchmark('tkgi-1.2.53'), true);
    assert.equal(isForeignBenchmark('cis-1.10'), false);
    const merged = mergeNodeScan([{ id: 'CP-FILES', status: 'node-scan', evidence: '' } as any], [{ at: '2026-09-27T00:00:00Z', target: 'control-plane', benchmark: 'tkgi-1.2.53', tests: [{ id: '1.1.1', desc: 'x', status: 'FAIL' }] }]);
    assert.equal(merged[0].status, 'node-scan', 'results from a foreign benchmark are not counted');
  });
  test('parses results, including a log with a warning line first', () => {
    assert.equal(parseKubeBench(bench).tests.length, 2);
    assert.equal(parseKubeBench('W0927 warning\n' + JSON.stringify(bench)).tests.length, 2);
    assert.equal(parseKubeBench(bench).tests[0].desc, 'x');
  });
  test('a stuck scan reports the last event instead of crashing (regression)', async () => {
    let t = 0;
    const client: any = {
      async get(p: string) {
        if (p === '/api/v1/namespaces/vks-fleet-scan') return {};
        if (p.includes('/jobs/')) return { status: {} };
        if (p.includes('/pods?labelSelector')) return { items: [{ metadata: { name: 'kb' }, spec: {}, status: { containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } }] };
        if (p.includes('/events?')) return { items: [{ reason: 'FailedCreatePodSandBox', message: 'multus: error getting pod', lastTimestamp: '2026-09-27T00:01:00Z' }] };
        throw Object.assign(new Error('nf'), { status: 404 });
      },
    };
    let last: any[] = [];
    const res = await runNodeScan(client, { async send() { return {}; } } as any, { image: 'kb', targets: ['worker'], sleep: async () => { t += 30000; }, now: () => new Date(1790400000000 + t), timeoutMs: 120000, pollMs: 1 }, s => (last = s));
    assert.equal(res.ok, false);
    assert.match(last.find(s => s.state === 'failed')!.text, /timed out \(last event: FailedCreatePodSandBox/);
  });
});

describe('scanner reports', () => {
  test('owner tagging with real VKS image paths', () => {
    const vks = 'projects.packages.broadcom.com/vsphere/supervisor/vks-standard-packages/3.7.0-20260618/vks-addons';
    assert.equal(imageOwner(vks, 'multus-cni'), 'vks', 'VKS image outside a platform namespace');
    assert.equal(vksSource(vks), 'vks-standard-packages 3.7.0-20260618');
    assert.equal(vksSource('projects.packages.broadcom.com/vsphere/vksm/vksm-extensions/ga/9.0.2-1-25714559/vks-agent/repo'), 'vksm-extensions 9.0.2-1-25714559');
    assert.equal(imageOwner('aquasec/trivy-operator:0.34.0', 'trivy-system'), 'you');
    assert.equal(imageOwner('registry.acme.example/api:1', 'kube-system'), 'vks', 'platform namespace');
  });
});

describe('pods stuck on a node', () => {
  const NOW = new Date('2026-09-27T09:10:00Z');
  const pod = (name: string, node: string, extra: any) => ({ metadata: { namespace: 'x', name, ...extra.metadata }, spec: { nodeName: node }, status: extra.status ?? { phase: 'Running' } });
  test('two or more on one node; one slow pod elsewhere is not flagged', () => {
    const pods = [
      pod('a', 'n1', { metadata: { deletionTimestamp: '2026-09-27T09:00:00Z' } }),
      pod('b', 'n1', { metadata: { creationTimestamp: '2026-09-27T09:00:00Z' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } }),
      pod('c', 'n2', { metadata: { deletionTimestamp: '2026-09-27T09:00:00Z' } }),
      pod('d', 'n1', { metadata: { creationTimestamp: '2026-09-27T09:09:30Z' }, status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] } }),
    ];
    const s = stuckNodes(pods, NOW);
    assert.deepEqual(s.map(n => [n.node, n.terminating.length, n.creating.length]), [['n1', 1, 1]]);
  });
});

describe('tenant isolation', () => {
  test('private ranges may repeat; transit-gateway overlaps are for review; public overlaps fail', () => {
    const results: any[] = [{ supervisor: { id: 's' }, clusters: [], namespaces: [{ name: 'a', tenantId: 'A', tenantName: 'a' }, { name: 'b', tenantId: 'B', tenantName: 'b' }] }];
    const inv: any = {
      vpcs: [{ namespace: 'a', name: 'vpc', snatIP: '1.1.1.1' }, { namespace: 'b', name: 'vpc', snatIP: '2.2.2.2' }],
      subnets: [
        { namespace: 'a', name: 'p', accessMode: 'Private', cidrs: ['172.30.0.0/27'] },
        { namespace: 'b', name: 'p', accessMode: 'Private', cidrs: ['172.30.0.0/27'] },
        { namespace: 'a', name: 't', accessMode: 'PrivateTGW', cidrs: ['10.0.0.0/24'] },
        { namespace: 'b', name: 't', accessMode: 'PrivateTGW', cidrs: ['10.0.0.128/25'] },
      ],
      lbs: [], vms: [], nsx: [],
    };
    const rows = isolationReport(results, new Map([['s', inv]]), new Map());
    const a = rows.find(r => r.org === 'a')!;
    assert.equal(a.checks.find(c => c.id === 'vpc')!.status, 'pass', 'same VPC name, different NAT address: separate VPCs');
    assert.equal(a.checks.find(c => c.id === 'routed-ranges')!.status, 'review');
    inv.subnets.push({ namespace: 'a', name: 'pub', accessMode: 'Public', cidrs: ['40.60.1.0/24'] }, { namespace: 'b', name: 'pub', accessMode: 'Public', cidrs: ['40.60.1.0/25'] });
    assert.equal(isolationReport(results, new Map([['s', inv]]), new Map()).find(r => r.org === 'a')!.checks.find(c => c.id === 'routed-ranges')!.status, 'fail');
  });
});
