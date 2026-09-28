/**
 * A fictional VKS fleet for demo mode (and tests): one Supervisor, two orgs
 * (acme, globex), four clusters, each with problems worth showing:
 *   payments   healthy; Trivy reports; a saved kube-bench run; daily backups
 *   checkout   a machine stuck draining behind a PodDisruptionBudget, a
 *              crash-looping pod, a privileged pod, a cluster-admin grant
 *   sandbox    a Kubernetes version behind; no default StorageClass
 *   analytics  control-plane certificates expiring soon; Kyverno results
 * Nothing here is real; names and addresses are made up.
 */
import { HeadlampClusterInfo } from '../contexts';
import { add, Store } from './router';

export const DEMO_SUPERVISOR = 'vks-demo-supervisor';
export const DEMO_PREFIX = 'vks-demo';
export const ORG_ACME = 'a1c3e5f7-1234-4abc-8def-0123456789aa';
export const ORG_GLOBEX = 'b2d4f6a8-5678-4bcd-9ef0-123456789abb';
const ORG_LABEL = 'vmware-system-vcf/organization-id';

/** The Supervisor entry demo mode uses (settings in raw form). */
export const DEMO_SUPERVISOR_RAW = {
  id: 'demo',
  headlampCluster: DEMO_SUPERVISOR,
  displayName: 'Demo Supervisor',
  tenantLabelKey: ORG_LABEL,
  tenantNames: { [ORG_ACME]: 'acme', [ORG_GLOBEX]: 'globex' },
};

interface Pool {
  name: string;
  replicas: number;
  vmClass: string;
}
interface DemoCluster {
  name: string;
  ns: string;
  host: string;
  version: string;
  cls: string;
  pools: Pool[];
  certDays: number;
  stuck?: boolean;
}

export const DEMO_CLUSTERS: DemoCluster[] = [
  { name: 'payments', ns: 'acme-prod-7kq2p', host: '10.20.0.11', version: 'v1.36.2+vmware.2', cls: 'builtin-generic-v3.7.0', pools: [{ name: 'np-1', replicas: 3, vmClass: 'best-effort-large' }], certDays: 300 },
  { name: 'checkout', ns: 'acme-prod-7kq2p', host: '10.20.0.12', version: 'v1.36.2+vmware.2', cls: 'builtin-generic-v3.7.0', pools: [{ name: 'np-1', replicas: 2, vmClass: 'best-effort-medium' }], certDays: 250, stuck: true },
  { name: 'sandbox', ns: 'acme-dev-3xm9d', host: '10.20.1.11', version: 'v1.35.4+vmware.1', cls: 'builtin-generic-v3.5.0', pools: [{ name: 'np-1', replicas: 1, vmClass: 'best-effort-medium' }], certDays: 200 },
  {
    name: 'analytics',
    ns: 'globex-ml-9w4tz',
    host: '10.30.0.11',
    version: 'v1.36.2+vmware.2',
    cls: 'builtin-generic-v3.7.0',
    pools: [
      { name: 'np-1', replicas: 2, vmClass: 'best-effort-large' },
      { name: 'gpu', replicas: 1, vmClass: 'best-effort-xlarge' },
    ],
    certDays: 18,
  },
];

export const contextName = (cluster: string) => `${DEMO_PREFIX}:${cluster}`;

export function demoContexts(): HeadlampClusterInfo[] {
  return [
    { name: DEMO_SUPERVISOR, server: 'https://10.10.0.2:443' },
    ...DEMO_CLUSTERS.map(c => ({ name: contextName(c.name), server: `https://${c.host}:6443` })),
  ];
}

const suffix = (seed: string, n = 5) => {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).padStart(n, 'x').slice(-n);
};

export function machineNames(c: DemoCluster): Array<{ name: string; cp: boolean; pool?: string }> {
  return [
    { name: `${c.name}-cp-${suffix(c.name + 'cp')}`, cp: true },
    ...c.pools.flatMap(p => Array.from({ length: p.replicas + (c.stuck && p.name === 'np-1' ? 1 : 0) }, (_, i) => ({ name: `${c.name}-${p.name}-${suffix(c.name + p.name, 4)}-${suffix(`${c.name}${p.name}${i}`)}`, cp: false, pool: p.name }))),
  ];
}

export function buildSupervisor(now: Date): Store {
  const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600e3).toISOString();
  const later = (days: number) => new Date(now.getTime() + days * 86400e3).toISOString();
  const s: Store = { objects: new Map(), special: new Map() };
  const orgOf = (ns: string) => (ns.startsWith('acme') ? ORG_ACME : ORG_GLOBEX);
  const spaces = ['acme-prod-7kq2p', 'acme-dev-3xm9d', 'globex-ml-9w4tz'];
  add(s, '', 'namespaces', [
    ...spaces.map(n => ({
      metadata: {
        name: n,
        labels: { [ORG_LABEL]: orgOf(n) },
        creationTimestamp: iso(24 * 60),
        // acme's production namespace has resource-pool limits, so previews show overcommit.
        annotations: n === 'acme-prod-7kq2p' ? { 'vmware-system-resource-pool-cpu-limit': '60000', 'vmware-system-resource-pool-memory-limit': '96Gi' } : {},
      },
    })),
    ...['kube-system', 'default', 'svc-tkg-d7x2k', 'vmware-system-vks-public'].map(n => ({ metadata: { name: n, labels: {} } })),
  ]);
  for (const c of DEMO_CLUSTERS) {
    const machines = machineNames(c);
    add(s, 'cluster.x-k8s.io', 'clusters', [
      {
        apiVersion: 'cluster.x-k8s.io/v1beta1',
        metadata: { namespace: c.ns, name: c.name, creationTimestamp: iso(24 * 40) },
        spec: {
          controlPlaneRef: { name: `${c.name}-cp` },
          controlPlaneEndpoint: { host: c.host, port: 6443 },
          clusterNetwork: { pods: { cidrBlocks: ['192.168.0.0/16'] }, services: { cidrBlocks: ['10.96.0.0/12'] }, serviceDomain: 'cluster.local' },
          topology: {
            class: c.cls,
            version: c.version,
            controlPlane: { replicas: 1 },
            variables: [
              { name: 'vmClass', value: 'best-effort-large' },
              { name: 'storageClass', value: 'vsan-default-storage-policy' },
            ],
            workers: { machineDeployments: c.pools.map(p => ({ class: 'node-pool', name: p.name, replicas: p.replicas, variables: { overrides: [{ name: 'vmClass', value: p.vmClass }] } })) },
          },
        },
        status: { phase: 'Provisioned', conditions: [{ type: 'Ready', status: 'True' }, { type: 'ControlPlaneReady', status: 'True' }, { type: 'InfrastructureReady', status: 'True' }] },
      },
    ]);
    add(
      s,
      'cluster.x-k8s.io',
      'machinedeployments',
      c.pools.map(p => ({
        metadata: { namespace: c.ns, name: `${c.name}-${p.name}-${suffix(c.name + p.name, 4)}`, labels: { 'cluster.x-k8s.io/cluster-name': c.name, 'topology.cluster.x-k8s.io/deployment-name': p.name } },
        spec: { clusterName: c.name, replicas: p.replicas, template: { spec: { version: c.version } } },
        status: { replicas: p.replicas + (c.stuck && p.name === 'np-1' ? 1 : 0), readyReplicas: p.replicas, availableReplicas: p.replicas, updatedReplicas: p.replicas },
      }))
    );
    add(s, 'controlplane.cluster.x-k8s.io', 'kubeadmcontrolplanes', [{ metadata: { namespace: c.ns, name: `${c.name}-cp` }, spec: { replicas: 1, version: c.version }, status: { readyReplicas: 1, replicas: 1, version: c.version } }]);
    add(
      s,
      'cluster.x-k8s.io',
      'machines',
      machines.map((m, i) => {
        const stuck = c.stuck && !m.cp && i === machines.length - 1;
        return {
          metadata: {
            namespace: c.ns,
            name: m.name,
            creationTimestamp: iso(stuck ? 60 : 24 * 20),
            ...(stuck ? { deletionTimestamp: iso(26) } : {}),
            labels: { 'cluster.x-k8s.io/cluster-name': c.name, ...(m.cp ? { 'cluster.x-k8s.io/control-plane': '' } : { 'cluster.x-k8s.io/deployment-name': `${c.name}-${m.pool}-${suffix(c.name + m.pool, 4)}` }) },
          },
          spec: { clusterName: c.name, version: c.version, failureDomain: `zone-${(i % 3) + 1}` },
          status: {
            phase: stuck ? 'Deleting' : 'Running',
            nodeRef: { name: m.name },
            addresses: [{ type: 'InternalIP', address: `172.16.${DEMO_CLUSTERS.indexOf(c)}.${10 + i}` }],
            nodeInfo: { osImage: 'Ubuntu 24.04.4 LTS', kubeletVersion: c.version },
            ...(m.cp ? { certificatesExpiryDate: later(c.certDays) } : {}),
            conditions: stuck
              ? [
                  { type: 'Ready', status: 'False' },
                  { type: 'DrainingSucceeded', status: 'False', reason: 'Draining', message: 'Cannot evict pod as it would violate the pod\u2019s disruption budget: shop/cart-6b7f9c' },
                ]
              : [{ type: 'Ready', status: 'True' }],
          },
        };
      })
    );
    add(s, 'cluster.x-k8s.io', 'machinehealthchecks', [
      {
        metadata: { namespace: c.ns, name: `${c.name}-np-1-mhc` },
        spec: { clusterName: c.name },
        status: { expectedMachines: c.pools[0].replicas, currentHealthy: c.pools[0].replicas, remediationsAllowed: 1, conditions: [{ type: 'RemediationAllowed', status: 'True' }] },
      },
    ]);
    add(
      s,
      'vmoperator.vmware.com',
      'virtualmachines',
      machines.map(m => ({
        metadata: { namespace: c.ns, name: m.name, labels: { 'capv.vmware.com/cluster.name': c.name, ...(m.cp ? { 'capv.vmware.com/cluster.role': 'controlplane' } : { 'capv.vmware.com/cluster.role': 'node' }) } },
        spec: { className: m.cp ? 'best-effort-large' : c.pools.find(p => p.name === m.pool)?.vmClass ?? 'best-effort-medium', powerState: 'PoweredOn', storageClass: 'vsan-default-storage-policy' },
        status: { powerState: 'PoweredOn', network: { primaryIP4: '172.16.0.10' }, conditions: [{ type: 'VirtualMachineCreated', status: 'True' }] },
      }))
    );
    add(s, 'vmoperator.vmware.com', 'virtualmachineservices', [
      { metadata: { namespace: c.ns, name: c.name, ownerReferences: [{ kind: 'Cluster', name: c.name }] }, spec: { type: 'LoadBalancer', ports: [{ port: 6443 }], selector: { 'capv.vmware.com/cluster.name': c.name } }, status: { loadBalancer: { ingress: [{ ip: c.host }] } } },
    ]);
  }
  // Standalone VMs (VM Service)
  add(s, 'vmoperator.vmware.com', 'virtualmachines', [
    { metadata: { namespace: 'acme-prod-7kq2p', name: 'reporting-db', labels: { app: 'reporting-db' }, creationTimestamp: iso(24 * 30) }, spec: { className: 'best-effort-medium', powerState: 'PoweredOn', storageClass: 'vsan-default-storage-policy', network: { interfaces: [{ name: 'eth0', network: { kind: 'Subnet', name: 'db-net' } }] } }, status: { powerState: 'PoweredOn', network: { primaryIP4: '172.20.4.5' }, conditions: [{ type: 'VirtualMachineCreated', status: 'True' }] } },
    { metadata: { namespace: 'globex-ml-9w4tz', name: 'jupyter-gpu', creationTimestamp: iso(24 * 9) }, spec: { className: 'best-effort-xlarge', powerState: 'PoweredOff' }, status: { powerState: 'PoweredOff', network: { primaryIP4: '172.30.8.4' }, conditions: [] } },
  ]);
  for (const ns of spaces) {
    add(
      s,
      'vmoperator.vmware.com',
      'virtualmachineclasses',
      [
        ['best-effort-medium', 2, '8Gi'],
        ['best-effort-large', 4, '16Gi'],
        ['best-effort-xlarge', 8, '32Gi'],
      ].map(([name, cpus, memory]) => ({ metadata: { namespace: ns, name }, spec: { hardware: { cpus, memory } } }))
    );
    add(s, 'crd.nsx.vmware.com', 'networkinfos', [{ metadata: { namespace: ns, name: ns }, vpcs: [{ name: `${ns.split('-')[0]}-vpc`, defaultSNATIP: ns.startsWith('acme') ? '198.51.100.1' : '203.0.113.1', privateIPs: ['172.16.0.0/16'], networkStack: 'FullStackVPC' }] }]);
    add(s, 'cns.vmware.com', 'storagepolicyquotas', [
      {
        metadata: { namespace: ns, name: 'vsan-default-storage-policy-storagepolicyquota' },
        spec: { limit: ns.startsWith('acme-prod') ? '500Gi' : '200Gi' },
        status: {
          appliedLimit: ns.startsWith('acme-prod') ? '500Gi' : '200Gi',
          extensions: [
            { extensionName: 'vmware-system-vmop-webhook-service', extensionQuotaUsage: [{ scQuotaUsage: { reserved: '0', used: String((ns.startsWith('acme-prod') ? 310 : 60) * 2 ** 30) }, storageClassName: 'vsan-default-storage-policy' }] },
            { extensionName: 'cns.vmware.com', extensionQuotaUsage: [{ scQuotaUsage: { reserved: '0', used: String((ns.startsWith('acme-prod') ? 95 : 20) * 2 ** 30) } }] },
          ],
        },
      },
    ]);
  }
  add(s, 'crd.nsx.vmware.com', 'subnets', [
    { metadata: { namespace: 'acme-prod-7kq2p', name: 'db-net' }, spec: { accessMode: 'Private', ipv4SubnetSize: 16 }, status: { networkAddresses: ['172.20.4.0/28'], conditions: [{ type: 'Ready', status: 'True' }] } },
    { metadata: { namespace: 'acme-prod-7kq2p', name: 'public' }, spec: { accessMode: 'Public', ipv4SubnetSize: 64 }, status: { networkAddresses: ['198.51.100.64/26'], conditions: [{ type: 'Ready', status: 'True' }] } },
  ]);
  add(s, 'crd.nsx.vmware.com', 'securitypolicies', [{ metadata: { namespace: 'acme-prod-7kq2p', name: 'allow-web' }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } }]);
  add(s, 'crd.nsx.vmware.com', 'subnetsets', spaces.map(ns => ({ metadata: { namespace: ns, name: 'vm-default' }, spec: { accessMode: 'Private' }, status: { subnets: [{ networkAddresses: ['172.16.8.0/24'] }], conditions: [{ type: 'Ready', status: 'True' }] } })));
  // VM images: two shared across the Supervisor, one only in acme's production namespace.
  const image = (name: string, displayName: string, os: string, version: string, ns?: string) => ({
    metadata: { name, ...(ns ? { namespace: ns } : {}) },
    spec: {},
    status: { name: displayName, osInfo: { type: os }, productInfo: { fullVersion: version }, conditions: [{ type: 'Ready', status: 'True' }] },
  });
  add(s, 'vmoperator.vmware.com', 'clustervirtualmachineimages', [
    image('vmi-0a1b2c3d4e5f', 'ubuntu-24.04-server-cloudimg-amd64', 'ubuntu64Guest', '24.04'),
    image('vmi-1f2e3d4c5b6a', 'photon-5.0-cloud', 'vmwarePhoton64Guest', '5.0'),
  ]);
  add(s, 'vmoperator.vmware.com', 'virtualmachineimages', [image('vmi-9a8b7c6d5e4f', 'acme-hardened-rhel-9.4', 'rhel9_64Guest', '9.4', 'acme-prod-7kq2p')]);
  add(
    s,
    'cluster.x-k8s.io',
    'clusterclasses',
    ['3.5.0', '3.6.0', '3.7.0'].map(v => ({ metadata: { namespace: 'vmware-system-vks-public', name: `builtin-generic-v${v}` } }))
  );
  add(
    s,
    'run.tanzu.vmware.com',
    'tanzukubernetesreleases',
    ['v1.35.4+vmware.1', 'v1.36.2+vmware.2', 'v1.37.1+vmware.1'].map(v => ({
      metadata: { name: v.replace(/\+/g, '---') },
      spec: { version: v },
      status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'Compatible', status: 'True' }] },
    }))
  );
  add(s, '', 'events', [
    {
      metadata: { namespace: 'acme-prod-7kq2p', name: 'ev1' },
      type: 'Warning',
      reason: 'DrainFailed',
      message: 'Cannot evict pod as it would violate the pod\u2019s disruption budget',
      involvedObject: { kind: 'Machine', name: machineNames(DEMO_CLUSTERS[1]).slice(-1)[0].name },
      lastTimestamp: iso(0.2),
      count: 312,
    },
  ]);
  // Supervisor services, all running.
  add(s, '', 'pods', ['capi-controller-manager', 'capv-controller-manager', 'vks-controller'].map(n => ({ metadata: { namespace: 'svc-tkg-d7x2k', name: `${n}-7d9f8-abcde` }, status: { phase: 'Running', containerStatuses: [{ ready: true, restartCount: 0, state: { running: {} } }] } })));
  add(s, '', 'nodes', [
    { metadata: { name: '4201a1b2c3d4', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.34.9+vmware.1' } } },
    ...['01', '02', '03'].map(h => ({ metadata: { name: `esx-${h}.demo.local`, labels: {} }, status: { conditions: [{ type: 'Ready', status: 'True' }], nodeInfo: { kubeletVersion: 'v1.34.5-sph' } } })),
  ]);
  return s;
}
