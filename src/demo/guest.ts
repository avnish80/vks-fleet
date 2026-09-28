/**
 * Inside each demo cluster: nodes, workloads with their pods, namespaces with
 * Pod Security labels, packages, RBAC, storage classes, backups, scanner
 * reports and a saved kube-bench run, each cluster with its own problems.
 */
import { add, Store } from './router';
import { DEMO_CLUSTERS, machineNames } from './supervisor';

type C = (typeof DEMO_CLUSTERS)[number];

interface App {
  ns: string;
  name: string;
  kind: 'Deployment' | 'StatefulSet';
  replicas: number;
  ready: number;
  image: string;
  crash?: boolean;
  privileged?: boolean;
  hardened?: boolean;
  secretEnv?: boolean;
}

const APPS: Record<string, App[]> = {
  payments: [
    { ns: 'payments', name: 'api', kind: 'Deployment', replicas: 3, ready: 3, image: 'registry.acme.example/payments/api:2.14.1', hardened: true },
    { ns: 'payments', name: 'worker', kind: 'Deployment', replicas: 2, ready: 2, image: 'registry.acme.example/payments/worker:2.14.1', hardened: true },
  ],
  checkout: [
    { ns: 'shop', name: 'cart', kind: 'Deployment', replicas: 2, ready: 1, image: 'registry.acme.example/shop/cart:1.9.0', crash: true, secretEnv: true },
    { ns: 'shop', name: 'api', kind: 'Deployment', replicas: 2, ready: 2, image: 'registry.acme.example/payments/api:2.13.0' },
    { ns: 'legacy', name: 'sync-agent', kind: 'Deployment', replicas: 1, ready: 1, image: 'registry.acme.example/legacy/sync:0.4', privileged: true },
    { ns: 'default', name: 'debug-shell', kind: 'Deployment', replicas: 1, ready: 1, image: 'docker.io/library/busybox:latest' },
  ],
  sandbox: [{ ns: 'dev', name: 'demo-app', kind: 'Deployment', replicas: 1, ready: 1, image: 'docker.io/library/nginx:1.27' }],
  analytics: [
    { ns: 'streaming', name: 'kafka', kind: 'StatefulSet', replicas: 3, ready: 3, image: 'docker.io/bitnami/kafka:3.8', hardened: true },
    { ns: 'ml', name: 'notebook', kind: 'Deployment', replicas: 1, ready: 1, image: 'docker.io/jupyter/base-notebook:2026-06-01' },
  ],
};

const PSA: Record<string, string | undefined> = { payments: 'restricted', shop: 'baseline', legacy: 'privileged', streaming: 'baseline' };

const VKS_IMAGE = 'projects.packages.broadcom.com/vsphere/supervisor/vks-standard-packages/3.7.0-20260618/vks-addons';

export function buildGuest(c: C, now: Date): Store {
  const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3600e3).toISOString();
  const s: Store = { objects: new Map(), special: new Map() };
  const machines = machineNames(c);
  const cp = machines.find(m => m.cp)!;
  const workers = machines.filter(m => !m.cp);
  const apps = APPS[c.name] ?? [];

  // Nodes, with each kubelet's live configuration.
  add(
    s,
    '',
    'nodes',
    machines.map((m, i) => ({
      metadata: { name: m.name, labels: { ...(m.cp ? { 'node-role.kubernetes.io/control-plane': '' } : {}), 'kubernetes.io/hostname': m.name } },
      status: {
        conditions: [{ type: 'Ready', status: 'True' }],
        nodeInfo: { kubeletVersion: c.version, osImage: 'Ubuntu 24.04.4 LTS' },
        addresses: [{ type: 'InternalIP', address: `172.16.${DEMO_CLUSTERS.indexOf(c)}.${10 + i}` }],
        capacity: { cpu: m.cp ? '4' : '4', memory: '16Gi' },
        allocatable: { cpu: '3900m', memory: '15Gi' },
      },
    }))
  );
  for (const m of machines) {
    s.special!.set(`/api/v1/nodes/${m.name}/proxy/configz`, {
      kubeletconfig: {
        authentication: { anonymous: { enabled: false }, webhook: { enabled: true }, x509: { clientCAFile: '/etc/kubernetes/pki/ca.crt' } },
        authorization: { mode: 'Webhook' },
        readOnlyPort: 0,
        rotateCertificates: true,
        protectKernelDefaults: c.name === 'payments',
      },
    });
  }

  // Namespaces (Pod Security labels where set; VKS enforces "restricted" by default).
  const appNs = Array.from(new Set(apps.map(a => a.ns)));
  add(s, '', 'namespaces', [
    ...['kube-system', 'default', 'kube-public', 'vmware-system-tkg', 'tkg-system', 'tanzu-system-monitoring'].map(n => ({ metadata: { name: n, labels: {} } })),
    ...appNs.filter(n => n !== 'default').map(n => ({ metadata: { name: n, labels: PSA[n] ? { 'pod-security.kubernetes.io/enforce': PSA[n] } : {} } })),
    ...(c.name === 'payments' ? [{ metadata: { name: 'vks-fleet', labels: {} } }] : []),
    ...(c.name === 'payments' ? [{ metadata: { name: 'vks-fleet-scan', labels: { 'pod-security.kubernetes.io/enforce': 'privileged', 'app.kubernetes.io/managed-by': 'vks-fleet' } } }] : []),
  ]);

  // Control-plane static pods (flags readable through the API) and the CNI on every node.
  const staticPod = (component: string, args: string[]) => ({
    metadata: { namespace: 'kube-system', name: `${component}-${cp.name}`, labels: { component, tier: 'control-plane' }, creationTimestamp: iso(24 * 20) },
    spec: { nodeName: cp.name, containers: [{ name: component, image: `localhost:5000/tkg/${component}:${c.version}`, command: [component, ...args] }] },
    status: { phase: 'Running', containerStatuses: [{ name: component, ready: true, restartCount: 0, state: { running: {} } }] },
  });
  const pods: any[] = [
    staticPod('kube-apiserver', [
      '--authorization-mode=Node,RBAC',
      '--enable-admission-plugins=NodeRestriction',
      '--client-ca-file=/etc/kubernetes/pki/ca.crt',
      '--tls-cert-file=/etc/kubernetes/pki/apiserver.crt',
      '--tls-private-key-file=/etc/kubernetes/pki/apiserver.key',
      '--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt',
      '--etcd-certfile=/etc/kubernetes/pki/apiserver-etcd-client.crt',
      '--etcd-keyfile=/etc/kubernetes/pki/apiserver-etcd-client.key',
      '--kubelet-client-certificate=/etc/kubernetes/pki/apiserver-kubelet-client.crt',
      '--kubelet-client-key=/etc/kubernetes/pki/apiserver-kubelet-client.key',
      '--audit-log-path=/var/log/kubernetes/audit.log',
      '--audit-policy-file=/etc/kubernetes/audit-policy.yaml',
      '--audit-log-maxage=30',
      '--audit-log-maxbackup=10',
      '--audit-log-maxsize=100',
      '--encryption-provider-config=/etc/kubernetes/encryption.yaml',
      '--profiling=false',
    ]),
    staticPod('kube-controller-manager', ['--bind-address=127.0.0.1', '--use-service-account-credentials=true', '--service-account-private-key-file=/etc/kubernetes/pki/sa.key', '--root-ca-file=/etc/kubernetes/pki/ca.crt', '--profiling=false']),
    staticPod('kube-scheduler', ['--bind-address=127.0.0.1', '--profiling=false']),
    staticPod('etcd', ['--cert-file=/etc/kubernetes/pki/etcd/server.crt', '--key-file=/etc/kubernetes/pki/etcd/server.key', '--client-cert-auth=true', '--peer-cert-file=/etc/kubernetes/pki/etcd/peer.crt', '--peer-key-file=/etc/kubernetes/pki/etcd/peer.key', '--peer-client-cert-auth=true']),
    ...machines.map(m => ({
      metadata: { namespace: 'kube-system', name: `antrea-agent-${m.name.slice(-5)}`, labels: { app: 'antrea', component: 'antrea-agent' }, ownerReferences: [{ kind: 'DaemonSet', name: 'antrea-agent' }] },
      spec: { nodeName: m.name, containers: [{ name: 'antrea-agent', image: `${VKS_IMAGE}@sha256:1a2b` }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'antrea-agent', ready: true, restartCount: 0, state: { running: {} } }] },
    })),
  ];
  const deployments: any[] = [];
  const statefulsets: any[] = [];
  for (const a of apps) {
    const sc = a.hardened
      ? { runAsNonRoot: true, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } }
      : a.privileged
      ? { privileged: true }
      : {};
    const template = {
      metadata: { labels: { app: a.name } },
      spec: {
        containers: [
          {
            name: a.name,
            image: a.image,
            securityContext: sc,
            resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { memory: '1Gi' } },
            ...(a.secretEnv ? { env: [{ name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'cart-db', key: 'password' } } }] } : {}),
          },
        ],
        ...(a.privileged ? { hostNetwork: true } : {}),
      },
    };
    const obj = {
      metadata: { namespace: a.ns, name: a.name, labels: { app: a.name }, generation: 3 },
      spec: { replicas: a.replicas, selector: { matchLabels: { app: a.name } }, template },
      status: { replicas: a.replicas, readyReplicas: a.ready, availableReplicas: a.ready, updatedReplicas: a.replicas, observedGeneration: 3 },
    };
    (a.kind === 'Deployment' ? deployments : statefulsets).push(obj);
    for (let i = 0; i < a.replicas; i++) {
      const crashing = a.crash && i >= a.ready;
      const node = workers[i % workers.length]?.name ?? cp.name;
      pods.push({
        metadata: {
          namespace: a.ns,
          name: a.kind === 'StatefulSet' ? `${a.name}-${i}` : `${a.name}-6b7f9c-${suffixOf(a.name, i)}`,
          labels: { app: a.name },
          ownerReferences: [{ kind: a.kind === 'Deployment' ? 'ReplicaSet' : 'StatefulSet', name: a.kind === 'Deployment' ? `${a.name}-6b7f9c` : a.name }],
          creationTimestamp: iso(crashing ? 3 : 24 * 5),
        },
        spec: { ...template.spec, nodeName: node },
        status: {
          phase: 'Running',
          podIP: `192.168.${i}.${10 + i}`,
          containerStatuses: [
            crashing
              ? { name: a.name, ready: false, restartCount: 41, state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container' } }, lastState: { terminated: { reason: 'Error', exitCode: 1 } } }
              : { name: a.name, ready: true, restartCount: 0, state: { running: { startedAt: iso(24 * 5) } } },
          ],
        },
      });
    }
  }
  add(s, '', 'pods', pods);
  add(s, 'apps', 'deployments', deployments);
  add(s, 'apps', 'statefulsets', statefulsets);
  add(s, 'apps', 'daemonsets', [
    { metadata: { namespace: 'kube-system', name: 'antrea-agent', labels: { app: 'antrea' } }, spec: { template: { spec: { containers: [{ image: `${VKS_IMAGE}@sha256:1a2b` }] } } }, status: { desiredNumberScheduled: machines.length, numberReady: machines.length, numberAvailable: machines.length } },
  ]);
  add(s, '', 'services', [
    { metadata: { namespace: 'kube-system', name: 'kube-dns' }, spec: { type: 'ClusterIP', clusterIP: '10.96.0.10', ports: [{ port: 53 }] } },
    // The VKS Prometheus package (not on sandbox, to show "Enable monitoring").
    ...(c.name === 'sandbox'
      ? []
      : ['prometheus-server', 'alertmanager', 'prometheus-node-exporter', 'prometheus-kube-state-metrics'].map(n => ({
          metadata: { namespace: 'tanzu-system-monitoring', name: n },
          spec: { type: 'ClusterIP', ports: [{ name: 'http', port: n.includes('exporter') ? 9100 : n.includes('state') ? 8080 : 80 }] },
        }))),
    ...(c.name === 'payments' ? [{ metadata: { namespace: 'payments', name: 'api' }, spec: { type: 'LoadBalancer', ports: [{ port: 443 }], selector: { app: 'api' } }, status: { loadBalancer: { ingress: [{ ip: '198.51.100.70' }] } } }] : []),
  ]);
  add(s, '', 'persistentvolumeclaims', c.name === 'analytics' ? [0, 1, 2].map(i => ({ metadata: { namespace: 'streaming', name: `data-kafka-${i}` }, spec: { storageClassName: 'vsan-default-storage-policy' }, status: { phase: 'Bound', capacity: { storage: '50Gi' } } })) : []);
  add(
    s,
    'policy',
    'poddisruptionbudgets',
    c.name === 'checkout' ? [{ metadata: { namespace: 'shop', name: 'cart' }, spec: { minAvailable: 2, selector: { matchLabels: { app: 'cart' } } }, status: { currentHealthy: 1, desiredHealthy: 2, disruptionsAllowed: 0, expectedPods: 2 } }] : []
  );
  add(
    s,
    'networking.k8s.io',
    'networkpolicies',
    c.name === 'payments' ? ['payments'].map(ns => ({ metadata: { namespace: ns, name: 'default-deny' }, spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } })) : []
  );
  add(s, '', 'events', c.name === 'checkout' ? [{ metadata: { namespace: 'shop', name: 'cart.1' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container cart', involvedObject: { kind: 'Pod', namespace: 'shop', name: pods.find(p => p.metadata.namespace === 'shop' && p.status.containerStatuses[0].state.waiting)?.metadata.name }, count: 41, lastTimestamp: iso(0.1) }] : []);
  add(s, 'storage.k8s.io', 'storageclasses', [
    { metadata: { name: 'vsan-default-storage-policy', annotations: c.name === 'sandbox' ? {} : { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'csi.vsphere.vmware.com' },
    { metadata: { name: 'vsan-default-storage-policy-latebinding' }, provisioner: 'csi.vsphere.vmware.com', volumeBindingMode: 'WaitForFirstConsumer' },
  ]);
  add(s, '', 'serviceaccounts', appNs.map(ns => ({ metadata: { namespace: ns, name: 'default' }, ...(ns === 'payments' ? { automountServiceAccountToken: false } : {}) })));
  add(s, '', 'resourcequotas', c.name === 'payments' ? [{ metadata: { namespace: 'payments', name: 'compute' }, spec: {}, status: {} }] : []);
  add(s, '', 'limitranges', []);
  add(s, '', 'configmaps', []);
  add(s, 'rbac.authorization.k8s.io', 'clusterroles', [{ metadata: { name: 'cluster-admin' }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] }, { metadata: { name: 'view' }, rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] }] }]);
  add(s, 'rbac.authorization.k8s.io', 'clusterrolebindings', [
    { metadata: { name: 'cluster-admin' }, roleRef: { kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'Group', name: 'system:masters' }] },
    ...(c.name === 'checkout' ? [{ metadata: { name: 'dev-admin' }, roleRef: { kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ kind: 'User', name: 'dev@acme.example' }] }] : []),
  ]);

  // Packages (Carvel)
  const pkgi = (ns: string, name: string, ref: string, version: string, extra: any = {}) => ({
    metadata: { namespace: ns, name },
    spec: { packageRef: { refName: ref, versionSelection: { constraints: version } }, ...(extra.spec ?? {}) },
    status: { version, conditions: [{ type: extra.failed ? 'ReconcileFailed' : 'ReconcileSucceeded', status: 'True' }], ...(extra.failed ? { usefulErrorMessage: extra.failed } : {}) },
  });
  add(s, 'packaging.carvel.dev', 'packageinstalls', [
    pkgi('vmware-system-tkg', `${c.name}-antrea`, 'antrea.tanzu.vmware.com', '2.3.0+vmware.1-tkg.1'),
    pkgi('tkg-system', 'cert-manager', 'cert-manager.tanzu.vmware.com', c.name === 'sandbox' ? '1.15.3+vmware.1-tkg.1' : '1.16.1+vmware.1-tkg.1'),
    ...(c.name === 'checkout' ? [pkgi('tkg-system', 'fluent-bit', 'fluent-bit.tanzu.vmware.com', '3.1.9+vmware.1-tkg.1', { failed: 'kapp: Error: waiting on reconcile daemonset/fluent-bit: timed out' })] : []),
    ...(c.name === 'analytics' ? [pkgi('tkg-system', 'contour', 'contour.tanzu.vmware.com', '1.30.1+vmware.1-tkg.1')] : []),
  ]);
  add(s, 'packaging.carvel.dev', 'packagerepositories', [{ metadata: { namespace: 'tkg-system', name: 'vks-standard-packages' }, spec: { fetch: { imgpkgBundle: { image: `${VKS_IMAGE.replace('/vks-addons', '')}/repo:v3.7.0` } } }, status: { conditions: [{ type: 'ReconcileSucceeded', status: 'True' }] } }]);
  // The repository's catalog: versions with their values schemas, and descriptions.
  const str = (description: string, def?: string) => ({ type: 'string', description, ...(def !== undefined ? { default: def } : {}) });
  const SCHEMAS: Record<string, any> = {
    'cert-manager': { type: 'object', properties: { namespace: str('Namespace to install cert-manager into', 'cert-manager') } },
    contour: {
      type: 'object',
      properties: {
        namespace: str('Namespace for Contour and Envoy', 'tanzu-system-ingress'),
        contour: { type: 'object', properties: { replicas: { type: 'integer', default: 2, description: 'Contour controller replicas' }, logLevel: { type: 'string', enum: ['info', 'debug'], default: 'info' } } },
        envoy: {
          type: 'object',
          properties: {
            service: { type: 'object', properties: { type: { type: 'string', enum: ['LoadBalancer', 'NodePort', 'ClusterIP'], default: 'LoadBalancer', description: 'How Envoy is exposed' } } },
            hostPorts: { type: 'object', properties: { enable: { type: 'boolean', default: false, description: 'Bind Envoy to host ports 80/443' } } },
          },
        },
        certificates: { type: 'object', properties: { useCertManager: { type: 'boolean', default: true, description: 'Issue the Contour/Envoy certificates with cert-manager' } } },
      },
    },
    prometheus: {
      type: 'object',
      properties: {
        namespace: str('Namespace for Prometheus', 'tanzu-system-monitoring'),
        prometheus: {
          type: 'object',
          properties: {
            deployment: { type: 'object', properties: { replicas: { type: 'integer', default: 1 } } },
            pvc: { type: 'object', properties: { storage: str('Volume size for metrics', '150Gi'), storageClassName: str('Storage class (empty: the default class)', '') } },
            config: { type: 'object', properties: { retention: str('How long to keep metrics', '42d') } },
          },
        },
        ingress: { type: 'object', properties: { enabled: { type: 'boolean', default: false }, virtual_host_fqdn: str('Host name when ingress is enabled', 'prometheus.system.tanzu') } },
      },
    },
    harbor: {
      type: 'object',
      properties: {
        namespace: str('Namespace for Harbor', 'tanzu-system-registry'),
        hostname: str('Harbor host name (required)'),
        harborAdminPassword: str('Initial admin password (required)'),
        persistence: { type: 'object', properties: { persistentVolumeClaim: { type: 'object', properties: { registry: { type: 'object', properties: { size: str('Registry storage', '50Gi') } } } } } },
        trivy: { type: 'object', properties: { enabled: { type: 'boolean', default: true, description: 'Scan pushed images with Trivy' } } },
      },
    },
  };
  const defs: Array<[string, string]> = [
    ['cert-manager.tanzu.vmware.com', '1.15.3+vmware.1-tkg.1'],
    ['cert-manager.tanzu.vmware.com', '1.16.1+vmware.1-tkg.1'],
    ['cert-manager.tanzu.vmware.com', '1.17.2+vmware.1-tkg.1'],
    ['contour.tanzu.vmware.com', '1.30.1+vmware.1-tkg.1'],
    ['contour.tanzu.vmware.com', '1.31.0+vmware.1-tkg.1'],
    ['fluent-bit.tanzu.vmware.com', '3.1.9+vmware.1-tkg.1'],
    ['prometheus.tanzu.vmware.com', '2.54.1+vmware.1-tkg.1'],
    ['harbor.tanzu.vmware.com', '2.12.1+vmware.1-tkg.1'],
  ];
  add(
    s,
    'data.packaging.carvel.dev',
    'packages',
    defs.map(([ref, v]) => {
      const schema = SCHEMAS[ref.split('.')[0]];
      return { metadata: { namespace: 'tkg-system', name: `${ref}.${v}` }, spec: { refName: ref, version: v, ...(schema ? { valuesSchema: { openAPIv3: schema } } : {}) } };
    })
  );
  add(
    s,
    'data.packaging.carvel.dev',
    'packagemetadatas',
    [
      ['cert-manager.tanzu.vmware.com', 'cert-manager', 'Certificate management for Kubernetes'],
      ['contour.tanzu.vmware.com', 'Contour', 'Ingress controller built on Envoy'],
      ['fluent-bit.tanzu.vmware.com', 'Fluent Bit', 'Log processor and forwarder'],
      ['prometheus.tanzu.vmware.com', 'Prometheus', 'Metrics collection and alerting'],
      ['harbor.tanzu.vmware.com', 'Harbor', 'Container registry with scanning and replication'],
    ].map(([ref, displayName, shortDescription]) => ({ metadata: { namespace: 'tkg-system', name: ref }, spec: { displayName, shortDescription } }))
  );

  // Metrics (utilisation)
  add(s, 'metrics.k8s.io', 'nodes', machines.map((m, i) => ({ metadata: { name: m.name }, usage: { cpu: `${m.cp ? 900 : 1200 + i * 350}m`, memory: `${m.cp ? 5 : 7 + i}Gi` } })));
  add(s, 'metrics.k8s.io', 'pods', pods.filter(p => !p.metadata.namespace.startsWith('kube')).map(p => ({ metadata: { namespace: p.metadata.namespace, name: p.metadata.name }, containers: [{ name: 'c', usage: { cpu: '120m', memory: '300Mi' } }] })));

  // Backups (Velero) on the acme production clusters.
  if (c.name === 'payments' || c.name === 'checkout') {
    const ok = c.name === 'payments';
    add(
      s,
      'velero.io',
      'backups',
      [ok ? 6 : 24 * 5 + 2, ok ? 30 : 24 * 6 + 2].map((h, i) => ({
        metadata: { namespace: 'velero', name: `daily-${i}`, labels: { 'velero.io/schedule-name': 'daily' }, creationTimestamp: iso(h) },
        status: { phase: ok || i ? 'Completed' : 'PartiallyFailed', startTimestamp: iso(h), completionTimestamp: iso(h - 0.2) },
      }))
    );
    add(s, 'velero.io', 'schedules', [{ metadata: { namespace: 'velero', name: 'daily' }, spec: { schedule: '0 2 * * *' }, status: { phase: 'Enabled', lastBackup: iso(ok ? 6 : 24 * 5 + 2) } }]);
    add(s, 'velero.io', 'backupstoragelocations', [{ metadata: { namespace: 'velero', name: 'default' }, status: { phase: 'Available' } }]);
  }

  // Trivy Operator reports (production clusters).
  if (c.name === 'payments' || c.name === 'checkout') {
    const vr = (ns: string, name: string, server: string, repo: string, tag: string, crit: number, high: number, fixed: boolean) => ({
      metadata: { namespace: ns, name: `${name}-${suffixOf(name, 1)}`, labels: { 'trivy-operator.resource.kind': 'Deployment', 'trivy-operator.resource.name': name, 'trivy-operator.container.name': name } },
      report: {
        registry: { server },
        artifact: { repository: repo, tag },
        summary: { criticalCount: crit, highCount: high, mediumCount: high * 2, lowCount: 4, unknownCount: 0 },
        vulnerabilities: [
          ...Array.from({ length: crit }, (_, i) => ({ vulnerabilityID: `CVE-2026-${31000 + i}`, severity: 'CRITICAL', resource: i % 2 ? 'openssl' : 'libcurl', installedVersion: '3.0.2', fixedVersion: fixed ? '3.0.16' : '', title: i % 2 ? 'openssl: memory corruption in X.509 parsing' : 'curl: use-after-free in connection reuse', primaryLink: `https://avd.aquasec.com/nvd/cve-2026-${31000 + i}` })),
          ...Array.from({ length: Math.min(high, 5) }, (_, i) => ({ vulnerabilityID: `CVE-2026-${32000 + i}`, severity: 'HIGH', resource: 'stdlib', installedVersion: '1.22.3', fixedVersion: '1.22.9', title: 'golang: net/http request smuggling' })),
        ],
      },
    });
    const own = c.name === 'payments' ? [vr('payments', 'api', 'registry.acme.example', 'payments/api', '2.14.1', 0, 2, true)] : [vr('shop', 'cart', 'registry.acme.example', 'shop/cart', '1.9.0', 3, 9, true), vr('shop', 'api', 'registry.acme.example', 'payments/api', '2.13.0', 1, 6, true)];
    add(s, 'aquasecurity.github.io', 'vulnerabilityreports', [...own, { ...vr('kube-system', 'antrea-agent', 'projects.packages.broadcom.com', 'vsphere/supervisor/vks-standard-packages/3.7.0-20260618/vks-addons', '', 21, 60, true) }]);
    add(s, 'aquasecurity.github.io', 'configauditreports', [
      { metadata: { namespace: apps[0].ns, labels: { 'trivy-operator.resource.kind': 'Deployment', 'trivy-operator.resource.name': apps[0].name } }, report: { checks: [{ checkID: 'KSV011', title: 'CPU not limited', severity: 'LOW', success: false }] } },
    ]);
    add(s, 'aquasecurity.github.io', 'exposedsecretreports', []);
    add(s, 'aquasecurity.github.io', 'clustercompliancereports', [
      { metadata: { name: 'k8s-cis-1.23' }, spec: { compliance: { id: 'k8s-cis-1.23', title: 'CIS Kubernetes Benchmarks v1.23' } }, status: { summary: { passCount: c.name === 'payments' ? 104 : 91, failCount: c.name === 'payments' ? 11 : 24 }, summaryReport: { controlCheck: [{ id: '5.2.2', name: 'Minimize the admission of privileged containers', severity: 'HIGH', totalFail: c.name === 'payments' ? 0 : 1 }] } } },
    ]);
  }
  // Kyverno results on analytics.
  if (c.name === 'analytics') {
    add(s, 'wgpolicyk8s.io', 'policyreports', [
      {
        metadata: { namespace: 'ml', name: 'pol-notebook' },
        scope: { kind: 'Deployment', namespace: 'ml', name: 'notebook' },
        summary: { pass: 14, fail: 2, warn: 1 },
        results: [
          { policy: 'require-team-label', rule: 'check-team', result: 'fail', message: 'label "team" is required', resources: [{ kind: 'Deployment', namespace: 'ml', name: 'notebook' }] },
          { policy: 'disallow-latest-tag', rule: 'require-image-tag', result: 'warn', message: 'use a pinned image tag' },
          { policy: 'require-requests-limits', rule: 'validate-resources', result: 'fail', message: 'CPU and memory limits are required', resources: [{ kind: 'Deployment', namespace: 'ml', name: 'notebook' }] },
        ],
      },
    ]);
    add(s, 'wgpolicyk8s.io', 'clusterpolicyreports', []);
  }
  // The vCenter collector's latest status, kept in payments (demo settings point at it).
  if (c.name === 'payments') {
    const status = {
      collectedAt: iso(0.04),
      vcenter: 'vc-demo.example',
      supervisors: [
        {
          id: 'domain-c10',
          name: 'demo-cluster-01',
          configStatus: 'RUNNING',
          kubernetesStatus: 'WARNING',
          messages: [{ severity: 'WARNING', text: 'Memory usage on the Supervisor control plane is above 85%.' }],
          apiEndpoints: ['10.10.0.2'],
          controlPlaneVMs: [{ name: 'SupervisorControlPlaneVM (1)', power: 'POWERED_ON', cpus: 4, memoryMiB: 16384 }],
          hosts: ['01', '02', '03', '04'].map(h => ({ name: `esx-${h}.demo.local`, connection: 'CONNECTED', power: 'POWERED_ON' })),
          services: [
            { id: 'tkg.vsphere.vmware.com', version: '3.7.0', state: 'CONFIGURED' },
            { id: 'velero.vsphere.vmware.com', version: '1.6.2', state: 'ERROR', messages: [{ severity: 'ERROR', text: 'Image pull failed for the velero plugin.' }] },
          ],
          alarms: [{ entity: 'esx-02.demo.local', name: 'Host memory usage', status: 'yellow', time: iso(3), acknowledged: false }],
        },
      ],
      errors: [],
    };
    add(s, '', 'configmaps', [{ metadata: { namespace: 'vks-fleet', name: 'vks-fleet-vcenter' }, data: { 'status.json': JSON.stringify(status) } }]);
  }
  // A saved kube-bench run on payments.
  if (c.name === 'payments') {
    const t = (id: string, desc: string, status: string, remediation?: string) => ({ id, desc, status, remediation });
    const runs = [
      { at: iso(20), target: 'control-plane', node: cp.name, benchmark: 'cis-1.10', tests: [t('1.1.1', 'API server pod specification file permissions are 600 or more restrictive', 'PASS'), t('1.1.12', 'etcd data directory ownership is etcd:etcd', 'PASS'), t('1.2.1', '--anonymous-auth is false', 'WARN', 'Review anonymous access')] },
      { at: iso(20), target: 'worker', node: workers[0].name, benchmark: 'cis-1.10', tests: [t('4.1.1', 'kubelet service file permissions are 600 or more restrictive', 'PASS'), t('4.1.9', 'kubelet config.yaml permissions are 600 or more restrictive', 'FAIL', 'chmod 600 /var/lib/kubelet/config.yaml')] },
    ];
    add(s, '', 'configmaps', [{ metadata: { namespace: 'vks-fleet-scan', name: 'kube-bench-results' }, data: { 'runs.json': JSON.stringify(runs) } }]);
  }
  return s;
}

function suffixOf(name: string, i: number): string {
  let h = 7;
  for (const ch of `${name}${i}`) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(-5);
}
