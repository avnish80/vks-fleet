/** v1.33: readable networks, and Observability that merges node series and explains what's missing. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shortNode } from '../src/names';
import { groupAttachments, orderSubnets, subnetGroup } from '../src/networkView';
import { mergeByNode, NEEDS_HELP, nodeResolver, PANELS } from '../src/observability';

const C = 'kubernetes-cluster-c3d4';
const D = 'kubernetes-cluster-a1b2';
const node = (c: string, n: string) => `${c}-${c}-np-1-${n}`;
const vms: any[] = [
  ...['a', 'b', 'c'].map(n => ({ name: node(C, n), namespace: 'ns', cluster: C })),
  { name: `${C}-qmdg9-zqwqq`, namespace: 'ns', cluster: C },
  ...['x', 'y', 'z', 'w'].map(n => ({ name: node(D, n), namespace: 'ns', cluster: D })),
  { name: 'nfs-server-vm', namespace: 'ns' },
  { name: 'vm1', namespace: 'ns' },
];
const subnet = (name: string, members: string[], o: any = {}): any => ({ name, namespace: 'ns', kind: 'Subnet', cidrs: ['172.30.0.0/27'], used: members.length, capacity: 29, members, ...o });

describe('networks', () => {
  test("a cluster's own network: one chip, nodes on hover", () => {
    const s = subnet(`${C}-xbxsn`, [`cluster ${C}`, ...vms.filter(v => v.cluster === C).map(v => `VM ${v.name}`)], { kind: 'SubnetSet' });
    const a = groupAttachments(s, vms, [C, D]);
    assert.deepEqual(a.map(x => x.label), ['c3d4 · cluster + 4 nodes']);
    assert.match(a[0].title, /np-1-a, np-1-b, np-1-c, qmdg9-zqwqq/);
  });
  test('nodes on another network are a secondary network; standalone VMs keep their own chip', () => {
    const s = subnet('nfs-storage-net', [...vms.filter(v => v.cluster === C).map(v => `VM ${v.name}`), 'VM nfs-server-vm']);
    const a = groupAttachments(s, vms, [C, D]);
    assert.deepEqual(a.map(x => [x.label, !!x.secondary]), [['c3d4 · 4 nodes · secondary', true], ['nfs-server-vm', false]]);
  });
  test('order: cluster networks, in use by fullness, public, then unused', () => {
    const list = [
      subnet('vm-default', [], { cidrs: [], used: 0 }),
      subnet('subnet-public', ['VM vm1'], { accessMode: 'Public', capacity: 253 }),
      subnet('multus-parent-net', ['VM a'], { used: 0 }),
      subnet('nfs-storage-net', ['VM a', 'VM b'], { used: 5 }),
      subnet(`${D}-bk97w`, [`cluster ${D}`], { used: 4 }),
    ];
    assert.deepEqual(orderSubnets(list).map(s => [s.name, subnetGroup(s)]), [
      [`${D}-bk97w`, 'cluster'],
      ['nfs-storage-net', 'used'],
      ['multus-parent-net', 'used'],
      ['subnet-public', 'public'],
      ['vm-default', 'unused'],
    ]);
  });
});

describe('observability', () => {
  test('a node scraped twice becomes one series; IP-labelled series get the node name', () => {
    const resolve = nodeResolver(C, [{ name: node(C, 'a'), nodeName: node(C, 'a'), internalIP: '10.95.119.129' }], shortNode);
    const merged = mergeByNode(
      [
        { labels: { node: node(C, 'a'), job: 'node-exporter' }, points: [[1, 80], [2, 85]] },
        { labels: { node: node(C, 'a'), job: 'tanzu' }, points: [[1, 82], [2, 84]] },
        { labels: { instance: '10.95.119.129:9100' }, points: [[3, 70]] },
      ] as any,
      resolve
    );
    assert.deepEqual(merged, [{ labels: { name: 'np-1-a' }, points: [[1, 82], [2, 85], [3, 70]] }]);
  });
  test('etcd size falls back to what the API server reports', () => {
    const etcd = PANELS.find(p => p.id === 'etcd-size')!;
    assert.ok(etcd.queries.some(q => q.includes('apiserver_storage_size_bytes')));
    assert.ok(etcd.queries.indexOf('max(apiserver_storage_size_bytes)') > 0, 'after the direct etcd metrics');
  });
  test('every panel says how to fix it when nothing is collected', () => {
    for (const p of PANELS) assert.ok(NEEDS_HELP[p.needs], `${p.id} needs "${p.needs}"`);
    for (const id of ['node-cpu', 'node-mem', 'node-disk', 'net-errors']) assert.equal(PANELS.find(p => p.id === id)?.perNode, true, id);
  });
});

describe('networks without the node VMs in the list (as in the lab)', () => {
  test('node VMs are recognised by name, from the cluster attached to the subnet or a given list', () => {
    const own = subnet(`${C}-xbxsn`, [`cluster ${C}`, `VM ${node(C, 'a')}`, `VM ${node(C, 'b')}`], { kind: 'SubnetSet' });
    assert.deepEqual(groupAttachments(own, [], [C, D]).map(x => x.label), ['c3d4 · cluster + 2 nodes']);
    const nfs = subnet('nfs-storage-net', [`VM ${node(C, 'a')}`, `VM ${C}-qmdg9-zqwqq`, 'VM nfs-server-vm']);
    assert.deepEqual(groupAttachments(nfs, [{ name: 'nfs-server-vm', namespace: 'ns' } as any], [C, D]).map(x => x.label), ['c3d4 · 2 nodes · secondary', 'nfs-server-vm']);
  });
});
