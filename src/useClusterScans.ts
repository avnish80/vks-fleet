import { headlampClient } from './api/headlampClient';
import { ClusterScan, fetchClusterScan } from './clusterScan';
import { usePolling } from './usePolling';

export interface ScanTarget {
  key: string;
  name: string;
  contextName: string;
}

/** Applications, security posture and GitOps for every signed-in cluster, every few minutes. */
export function useClusterScans(targets: ScanTarget[], allowedRegistries: string[], seconds = 300): ClusterScan[] | null {
  const id = targets.length ? JSON.stringify([targets.map(t => [t.key, t.contextName]), allowedRegistries]) : null;
  return usePolling(
    id,
    () => Promise.all(targets.map(t => fetchClusterScan(headlampClient(t.contextName), t.key, t.name, t.contextName, allowedRegistries))),
    seconds
  );
}
