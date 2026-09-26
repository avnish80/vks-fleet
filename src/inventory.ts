/**
 * Everything in an org's Supervisor namespaces besides the clusters: VM
 * Service VMs, load balancers (VirtualMachineServices), VPC networking (NSX
 * subnets, subnet sets, ports, security policies, routes, NAT, IP
 * allocations), storage quotas and volumes, and the Supervisor's own nodes.
 * Each part is read on its own; what isn't served or allowed is skipped with
 * a note, so any Supervisor shape works.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { scopedList } from './api/scopedList';
import { KubeObject, parseConditions } from './capi/v1beta1';
import { cidrContains, usableAddresses } from './ip';
import { parseQuantity } from './quantity';
import { listFirstServed, VMOP_VERSIONS } from './supervisor';
import {
  Inventory,
  LbInfo,
  NsxObjectInfo,
  ServiceVm,
  StorageQuotaInfo,
  SubnetInfo,
  SupervisorConfig,
  SupervisorNodes,
  VolumeInfo,
  VpcInfo,
} from './types';

const NSX = '/apis/crd.nsx.vmware.com/v1alpha1';
const CLUSTER_LABELS = ['capv.vmware.com/cluster.name', 'cluster.x-k8s.io/cluster-name', 'run.tanzu.vmware.com/cluster.name'];

const clusterOf = (o: KubeObject) => {
  const l = o.metadata.labels ?? {};
  for (const k of CLUSTER_LABELS) if (l[k]) return l[k];
  return undefined;
};

const readyOf = (o: any): { ready?: boolean; message?: string } => {
  const c = parseConditions(o?.status?.conditions).find(x => x.type === 'Ready');
  return c ? { ready: c.status === 'True', message: c.message ?? c.reason } : {};
};

export function parseVms(supervisorId: string, vms: KubeObject[], images: Map<string, string>, snapshots: KubeObject[]): ServiceVm[] {
  return vms.map(v => {
    const spec: any = v.spec ?? {};
    const status: any = v.status ?? {};
    const ns = v.metadata.namespace ?? '';
    const conditions = parseConditions(status.conditions);
    const notReady = conditions.find(c => c.status === 'False' && /Ready|Created|Available/i.test(c.type));
    const imageRef: string | undefined = spec.imageName ?? spec.image?.name;
    return {
      supervisorId,
      namespace: ns,
      name: v.metadata.name,
      power: status.powerState ?? spec.powerState,
      ready: conditions.length ? !notReady : undefined,
      readyMessage: notReady ? notReady.message ?? notReady.reason : undefined,
      className: spec.className,
      image: imageRef ? images.get(imageRef) ?? imageRef : undefined,
      ip: status.network?.primaryIP4 ?? status.vmIp,
      zone: status.zone ?? v.metadata.labels?.['topology.kubernetes.io/zone'],
      interfaces: (spec.network?.interfaces ?? []).map((i: any) => ({ name: i?.name ?? '', kind: i?.network?.kind, network: i?.network?.name })),
      volumes: (spec.volumes ?? []).map((x: any) => x?.persistentVolumeClaim?.claimName).filter(Boolean),
      storageClass: spec.storageClass,
      createdAt: v.metadata.creationTimestamp,
      cluster: clusterOf(v),
      conditions,
      snapshots: snapshots
        .filter(s => s.metadata.namespace === ns && ((s.spec as any)?.vmRef?.name ?? (s.spec as any)?.vmName) === v.metadata.name)
        .map(s => ({ name: s.metadata.name, createdAt: s.metadata.creationTimestamp, ...readyOf(s) })),
    };
  });
}

/** Image name → friendly name (VirtualMachineImage status.name, e.g. "ubuntu-22.04…"). */
export function imageNames(images: KubeObject[]): Map<string, string> {
  return new Map(
    images.map(i => [i.metadata.name, String((i.status as any)?.name ?? (i.spec as any)?.imageID ?? i.metadata.name)])
  );
}

export function parseLbs(supervisorId: string, services: KubeObject[]): LbInfo[] {
  return services.map(s => {
    const spec: any = s.spec ?? {};
    const labels = s.metadata.labels ?? {};
    const ns = s.metadata.namespace ?? '';
    const cluster = labels['run.tanzu.vmware.com/cluster.name'] ?? ((s.metadata as any).ownerReferences ?? []).find((o: any) => o.kind === 'Cluster')?.name;
    const guestNs = labels['run.tanzu.vmware.com/service.namespace'];
    const guestName = labels['run.tanzu.vmware.com/service.name'];
    let kind: LbInfo['kind'] = 'other';
    if (cluster && guestName) kind = 'guest-service';
    else if (cluster) kind = 'cluster-api';
    else if (Object.keys(spec.selector ?? {}).length) kind = 'vm';
    return {
      supervisorId,
      namespace: ns,
      name: s.metadata.name,
      vip: (s.status as any)?.loadBalancer?.ingress?.[0]?.ip,
      ports: (spec.ports ?? []).map((p: any) => ({ name: p?.name, port: Number(p?.port), protocol: p?.protocol })),
      kind,
      cluster,
      guestService: guestName ? `${guestNs ?? 'default'}/${guestName}` : undefined,
      vms: [],
      createdAt: s.metadata.creationTimestamp,
    };
  });
}

/** Attaches VM labels so load balancers can find the VMs they select. */
export function lbsWithVmLabels(supervisorId: string, services: KubeObject[], vmObjects: KubeObject[], vms: ServiceVm[]): LbInfo[] {
  const byName = new Map(vmObjects.map(v => [`${v.metadata.namespace}/${v.metadata.name}`, v.metadata.labels ?? {}]));
  const out = parseLbs(supervisorId, services);
  for (const lb of out) {
    if (lb.kind !== 'vm' && lb.kind !== 'other') continue;
    const svc = services.find(s => s.metadata.namespace === lb.namespace && s.metadata.name === lb.name);
    const selector: Record<string, string> = (svc?.spec as any)?.selector ?? {};
    if (!Object.keys(selector).length) continue;
    lb.vms = vms
      .filter(v => v.namespace === lb.namespace && !v.cluster)
      .filter(v => {
        const l = byName.get(`${v.namespace}/${v.name}`) ?? {};
        return Object.entries(selector).every(([k, val]) => l[k] === val);
      })
      .map(v => v.name);
  }
  return out;
}

function subnetCidrs(o: any): { cidrs: string[]; gateways: string[] } {
  const st = o?.status ?? {};
  const cidrs = [...(st.networkAddresses ?? []), ...(st.subnets ?? []).flatMap((x: any) => x?.networkAddresses ?? [])];
  const gateways = [...(st.gatewayAddresses ?? []), ...(st.subnets ?? []).flatMap((x: any) => x?.gatewayAddresses ?? [])];
  return { cidrs: Array.from(new Set(cidrs.map(String))), gateways: Array.from(new Set(gateways.map(String))) };
}

/** Subnets and subnet sets with usage counted from IPs in use in the same namespace. */
export function parseSubnets(
  supervisorId: string,
  subnets: KubeObject[],
  subnetSets: KubeObject[],
  ipsByNamespace: Map<string, Set<string>>,
  vms: ServiceVm[],
  clusterNames: Map<string, string[]>
): SubnetInfo[] {
  const one = (o: KubeObject, kind: SubnetInfo['kind']): SubnetInfo => {
    const ns = o.metadata.namespace ?? '';
    const { cidrs, gateways } = subnetCidrs(o);
    const ips = Array.from(ipsByNamespace.get(ns) ?? []);
    const used = ips.filter(ip => cidrs.some(c => cidrContains(c, ip))).length;
    const declared = Number((o.spec as any)?.ipv4SubnetSize);
    const capacity = cidrs.length ? cidrs.reduce((n, c) => n + usableAddresses(c), 0) : declared > 3 ? declared - 3 : 0;
    const vmMembers = vms.filter(v => v.namespace === ns && v.interfaces.some(i => i.network === o.metadata.name)).map(v => `VM ${v.name}`);
    const clusterMembers = (clusterNames.get(ns) ?? []).filter(c => o.metadata.name.startsWith(`${c}-`)).map(c => `cluster ${c}`);
    return {
      supervisorId,
      namespace: ns,
      name: o.metadata.name,
      kind,
      accessMode: (o.spec as any)?.accessMode,
      cidrs,
      gateways,
      ...readyOf(o),
      used,
      capacity,
      members: [...clusterMembers, ...vmMembers],
      shared: (o.status as any)?.shared === true || (o.spec as any)?.shared === true,
    };
  };
  return [...subnets.map(s => one(s, 'Subnet')), ...subnetSets.map(s => one(s, 'SubnetSet'))];
}

/** IPs in use per namespace: subnet ports, VM addresses, load balancer VIPs. */
export function ipsInUse(ports: KubeObject[], vms: ServiceVm[], lbs: LbInfo[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  const add = (ns: string, ip?: string) => {
    if (!ip) return;
    const set = m.get(ns) ?? new Set<string>();
    set.add(ip.split('/')[0]);
    m.set(ns, set);
  };
  for (const p of ports) {
    const st: any = p.status ?? {};
    for (const a of st.networkInterfaceConfig?.ipAddresses ?? []) add(p.metadata.namespace ?? '', a?.ipAddress);
    for (const a of st.ipAddresses ?? []) add(p.metadata.namespace ?? '', typeof a === 'string' ? a : a?.ipAddress);
  }
  for (const v of vms) add(v.namespace, v.ip);
  for (const l of lbs) add(l.namespace, l.vip);
  return m;
}

export function parseVpcs(infos: KubeObject[]): VpcInfo[] {
  return infos.flatMap(i =>
    ((i as any).vpcs ?? (i.status as any)?.vpcs ?? []).map((v: any) => ({
      namespace: i.metadata.namespace ?? '',
      name: v?.name ?? i.metadata.name,
      snatIP: v?.defaultSNATIP,
      lbIP: v?.loadBalancerIPAddresses,
      privateIPs: v?.privateIPs ?? [],
      stack: v?.networkStack,
    }))
  );
}

export function parseNsx(kind: string, objects: KubeObject[], detail: (o: any) => string | undefined): NsxObjectInfo[] {
  return objects.map(o => ({ namespace: o.metadata.namespace, kind, name: o.metadata.name, ...readyOf(o), detail: detail(o) }));
}

export function parseQuotas(objects: KubeObject[]): StorageQuotaInfo[] {
  return objects
    .filter(q => !/^svc-/.test(q.metadata.namespace ?? ''))
    .map(q => {
      const bySource: Record<string, number> = {};
      let used = 0;
      for (const ext of (q.status as any)?.extensions ?? []) {
        const source = String(ext?.extensionName ?? 'other')
          .replace(/^snapshot-vmware-system-vmop.*/, 'VM snapshots')
          .replace(/^vmware-system-vmop.*/, 'VM disks')
          .replace(/.*cns.*|.*csi.*/i, 'Volumes');
        for (const u of ext?.extensionQuotaUsage ?? []) {
          const n = Number(u?.scQuotaUsage?.used ?? 0) + Number(u?.scQuotaUsage?.reserved ?? 0);
          if (Number.isFinite(n)) {
            bySource[source] = (bySource[source] ?? 0) + n;
            used += n;
          }
        }
      }
      return {
        namespace: q.metadata.namespace ?? '',
        policy: q.metadata.name.replace(/-storagepolicyquota$/, ''),
        limit: parseQuantity((q.status as any)?.appliedLimit ?? (q.spec as any)?.limit) ?? 0,
        used,
        bySource,
      };
    });
}

export function parseVolumes(pvcs: KubeObject[], vms: ServiceVm[]): VolumeInfo[] {
  const owner = new Map<string, string>();
  for (const v of vms) for (const c of v.volumes) owner.set(`${v.namespace}/${c}`, `VM ${v.name}`);
  return pvcs.map(p => {
    const key = `${p.metadata.namespace}/${p.metadata.name}`;
    const cluster = clusterOf(p);
    return {
      namespace: p.metadata.namespace ?? '',
      name: p.metadata.name,
      size: parseQuantity((p.status as any)?.capacity?.storage ?? (p.spec as any)?.resources?.requests?.storage),
      storageClass: (p.spec as any)?.storageClassName,
      phase: (p.status as any)?.phase,
      usedBy: owner.get(key) ?? (cluster ? `cluster ${cluster}` : undefined),
    };
  });
}

export function parseSupervisorNodes(nodes: KubeObject[]): SupervisorNodes {
  const ready = (n: KubeObject) => parseConditions((n.status as any)?.conditions).some(c => c.type === 'Ready' && c.status === 'True');
  const cp = nodes.filter(n => Object.keys(n.metadata.labels ?? {}).some(k => /node-role.kubernetes.io\/(control-plane|master)/.test(k)));
  const hosts = nodes.filter(n => !cp.includes(n));
  return {
    controlPlane: cp.length,
    controlPlaneReady: cp.filter(ready).length,
    hosts: hosts.length,
    hostsReady: hosts.filter(ready).length,
    version: (cp[0]?.status as any)?.nodeInfo?.kubeletVersion,
    hostVersion: (hosts[0]?.status as any)?.nodeInfo?.kubeletVersion,
  };
}

/** Where StoragePolicyQuota may be served, newest first. */
const QUOTA_APIS = ['/apis/cns.vmware.com/v1alpha2', '/apis/cns.vmware.com/v1alpha1', '/apis/storagequota.vmware.com/v1alpha2', '/apis/storagequota.vmware.com/v1alpha1'];

async function firstServedGroup(client: SupervisorClient, prefixes: string[], plural: string, namespaces: string[], namespacedOnly: boolean) {
  let last: unknown;
  for (const p of prefixes) {
    try {
      return await scopedList<KubeObject>(client, p, plural, namespaces, namespacedOnly);
    } catch (err) {
      last = err;
      if (statusOf(err) !== 404) throw err;
    }
  }
  throw last;
}

/** Reads one Supervisor's namespace inventory. Never throws. */
export async function fetchInventory(
  client: SupervisorClient,
  s: SupervisorConfig,
  namespaces: string[],
  operator: boolean,
  clusterNames: Map<string, string[]>
): Promise<Inventory> {
  const warnings: string[] = [];
  const vcfa = s.mode === 'vcfa';
  const namespacedOnly = vcfa || !operator;
  const list = async (label: string, run: () => Promise<{ items: KubeObject[] }>): Promise<KubeObject[] | undefined> => {
    try {
      return (await run()).items;
    } catch (err) {
      if (statusOf(err) !== 404) warnings.push(`${label}: ${describeError(err)}`);
      return undefined;
    }
  };
  const nsx = (plural: string) => () => scopedList<KubeObject>(client, NSX, plural, namespaces, namespacedOnly);
  const vmop = (plural: string) => () => listFirstServed(client, 'vmoperator.vmware.com', VMOP_VERSIONS, plural, namespaces, namespacedOnly);

  const fetched =
    await Promise.all([
      list('VMs', vmop('virtualmachines')),
      list('VM images', vmop('virtualmachineimages')),
      operator && !vcfa ? list('Cluster VM images', () => listFirstServed(client, 'vmoperator.vmware.com', VMOP_VERSIONS, 'clustervirtualmachineimages', [])) : Promise.resolve(undefined),
      list('VM snapshots', vmop('virtualmachinesnapshots')),
      list('Load balancers', vmop('virtualmachineservices')),
      list('Subnets', nsx('subnets')),
      list('Subnet sets', nsx('subnetsets')),
      list('Subnet ports', nsx('subnetports')),
      list('Network info', nsx('networkinfos')),
      list('Security policies', nsx('securitypolicies')),
      list('Static routes', nsx('staticroutes')),
      list('Address bindings', nsx('addressbindings')),
      list('IP allocations', nsx('ipaddressallocations')),
      list('Storage quotas', () => firstServedGroup(client, QUOTA_APIS, 'storagepolicyquotas', namespaces, namespacedOnly)),
      list('Volumes', () => scopedList<KubeObject>(client, '/api/v1', 'persistentvolumeclaims', namespaces, namespacedOnly)),
      operator && !vcfa ? list('Supervisor nodes', async () => ({ items: (await client.get<{ items?: KubeObject[] }>('/api/v1/nodes'))?.items ?? [] })) : Promise.resolve(undefined),
      operator && !vcfa ? list('NSX errors', async () => ({ items: (await client.get<{ items?: KubeObject[] }>('/apis/nsx.vmware.com/v1/nsxerrors'))?.items ?? [] })) : Promise.resolve(undefined),
    ]);
  // Operators list Supervisor-wide; keep org namespaces only (not kube-system and the like).
  const inNs = new Set(namespaces);
  const own = (xs: KubeObject[] | undefined) => (xs && inNs.size ? xs.filter(x => inNs.has(x.metadata.namespace ?? '')) : xs);
  const [vmObjs, images, cvmi, snaps, vms, subnets, sets, ports, infos, policies, routes, bindings, allocs, quotas, pvcs, nodes, nsxErrors] = [
    own(fetched[0]), own(fetched[1]), fetched[2], own(fetched[3]), own(fetched[4]), own(fetched[5]), own(fetched[6]), own(fetched[7]),
    own(fetched[8]), own(fetched[9]), own(fetched[10]), own(fetched[11]), own(fetched[12]), own(fetched[13]), own(fetched[14]), fetched[15], fetched[16],
  ];

  const imageMap = imageNames([...(images ?? []), ...(cvmi ?? [])]);
  const vmList = parseVms(s.id, vmObjs ?? [], imageMap, snaps ?? []);
  const lbs = lbsWithVmLabels(s.id, vms ?? [], vmObjs ?? [], vmList);
  const ips = ipsInUse(ports ?? [], vmList, lbs);
  const nsxObjects: NsxObjectInfo[] = [
    ...parseNsx('SecurityPolicy', policies ?? [], o => `${(o.spec?.rules ?? []).length} rules`),
    ...parseNsx('StaticRoute', routes ?? [], o => [o.spec?.network, o.spec?.nextHops?.map((h: any) => h?.ipAddress).join(', ')].filter(Boolean).join(' via ')),
    ...parseNsx('AddressBinding', bindings ?? [], o => [o.spec?.vmName, o.status?.ipAddress ?? o.spec?.ipAddressAllocationName].filter(Boolean).join(' → ')),
    ...parseNsx('IPAddressAllocation', allocs ?? [], o => [o.spec?.ipAddressBlockVisibility, (o.status?.allocationIPs ?? o.status?.cidr ?? '').toString()].filter(Boolean).join(': ')),
    ...(nsxErrors ?? []).map(e => ({ kind: 'NSXError', name: e.metadata.name, ready: false, message: String((e.spec as any)?.message ?? (e.spec as any)?.error ?? '') })),
  ];
  const networking: Inventory['networking'] = subnets || sets ? 'vpc' : 'none';
  return {
    supervisorId: s.id,
    vms: vmList,
    lbs,
    subnets: parseSubnets(s.id, subnets ?? [], sets ?? [], ips, vmList, clusterNames),
    vpcs: parseVpcs(infos ?? []),
    nsx: nsxObjects,
    quotas: parseQuotas(quotas ?? []),
    volumes: parseVolumes(pvcs ?? [], vmList),
    supervisorNodes: nodes && nodes.length ? parseSupervisorNodes(nodes) : undefined,
    networking,
    warnings,
  };
}
