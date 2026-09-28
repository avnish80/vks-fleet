/** Installing and removing packages: the values form, the plans, and a demo install end to end. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { demoClient, demoStores, demoWriter, DEMO_WRITE_REFUSED } from '../src/demo';
import { contextName } from '../src/demo/supervisor';
import { installNames, installPlan, uninstallPlan } from '../src/packageInstall';
import { fetchClusterPackages } from '../src/packages';
import { blocked } from '../src/actions';
import { buildValues, schemaFields, valuesText } from '../src/valuesSchema';

const schema = {
  type: 'object',
  properties: {
    namespace: { type: 'string', default: 'tanzu-system-ingress' },
    contour: { type: 'object', properties: { replicas: { type: 'integer', default: 2 } } },
    envoy: { type: 'object', properties: { service: { type: 'object', properties: { type: { type: 'string', enum: ['LoadBalancer', 'NodePort'], default: 'LoadBalancer' } } } } },
    certificates: { type: 'object', properties: { useCertManager: { type: 'boolean', default: true } } },
    extraArgs: { type: 'array', items: { type: 'string' } },
  },
};

describe('values form from a package schema', () => {
  test('fields: nested objects flattened, enums, lists as JSON', () => {
    const f = schemaFields(schema);
    assert.deepEqual(f.map(x => `${x.key}:${x.type}`), ['namespace:string', 'contour.replicas:integer', 'envoy.service.type:enum', 'certificates.useCertManager:boolean', 'extraArgs:json']);
  });
  test('only values that differ from the defaults are sent', () => {
    const f = schemaFields(schema);
    const { values, errors } = buildValues(f, { 'contour.replicas': '3', 'envoy.service.type': 'LoadBalancer', 'certificates.useCertManager': false, namespace: '', extraArgs: '["--x"]' });
    assert.deepEqual(errors, []);
    assert.deepEqual(values, { contour: { replicas: 3 }, certificates: { useCertManager: false }, extraArgs: ['--x'] });
    assert.equal(valuesText({}), '', 'no changes: the package defaults');
  });
  test('bad input is reported, not sent', () => {
    const { values, errors } = buildValues(schemaFields(schema), { 'contour.replicas': '2.5', extraArgs: '[oops' });
    assert.equal(errors.length, 2);
    assert.deepEqual(values, {});
  });
});

describe('install and remove plans', () => {
  const def = { refName: 'contour.tanzu.vmware.com', version: '1.31.0+vmware.1-tkg.1', namespace: 'tkg-system' };
  const base = { cluster: 'sandbox', def, namespace: 'tkg-system', name: 'contour', installed: [], versionsHere: [def.version] };
  test('creates what the VCF CLI creates, in order', () => {
    const p = installPlan({ ...base, values: '{"contour":{"replicas":3}}\n' });
    const req = p.requests('ingress for the team');
    assert.deepEqual(req.map(r => r.path.split('/').slice(-1)[0]), ['serviceaccounts', 'clusterroles', 'clusterrolebindings', 'secrets', 'packageinstalls']);
    const pkgi: any = req[4].body;
    assert.equal(pkgi.spec.serviceAccountName, installNames('contour', 'tkg-system').sa);
    assert.equal(pkgi.spec.packageRef.versionSelection.constraints, def.version);
    assert.equal(pkgi.spec.values[0].secretRef.name, 'contour-tkg-system-values');
    assert.equal(pkgi.metadata.annotations['vks-fleet/reason'], 'ingress for the team');
    assert.equal(installPlan(base).requests('').length, 4, 'no values: no Secret');
  });
  test('checks: already installed, missing version, dependency hint, other namespace', () => {
    const installed: any[] = [{ refName: 'contour.tanzu.vmware.com', namespace: 'tkg-system', name: 'contour', version: '1.30.1', state: 'ok' }];
    assert.equal(blocked(installPlan({ ...base, installed })), true);
    assert.equal(blocked(installPlan({ ...base, versionsHere: [] })), true);
    const noCertManager = installPlan(base);
    assert.equal(blocked(noCertManager), false);
    assert.ok(noCertManager.checks.some(c => c.level === 'warn' && /cert-manager/.test(c.text)));
    assert.ok(installPlan({ ...base, namespace: 'apps' }).checks.some(c => c.level === 'warn' && /global/.test(c.text)));
  });
  test('removing: VKS-managed packages are protected; confirmation required', () => {
    assert.equal(blocked(uninstallPlan('c', { refName: 'antrea.tanzu.vmware.com', namespace: 'vmware-system-tkg', name: 'c-antrea', state: 'ok', managedByVks: true } as any)), true);
    const p = uninstallPlan('c', { refName: 'contour.tanzu.vmware.com', namespace: 'tkg-system', name: 'contour', state: 'ok' } as any);
    assert.equal(blocked(p), false);
    assert.equal(p.confirmText, 'contour');
    assert.deepEqual(p.requests('').map(r => r.method), ['DELETE']);
  });
});

describe('install on a demo cluster', () => {
  test('catalog with schemas; dry run passes; applying is refused in demo mode', async () => {
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const ctx = contextName('sandbox');
    const cp = await fetchClusterPackages(demoClient(ctx, { now: NOW, latencyMs: 0 }), 'k', ctx);
    const prom = cp.definitions!.find(d => d.refName === 'prometheus.tanzu.vmware.com')!;
    assert.equal(prom.namespace, 'tkg-system');
    assert.ok(schemaFields(prom.schema).some(f => f.key === 'prometheus.pvc.storage'));
    assert.ok(cp.catalog!.some(c => c.displayName === 'Prometheus' && !c.installed));
    const plan = installPlan({ cluster: 'sandbox', def: prom, namespace: prom.namespace, name: 'prometheus', installed: cp.items, versionsHere: [prom.version], values: valuesText({ prometheus: { config: { retention: '14d' } } }) });
    const w = demoWriter(ctx, { now: NOW });
    for (const r of plan.requests('try it')) await w.send(r, true);
    await assert.rejects(w.send(plan.requests('try it')[0], false), (e: Error) => e.message === DEMO_WRITE_REFUSED);
  });
});
