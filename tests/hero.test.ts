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
    assert.match(items[5].text, /rotation is on/);
  });
  test('needs you now: critical first, then reach, then the original order; no info', () => {
    const top = needsYouNow([issue('w1', 'warning'), issue('i1', 'info'), issue('c1', 'critical'), issue('w2', 'warning', 3), issue('w3', 'warning')]);
    assert.deepEqual(top.map(i => i.id), ['c1', 'w2', 'w1']);
  });
  test('at a glance', () => {
    const g = glance([cluster('a'), cluster('b', { health: 'degraded' })], [90, 70], [issue('c', 'critical'), issue('w', 'warning')], [86, 95]);
    assert.deepEqual(g, { score: 80, clusters: 2, attention: 1, critical: 1, warnings: 1, supervisorScore: 86 });
  });
  test('in words', () => {
    assert.equal(inWords(NOW.getTime() + 3 * 86400e3, NOW.getTime()), 'in 3 days');
    assert.equal(inWords(NOW.getTime() - 1, NOW.getTime()), 'now');
  });
});
