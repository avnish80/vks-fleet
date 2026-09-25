export const FLEET_PATH = '/vks-fleet';
export const CLUSTER_PATH = '/vks-fleet/clusters/:supervisor/:namespace/:name';

/** Every link to a cluster carries Supervisor + namespace + name, never the name alone. */
export function clusterPath(c: { supervisorId: string; namespace: string; name: string }): string {
  return `/vks-fleet/clusters/${c.supervisorId}/${c.namespace}/${c.name}`;
}

/** Headlamp's own view of a cluster (kubeconfig context). */
export function headlampClusterPath(contextName: string): string {
  return `/c/${encodeURIComponent(contextName)}`;
}
