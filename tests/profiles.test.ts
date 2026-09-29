/** v1.28: baseline profiles and the new rules. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_BASELINE, evaluateBaseline, normalizeBaseline, normalizeProfiles, parseRequirement, profileFor, profileMatches } from '../src/baseline';
import { normalizeConfig } from '../src/config';
import { demoClient, demoStores, DEMO_SUPERVISOR_RAW } from '../src/demo';
import { DEMO_SUPERVISOR } from '../src/demo/supervisor';
import { fetchSupervisor } from '../src/fleet';

const c = (o: any = {}): any => ({ key: 'k', name: 'checkout-prod', namespace: 'acme-prod-7kq2p', tenantName: 'acme', tenantId: 'uuid', labels: { env: 'prod' }, kubernetesVersion: 'v1.35.4+vmware.1', machines: [], nodePools: [], ...o });
const prof = (name: string, match: any, b: any = {}): any => ({ name, match, baseline: normalizeBaseline(b) });

describe('profiles', () => {
  test('matching: labels, names, namespaces, orgs; all given fields must fit; empty never matches', () => {
    assert.equal(profileMatches(prof('p', { labels: ['env=prod'] }), c()), true);
    assert.equal(profileMatches(prof('p', { labels: ['env'] }), c()), true, 'a key alone means any value');
    assert.equal(profileMatches(prof('p', { clusters: ['*-prod'], orgs: ['ACME'] }), c()), true);
    assert.equal(profileMatches(prof('p', { clusters: ['*-prod'], orgs: ['globex'] }), c()), false);
    assert.equal(profileMatches(prof('p', { namespaces: ['acme-dev-*'] }), c()), false);
    assert.equal(profileMatches(prof('p', {}), c()), false);
  });
  test('the first matching profile applies, else the default', () => {
    const profiles = [prof('prod', { labels: ['env=prod'] }, { controlPlaneReplicas: 3 }), prof('everything-acme', { orgs: ['acme'] }, { controlPlaneReplicas: 1 })];
    assert.equal(profileFor(c(), profiles, DEFAULT_BASELINE).name, 'prod');
    assert.equal(profileFor(c({ labels: { env: 'dev' } }), profiles, DEFAULT_BASELINE).name, 'everything-acme');
    assert.equal(profileFor(c({ labels: {}, tenantName: 'globex' }), profiles, DEFAULT_BASELINE).name, 'default');
  });
  test('normalised from settings: nameless profiles dropped, baselines completed', () => {
    const ps = normalizeProfiles([{ name: 'prod', match: { labels: ['env=prod'] }, baseline: { targetMinor: 'v1.36' } }, { match: {} }]);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].baseline.targetMinor, '1.36');
    assert.equal(ps[0].baseline.controlPlaneReplicas, 3, 'the rest from the defaults');
  });
});

describe('new rules', () => {
  const rule = (id: string, b: any, cl = c(), extras: any = {}) => evaluateBaseline(cl, normalizeBaseline(b), 1, undefined, new Date(), extras).find(r => r.id === id)!;
  test('target version: exact minor', () => {
    assert.equal(rule('target', {}).status, 'off');
    assert.equal(rule('target', { targetMinor: '1.35' }).status, 'ok');
    const behind = rule('target', { targetMinor: '1.36' });
    assert.equal(behind.status, 'drift');
    assert.ok(behind.fix, 'behind the target: an Upgrade link');
    assert.equal(rule('target', { targetMinor: '1.34' }).fix, undefined, 'ahead of the target: drift, but no upgrade to offer');
  });
  test('required packages: missing, too old, present', () => {
    const pk = [{ refName: 'cert-manager.tanzu.vmware.com', name: 'cert-manager', version: '1.16.1+vmware.1-tkg.1', namespace: 'x', state: 'ok' }, { refName: 'fluent-bit.tanzu.vmware.com', name: 'fluent-bit', version: '3.1.9+vmware.1', namespace: 'x', state: 'ok' }];
    assert.deepEqual(parseRequirement('fluent-bit>=3.2'), { name: 'fluent-bit', min: '3.2' });
    assert.equal(rule('packages', { requiredPackages: ['cert-manager'] }).status, 'unknown', 'not signed in');
    assert.equal(rule('packages', { requiredPackages: ['cert-manager', 'fluent-bit>=3.1'] }, c(), { packages: pk }).status, 'ok');
    const r = rule('packages', { requiredPackages: ['cert-manager', 'fluent-bit>=3.2', 'velero'] }, c(), { packages: pk });
    assert.equal(r.status, 'drift');
    assert.equal(r.current, 'fluent-bit 3.1.9 < 3.2, velero missing');
  });
  test('Pod Security default: at least as strict', () => {
    assert.equal(rule('psa', { podSecurity: 'baseline' }, c(), { psaDefault: 'restricted' }).status, 'ok');
    assert.equal(rule('psa', { podSecurity: 'restricted' }, c(), { psaDefault: 'baseline' }).status, 'drift');
    assert.equal(rule('psa', { podSecurity: 'restricted' }).status, 'unknown');
  });
});

describe('on the demo fleet', () => {
  test('clusters carry their labels, and a prod profile picks out prod', async () => {
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const sv = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any] } as any).supervisors[0];
    const r = await fetchSupervisor(sv, demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0 }), NOW);
    const profiles = [prof('prod', { labels: ['env=prod'] })];
    assert.deepEqual(r.clusters.map(x => [x.name, profileFor(x, profiles, DEFAULT_BASELINE).name]).sort(), [['analytics', 'default'], ['checkout', 'prod'], ['payments', 'prod'], ['sandbox', 'default']]);
  });
});
