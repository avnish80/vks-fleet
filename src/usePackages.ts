import { headlampClient } from './api/headlampClient';
import { ClusterPackages, fetchClusterPackages } from './packages';
import { usePolling } from './usePolling';

export interface PackageTarget {
  key: string;
  contextName: string;
}

/**
 * Package inventory for every signed-in cluster. Refreshed every few minutes:
 * packages change rarely, and the repository listing can be large.
 */
export function usePackages(targets: PackageTarget[], seconds = 180): Map<string, ClusterPackages> | null {
  const id = targets.length ? JSON.stringify(targets.map(t => [t.key, t.contextName])) : null;
  const all = usePolling(
    id,
    async () => {
      const list = await Promise.all(targets.map(t => fetchClusterPackages(headlampClient(t.contextName), t.key, t.contextName)));
      return new Map(list.map(p => [p.clusterKey, p]));
    },
    seconds
  );
  return all;
}
