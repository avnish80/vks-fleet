/** v1.42: the cluster page is tabbed, and every existing link still lands on its section. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { CLUSTER_TABS, clusterTabOf, SECTION_TAB } from '../src/clusterTabs';

describe('cluster page tabs', () => {
  const rows = { machines: ['c-np-1-abc'], pools: ['np-1'] };
  test('a link opens the tab its section is on', () => {
    assert.equal(clusterTabOf('', '#backups'), 'packages');
    assert.equal(clusterTabOf('', '#inside'), 'workloads');
    assert.equal(clusterTabOf('', '#machines'), 'nodes');
    assert.equal(clusterTabOf('', '#timeline'), 'history');
    assert.equal(clusterTabOf('', '#checks'), 'overview');
  });
  test('a link to a row opens the tab the row is on', () => {
    assert.equal(clusterTabOf('?focus=c-np-1-abc', '', rows), 'nodes');
    assert.equal(clusterTabOf('?focus=np-1&action=scale&pool=np-1', '#node-pools', rows), 'nodes');
    assert.equal(clusterTabOf('?focus=certificates', '#summary', rows), 'overview');
    assert.equal(clusterTabOf('?day=2026-10-12', ''), 'history');
    assert.equal(clusterTabOf('?action=timeouts&pool=np-1', '', rows), 'nodes');
  });
  test('a link that names nothing leaves the tab alone', () => {
    assert.equal(clusterTabOf('', ''), undefined);
    assert.equal(clusterTabOf('?action=upgrade', ''), undefined);
    assert.equal(clusterTabOf('', '#no-such-section'), undefined);
  });
  test('every section anchor on the page, and every anchor other pages link to, has a tab', () => {
    const src = join(__dirname, '..', 'src');
    const files = (dir: string): string[] => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
    const page = Array.from(readFileSync(join(src, 'components', 'ClusterDetail.tsx'), 'utf8').matchAll(/<Box id="([a-z-]+)"/g)).map(m => m[1]).filter(id => !id.startsWith('row-'));
    assert.ok(page.length >= 15);
    for (const id of page) assert.ok(SECTION_TAB[id], `section "${id}" is on a tab`);
    const linked = Array.from(new Set(files(src).flatMap(f => Array.from(readFileSync(f, 'utf8').matchAll(/hash: '([a-z-]+)'/g)).map(m => m[1]))));
    // Anchors on other pages (the fleet page's own) are not this page's business.
    const elsewhere = new Set(['next-30-days', 'issues', 'policy']);
    for (const id of linked.filter(x => !elsewhere.has(x))) assert.ok(SECTION_TAB[id], `link target "#${id}" is on a tab`);
    for (const t of Object.values(SECTION_TAB)) assert.ok(CLUSTER_TABS.some(x => x.id === t));
  });
});
