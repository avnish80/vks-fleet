/**
 * Extra Supervisor-side detail for one cluster, fetched only on its detail
 * page: add-ons from the ClusterBootstrap, recent events, and the raw object.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { eventTime, toEventInfo } from './workload';
import { EventInfo } from './types';

export interface AddonInfo {
  role: string;
  name: string;
}

export interface ClusterExtras {
  addons: AddonInfo[];
  events: EventInfo[];
  raw?: unknown;
  warnings: string[];
}

const EVENT_CAP = 30;

export function addonsFromBootstrap(cb: any): AddonInfo[] {
  const spec = cb?.spec ?? {};
  const out: AddonInfo[] = [];
  const add = (role: string, pkg: any) => {
    const name = pkg?.refName;
    if (typeof name === 'string' && name) out.push({ role, name });
  };
  add('Networking (CNI)', spec.cni);
  add('Storage (CSI)', spec.csi);
  add('Cloud provider (CPI)', spec.cpi);
  add('Package controller', spec.kapp);
  for (const p of Array.isArray(spec.additionalPackages) ? spec.additionalPackages : []) add('Additional', p);
  return out;
}

/** Events about the cluster or the objects named after it (machines, node pools, VMs). */
export function clusterEvents(events: any[], clusterName: string): EventInfo[] {
  return events
    .filter(e => {
      const n: string = e?.involvedObject?.name ?? e?.regarding?.name ?? '';
      return n === clusterName || n.startsWith(`${clusterName}-`);
    })
    .sort((a, b) => (eventTime(b) ?? '').localeCompare(eventTime(a) ?? ''))
    .slice(0, EVENT_CAP)
    .map(toEventInfo);
}

export async function fetchClusterExtras(
  client: SupervisorClient,
  namespace: string,
  name: string
): Promise<ClusterExtras> {
  const ns = encodeURIComponent(namespace);
  const n = encodeURIComponent(name);
  const [raw, cb, ev] = await Promise.allSettled([
    client.get<any>(`/apis/cluster.x-k8s.io/v1beta1/namespaces/${ns}/clusters/${n}`),
    client.get<any>(`/apis/run.tanzu.vmware.com/v1alpha3/namespaces/${ns}/clusterbootstraps/${n}`),
    client.get<any>(`/api/v1/namespaces/${ns}/events`),
  ]);

  const warnings: string[] = [];
  const result: ClusterExtras = { addons: [], events: [], warnings };

  if (raw.status === 'fulfilled' && raw.value) {
    const copy = JSON.parse(JSON.stringify(raw.value));
    if (copy?.metadata) delete copy.metadata.managedFields;
    result.raw = copy;
  } else if (raw.status === 'rejected') {
    warnings.push(`Raw object unavailable: ${describeError(raw.reason)}`);
  }

  if (cb.status === 'fulfilled') {
    result.addons = addonsFromBootstrap(cb.value);
  } else if (statusOf(cb.reason) !== 404) {
    warnings.push(`Add-ons unavailable: ${describeError(cb.reason)}`);
  }

  if (ev.status === 'fulfilled') {
    result.events = clusterEvents(ev.value?.items ?? [], name);
  } else {
    warnings.push(`Supervisor events unavailable: ${describeError(ev.reason)}`);
  }
  return result;
}
