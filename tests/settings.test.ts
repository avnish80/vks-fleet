/** v1.31: the settings page's setup checks. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { adminTwins, changesMode, changesPatch, probeContext, probeSupervisor } from '../src/settingsStatus';

const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const client = (answers: Record<string, unknown>): any => ({
  get: async (path: string) => {
    const a = answers[path];
    if (a instanceof Error) throw a;
    if (a === undefined) throw err(404);
    return a;
  },
});
const ORG = 'vmware-system-vcf/organization-id';

describe('Supervisor checks', () => {
  test('a context Headlamp does not have', async () => {
    const p = await probeSupervisor(client({}), '10.0.0.9', ['10.0.0.2'], ORG);
    assert.equal(p.level, 'error');
    assert.match(p.text, /no cluster named 10\.0\.0\.9/);
  });
  test('working: clusters, namespaces, and the org IDs to name', async () => {
    const ns = (id?: string) => ({ metadata: { labels: id ? { [ORG]: id } : {} } });
    const p = await probeSupervisor(
      client({ '/apis/cluster.x-k8s.io/v1beta1/clusters': { items: [{}, {}] }, '/api/v1/namespaces': { items: [ns('org-b'), ns('org-a'), ns('org-a'), ns()] } }),
      '10.0.0.2',
      ['10.0.0.2'],
      ORG
    );
    assert.deepEqual([p.level, p.text, p.orgIds], ['ok', '2 clusters, 4 namespaces', ['org-a', 'org-b']]);
  });
  test('an expired sign-in (as with the org2 context) says so, with what to do', async () => {
    const p = await probeSupervisor(client({ '/apis/cluster.x-k8s.io/v1beta1/clusters': err(401) }), '10.0.0.2', ['10.0.0.2'], ORG);
    assert.deepEqual([p.level, p.text], ['error', '10.0.0.2: sign-in expired']);
    assert.match(p.fix!, /refresh timer/);
    const c = await probeContext(client({ '/version': err(401) }), 'org2');
    assert.equal(c.text, 'org2: sign-in expired');
  });
  test('signed in without cluster-wide rights points to the namespaces setting', async () => {
    const p = await probeSupervisor(client({ '/apis/cluster.x-k8s.io/v1beta1/clusters': err(403) }), '10.0.0.2', ['10.0.0.2'], ORG);
    assert.equal(p.level, 'warn');
    assert.match(p.fix!, /namespaces/);
  });
});

describe('elevation checks', () => {
  test('which read contexts have their admin twin', () => {
    const t = adminTwins(['10.0.0.2', '10.0.0.2-admin', 'kubernetes-cluster-a1b2', 'kubernetes-cluster-a1b2-admin', 'kubernetes-cluster-c3d4', 'org2', 'team-a-ns1'], '-admin', [{ context: '10.0.0.2' }], ['org2', 'team-a-ns1']);
    assert.deepEqual(t.supervisors, [{ context: '10.0.0.2', admin: '10.0.0.2-admin', found: true }]);
    assert.equal(t.clustersWith, 1);
    assert.deepEqual(t.clustersWithout, ['kubernetes-cluster-c3d4']);
  });
  test('a named change context is checked instead of the suffix', () => {
    const t = adminTwins(['10.0.0.2', 'wld-admin'], '-admin', [{ context: '10.0.0.2', admin: 'wld-admin' }]);
    assert.equal(t.supervisors[0].found, true);
  });
});

describe('changes as one choice', () => {
  test('from and to the stored settings', () => {
    assert.equal(changesMode({}), 'allow');
    assert.equal(changesMode({ elevation: { enabled: true } }), 'elevate');
    assert.equal(changesMode({ readOnly: true, elevation: { enabled: true } }), 'readonly', 'read-only wins');
    assert.deepEqual(changesPatch('elevate', { suffix: '-adm' }), { readOnly: false, elevation: { suffix: '-adm', enabled: true } });
    assert.deepEqual(changesPatch('readonly'), { readOnly: true, elevation: { enabled: false } });
  });
});
