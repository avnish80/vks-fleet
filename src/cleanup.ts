/**
 * Cleanup: leftovers on the Supervisor that belong to clusters that no longer
 * exist (node VMs, load balancer services, volume claims), volume claims that
 * are lost or stuck, and clusters stuck deleting. Only objects that name
 * their cluster (labels or owners) are judged, so VM Service VMs and other
 * standalone objects are never reported. Nothing is deleted by the plugin;
 * each item comes with commands to inspect and remove it.
 */
import { KubeObject } from './capi/v1beta1';
import { formatDuration } from './capi/v1beta1';
import { CleanupItem } from './types';

const CLUSTER_LABELS = [
  'cluster.x-k8s.io/cluster-name',
  'capv.vmware.com/cluster.name',
  'capw.vmware.com/cluster.name',
  'run.tanzu.vmware.com/cluster.name',
  'vmware-system-cluster-name',
];

export const STALE_PVC_MS = 60 * 60 * 1000;
export const STUCK_DELETE_MS = 60 * 60 * 1000;

/** The cluster an object says it belongs to, if any. */
export function owningCluster(o: KubeObject): string | undefined {
  const labels = o.metadata.labels ?? {};
  for (const k of CLUSTER_LABELS) if (labels[k]) return labels[k];
  const owner = ((o.metadata as any).ownerReferences ?? []).find((r: any) => r?.kind === 'Cluster');
  return owner?.name;
}

export function findLeftovers(
  supervisorId: string,
  context: string,
  clusters: KubeObject[],
  vms: KubeObject[],
  vmServices: KubeObject[],
  pvcs: KubeObject[],
  now: Date
): CleanupItem[] {
  const existing = new Set(clusters.map(c => `${c.metadata.namespace}/${c.metadata.name}`));
  const s = `kubectl --context ${context}`;
  const items: CleanupItem[] = [];
  const orphan = (kind: CleanupItem['kind'], resource: string, o: KubeObject) => {
    const cluster = owningCluster(o);
    const ns = o.metadata.namespace ?? '';
    if (!cluster || existing.has(`${ns}/${cluster}`)) return;
    items.push({
      supervisorId,
      namespace: ns,
      kind,
      name: o.metadata.name,
      reason: `Belongs to cluster ${cluster}, which no longer exists.`,
      inspect: `${s} get ${resource} -n ${ns} ${o.metadata.name} -o yaml | head -40`,
      remove: `${s} delete ${resource} -n ${ns} ${o.metadata.name}`,
      since: o.metadata.creationTimestamp,
    });
  };
  vms.forEach(v => orphan('VirtualMachine', 'virtualmachine', v));
  vmServices.forEach(v => orphan('VirtualMachineService', 'virtualmachineservice', v));

  for (const p of pvcs) {
    const ns = p.metadata.namespace ?? '';
    const phase = p.status?.phase;
    const age = p.metadata.creationTimestamp ? now.getTime() - new Date(p.metadata.creationTimestamp).getTime() : 0;
    const cluster = owningCluster(p);
    if (cluster && !existing.has(`${ns}/${cluster}`)) {
      orphan('PersistentVolumeClaim', 'pvc', p);
    } else if (phase === 'Lost' || (phase === 'Pending' && age > STALE_PVC_MS)) {
      items.push({
        supervisorId,
        namespace: ns,
        kind: 'PersistentVolumeClaim',
        name: p.metadata.name,
        reason: phase === 'Lost' ? 'Its volume is gone (Lost).' : `Pending for ${formatDuration(age)}.`,
        inspect: `${s} describe pvc -n ${ns} ${p.metadata.name} | tail -15`,
        remove: `${s} delete pvc -n ${ns} ${p.metadata.name}`,
        since: p.metadata.creationTimestamp,
      });
    }
  }

  for (const c of clusters) {
    const del = c.metadata.deletionTimestamp;
    if (!del) continue;
    const age = now.getTime() - new Date(del).getTime();
    if (age < STUCK_DELETE_MS) continue;
    const ns = c.metadata.namespace ?? '';
    items.push({
      supervisorId,
      namespace: ns,
      kind: 'Cluster',
      name: c.metadata.name,
      reason: `Deleting for ${formatDuration(age)}; something is holding its finalizers.`,
      inspect: `${s} get cluster -n ${ns} ${c.metadata.name} -o jsonpath='{.metadata.finalizers}{"\\n"}{.status.conditions}{"\\n"}' && ${s} get machines,vm -n ${ns} | grep ${c.metadata.name}`,
      since: del,
    });
  }
  return items.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}
