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

/** Headlamp's pod list on a cluster, filtered to one namespace (logs are one click from there). */
export function headlampPodsPath(contextName: string, namespace: string): string {
  return `/c/${encodeURIComponent(contextName)}/pods?namespace=${encodeURIComponent(namespace)}`;
}

/** Headlamp's own page for the CAPI Cluster object on the Supervisor (view and edit YAML). */
export function headlampClusterObjectPath(contextName: string, namespace: string, name: string): string {
  return `/c/${encodeURIComponent(contextName)}/customresources/clusters.cluster.x-k8s.io/${encodeURIComponent(
    namespace
  )}/${encodeURIComponent(name)}`;
}

export const MACHINE_PATH = '/vks-fleet/clusters/:supervisor/:namespace/:name/machines/:machine';

export function machinePath(
  c: { supervisorId: string; namespace: string; name: string },
  machineName: string
): string {
  return `${clusterPath(c)}/machines/${machineName}`;
}

export function headlampNodePath(contextName: string, nodeName: string): string {
  return `/c/${encodeURIComponent(contextName)}/nodes/${encodeURIComponent(nodeName)}`;
}

export function headlampPodPath(contextName: string, namespace: string, name: string): string {
  return `/c/${encodeURIComponent(contextName)}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
}
