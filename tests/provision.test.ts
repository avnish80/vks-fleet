/** Creating VMs and clusters: manifests, the capacity preview, checks, YAML, and a demo run end to end. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blocked } from '../src/actions';
import { normalizeConfig } from '../src/config';
import { DEMO_SUPERVISOR_RAW, demoClient, demoStores, demoWriter } from '../src/demo';
import { DEMO_SUPERVISOR } from '../src/demo/supervisor';
import { fetchSupervisor } from '../src/fleet';
import { fetchInventory } from '../src/inventory';
import { annotationLimits, configuredByNamespace } from '../src/limits';
import { clusterDelta, clusterManifest, cloudConfig, createPlan, impact, toYaml, vmManifests } from '../src/provision';

const GiB = 2 ** 30;

describe('VM manifests', () => {
  const base = { namespace: 'ns', name: 'web-1', className: 'best-effort-small', image: 'vmi-1', imageKind: 'ClusterVirtualMachineImage' as const, powerOn: true };
  test('a VM on the namespace default network, no cloud-init', () => {
    const docs = vmManifests(base);
    assert.equal(docs.length, 1);
    assert.deepEqual(docs[0].spec.image, { kind: 'ClusterVirtualMachineImage', name: 'vmi-1' });
    assert.equal(docs[0].spec.network, undefined);
    assert.equal(docs[0].spec.bootstrap, undefined);
  });
  test('with a subnet set and an SSH key: a cloud-init Secret the VM points at', () => {
    const docs = vmManifests({ ...base, network: { kind: 'SubnetSet', name: 'vm-default' }, sshKey: 'ssh-ed25519 AAAA me@host', user: 'ops' });
    assert.equal(docs[0].kind, 'Secret');
    assert.match(docs[0].stringData['user-data'], /^#cloud-config\n[\s\S]*- name: ops[\s\S]*- ssh-ed25519 AAAA me@host/);
    assert.deepEqual(docs[1].spec.bootstrap.cloudInit.rawCloudConfig, { name: 'web-1-cloud-init', key: 'user-data' });
    assert.equal(docs[1].spec.network.interfaces[0].network.kind, 'SubnetSet');
    assert.match(cloudConfig('u', 'k'), /ssh_pwauth: false/);
  });
});

describe('cluster manifests', () => {
  const template = {
    metadata: { name: 'payments', namespace: 'ns', resourceVersion: '1', uid: 'x' },
    spec: {
      clusterNetwork: { pods: { cidrBlocks: ['192.168.0.0/16'] } },
      controlPlaneEndpoint: { host: '10.0.0.1', port: 6443 },
      topology: { class: 'builtin-generic-v3.7.0', classNamespace: 'vmware-system-vks-public', version: 'v1.35.4', controlPlane: { replicas: 1 }, variables: [{ name: 'vmClass', value: 'best-effort-large' }, { name: 'storageClass', value: 'vsan' }, { name: 'custom', value: { a: 1 } }], workers: { machineDeployments: [{ class: 'node-pool', name: 'np-1', replicas: 3 }] } },
    },
    status: { phase: 'Provisioned' },
  };
  test('copied from a working cluster: its class and variables, new name, version, pools', () => {
    const m = clusterManifest({ namespace: 'ns', name: 'new-1', version: 'v1.36.2', controlPlaneReplicas: 3, pools: [{ name: 'np-1', replicas: 2, vmClass: 'best-effort-medium' }], template, controlPlaneClass: 'best-effort-medium' });
    assert.deepEqual(Object.keys(m.metadata).sort(), ['labels', 'name', 'namespace']);
    assert.equal(m.spec.controlPlaneEndpoint, undefined, 'the endpoint is assigned by the Supervisor, not copied');
    assert.equal(m.status, undefined);
    assert.equal(m.spec.topology.class, 'builtin-generic-v3.7.0');
    assert.equal(m.spec.topology.version, 'v1.36.2');
    assert.equal(m.spec.topology.controlPlane.replicas, 3);
    assert.deepEqual(m.spec.topology.variables.find((v: any) => v.name === 'custom').value, { a: 1 }, 'unknown variables are kept');
    assert.equal(m.spec.topology.variables.find((v: any) => v.name === 'vmClass').value, 'best-effort-medium');
    assert.deepEqual(m.spec.clusterNetwork, template.spec.clusterNetwork);
  });
  test('from scratch: class, class namespace, common variables', () => {
    const m = clusterManifest({ namespace: 'ns', name: 'x', version: 'v1.36.2', controlPlaneReplicas: 1, pools: [], clusterClass: 'builtin-generic-v3.7.0', classNamespace: 'vmware-system-vks-public', controlPlaneClass: 'c', storageClass: 's' });
    assert.equal(m.spec.topology.classNamespace, 'vmware-system-vks-public');
    assert.deepEqual(m.spec.topology.variables, [{ name: 'vmClass', value: 'c' }, { name: 'storageClass', value: 's' }]);
  });
  test('what it adds, by VM class', () => {
    const classes = [{ namespace: 'ns', name: 'm', cpus: 2, memoryBytes: 8 * GiB }, { namespace: 'ns', name: 'l', cpus: 4, memoryBytes: 16 * GiB }];
    const d = clusterDelta({ namespace: 'ns', name: 'x', version: 'v', controlPlaneReplicas: 3, controlPlaneClass: 'm', pools: [{ name: 'a', replicas: 2, vmClass: 'l' }, { name: 'b', replicas: 1, vmClass: 'gpu' }] }, classes);
    assert.equal(d.cpus, 3 * 2 + 2 * 4);
    assert.equal(d.memoryBytes, (3 * 8 + 2 * 16) * GiB);
    assert.deepEqual(d.unknown, ['pool b (gpu)']);
  });
});

describe('capacity preview and checks', () => {
  test('memory overcommit before and after', () => {
    const e = impact({ cpus: 8, memoryBytes: 32 * GiB }, { vcpu: 20, memoryBytes: 100 * GiB, reservedBytes: 0 }, { namespace: 'ns', source: 'supervisor', memoryLimitBytes: 50 * GiB, cpuLimitMHz: 20000, storage: [], vmClasses: [], zones: [] }, []);
    const mem = e.rows.find(r => r.resource.startsWith('Memory'))!;
    assert.match(mem.before, /2\.0×/);
    assert.match(mem.after, /2\.6×/);
    assert.equal(mem.status, 'warn');
    assert.ok(e.checks.some(c => c.level === 'warn' && /2\.6× the namespace limit/.test(c.text)));
  });
  test('a ResourceQuota that would be exceeded', () => {
    const e = impact({ cpus: 8, memoryBytes: 8 * GiB }, undefined, undefined, [{ resource: 'requests.cpu', kind: 'cpu', used: 10, hard: 12, free: 2 }]);
    assert.ok(e.checks.some(c => /more requests\.cpu than the namespace quota/.test(c.text)));
  });
  test('names: invalid or taken are blocked', () => {
    assert.equal(blocked(createPlan('VM', [], 'Web_1', 'ns', [], [])), true);
    assert.equal(blocked(createPlan('VM', [], 'web-1', 'ns', [], ['web-1'])), true);
    assert.equal(blocked(createPlan('VM', [], 'web-2', 'ns', [], ['web-1'])), false);
  });
});

describe('YAML for GitOps', () => {
  test('readable, with quoting where YAML would misread', () => {
    const y = toYaml([{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'x' }, data: { a: 'yes', b: '42', c: 'a: b', d: 'plain value', e: 'multi\nline\n' } }]);
    assert.equal(
      y,
      'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  a: "yes"\n  b: "42"\n  c: "a: b"\n  d: plain value\n  e: |\n    multi\n    line\n'
    );
    assert.match(toYaml([{ a: 1 }, { b: 2 }]), /^a: 1\n---\nb: 2\n$/);
  });
});

describe('on the demo fleet', () => {
  test('images and classes from the real inventory; preview against a real limit; dry run passes', async () => {
    const NOW = new Date('2026-09-27T10:00:00Z');
    demoStores(NOW);
    const sv = normalizeConfig({ supervisors: [DEMO_SUPERVISOR_RAW as any] } as any).supervisors[0];
    const client = demoClient(DEMO_SUPERVISOR, { now: NOW, latencyMs: 0, remember: false });
    const r = await fetchSupervisor(sv, client, NOW);
    const inv = await fetchInventory(client, sv, r.namespaces!.map(n => n.name), true, new Map());
    const ns = 'acme-prod-7kq2p';
    const images = inv.images!.filter(i => i.kind === 'ClusterVirtualMachineImage' || i.namespace === ns);
    assert.deepEqual(images.map(i => i.displayName), ['acme-hardened-rhel-9.4', 'photon-5.0-cloud', 'ubuntu-24.04-server-cloudimg-amd64']);
    const classes = (r.vmClasses ?? []).filter(c => c.namespace === ns);
    assert.ok(classes.some(c => c.name === 'best-effort-large' && c.cpus === 4));
    const limits = annotationLimits(r.namespaces!.find(n => n.name === ns) && { 'vmware-system-resource-pool-memory-limit': '96Gi' });
    assert.equal(limits?.memoryBytes, 96 * GiB);
    const configured = configuredByNamespace([r], new Map([[sv.id, inv]])).get(ns)!;
    const e = impact({ cpus: 4, memoryBytes: 16 * GiB }, configured, { namespace: ns, source: 'supervisor', memoryLimitBytes: limits!.memoryBytes, storage: [], vmClasses: [], zones: [] }, []);
    assert.ok(e.rows.find(x => x.resource.startsWith('Memory'))!.after.includes('×'));
    const docs = vmManifests({ namespace: ns, name: 'web-1', className: 'best-effort-medium', image: images[2].name, imageKind: images[2].kind, network: { kind: 'SubnetSet', name: 'vm-default' }, sshKey: 'ssh-ed25519 AAAA me@host', powerOn: true });
    const plan = createPlan('VM', docs, 'web-1', ns, e.checks, inv.vms.filter(v => v.namespace === ns).map(v => v.name));
    assert.equal(blocked(plan), false);
    const w = demoWriter(DEMO_SUPERVISOR, { now: NOW });
    const reqs = plan.requests('');
    assert.deepEqual(reqs.map(q => q.path), [`/api/v1/namespaces/${ns}/secrets`, `/apis/vmoperator.vmware.com/v1alpha5/namespaces/${ns}/virtualmachines`]);
    for (const q of reqs) await w.send(q, true);
  });
});
