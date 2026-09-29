/** v1.27: the fleet page's hero band. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { glance, horizon, inWords, needsYouNow } from '../src/fleetHero';

const NOW = new Date('2026-09-29T00:00:00Z');
const days = (d: number) => new Date(NOW.getTime() + d * 86400e3).toISOString();
const cluster = (name: string, o: any = {}): any => ({ key: `s/ns/${name}`, supervisorId: 's', namespace: 'ns', name, health: 'healthy', machines: [], ...o });
const issue = (id: string, severity: string, reach = 0): any => ({ id, severity, title: id, affected: { clusters: Array(reach).fill('c'), nodes: [], pods: [], tenants: [] } });

describe('hero band', () => {
  test('the next 30 days: sorted, toned, and only what falls inside', () => {
    const items = horizon({
      now: NOW,
      clusters: [cluster('a', { certificatesExpiry: days(18) }), cluster('b', { certificatesExpiry: days(5) }), cluster('c', { certificatesExpiry: days(90) }), cluster('d', { certificatesExpiry: days(20), certificateRotation: { enabled: true } })],
      forecasts: [{ clusterName: 'checkout', clusterKey: 'k', forecasts: [{ what: 'node disk', subject: 'n1', seconds: 38 * 3600 }, { what: 'volume', subject: 'v', seconds: 40 * 86400 }] }],
      supervisorDisks: [{ supervisor: 'wld', vm: 'SupervisorControlPlaneVM (1)', seconds: 3 * 86400 }],
      silences: [{ id: 's', match: {}, label: 'KSV011', reason: '', createdAt: '', until: days(12) }, { id: 'old', match: {}, label: 'x', reason: '', createdAt: '', until: days(-2) }],
    });
    assert.deepEqual(items.map(i => [Math.round((i.at - NOW.getTime()) / 86400e3 * 10) / 10, i.kind, i.tone]), [
      [1.6, 'capacity', 'error'],
      [3, 'supervisor', 'error'],
      [5, 'certificate', 'error'],
      [12, 'silence', 'info'],
      [18, 'certificate', 'warning'],
      [20, 'certificate', 'info'],
    ]);
    assert.match(items[5].text, /rotation renews them first/);
  });
  test('needs you now: critical first, then reach, then the original order; no info', () => {
    const top = needsYouNow([issue('w1', 'warning'), issue('i1', 'info'), issue('c1', 'critical'), issue('w2', 'warning', 3), issue('w3', 'warning')]);
    assert.deepEqual(top.map(i => i.id), ['c1', 'w2', 'w1']);
  });
  test('needs you now: something running out within a week comes first, grouped per cluster', () => {
    const coming = horizon({
      now: NOW,
      clusters: [],
      short: n => n.replace('kubernetes-cluster-', ''),
      forecasts: [{ clusterName: 'kubernetes-cluster-mnet', clusterKey: 'k-mnet', forecasts: [{ what: 'node memory', subject: 'kubernetes-cluster-mnet-kubernetes-cluster-mnet-np-1-7d8jrql2vq', seconds: 6 * 86400 }, { what: 'node memory', subject: 'kubernetes-cluster-mnet-qmdg9-zqwqq', seconds: 12 * 86400 }, { what: 'node memory', subject: 'kubernetes-cluster-mnet-np-1-b', seconds: 6.5 * 86400 }] }],
    });
    const forecastIssue = { ...issue('k-mnet#forecast#node memory#x', 'warning', 1), clusterKey: 'k-mnet' };
    const top = needsYouNow([issue('posture', 'warning', 9), forecastIssue], coming, NOW.getTime());
    assert.equal(top[0].title, 'mnet: node memory runs out on 2 nodes');
    assert.equal(top[0].sub, 'first in 6 days');
    assert.deepEqual(top.map(t => t.id), ['soon|k-mnet|node memory', 'posture'], 'the matching forecast issue is not repeated');
  });
  test('at a glance', () => {
    const g = glance([cluster('a'), cluster('b', { health: 'degraded' })], [90, 70], [issue('c', 'critical'), issue('w', 'warning')], [86, 95]);
    assert.deepEqual(g, { score: 80, clusters: 2, attention: 1, critical: 1, warnings: 1, supervisorScore: 86 });
  });
  test('in words', () => {
    assert.equal(inWords(NOW.getTime() + 3 * 86400e3, NOW.getTime()), 'in 3 days');
    assert.equal(inWords(NOW.getTime() - 1, NOW.getTime()), 'now');
  });
  test('the timeline merges duplicates, shortens names, and includes certificates inside clusters', () => {
    const items = horizon({
      now: NOW,
      clusters: [],
      short: n => n.replace('kubernetes-cluster-', ''),
      forecasts: [{ clusterName: 'kubernetes-cluster-mnet', clusterKey: 'k', forecasts: [{ what: 'node memory', subject: 'kubernetes-cluster-mnet-kubernetes-cluster-mnet-np-1-7d8jrql2vq', seconds: 6 * 86400 }, { what: 'node memory', subject: 'kubernetes-cluster-mnet-kubernetes-cluster-mnet-np-1-7d8jrql2vq', seconds: 6.1 * 86400 }] }],
      certificates: [{ clusterName: 'kubernetes-cluster-9yfw', clusterKey: 'k2', name: 'vks-system-ingress/contour-cert', expires: days(17) }],
    });
    assert.deepEqual(items.map(i => i.text), ['mnet: node memory full on np-1-7d8jrql2vq', '9yfw: certificate vks-system-ingress/contour-cert expires']);
  });
});
