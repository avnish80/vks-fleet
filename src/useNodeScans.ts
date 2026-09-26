import { headlampClient } from './api/headlampClient';
import { NodeScanRun, readRuns, RESULTS_CM, SCAN_NS } from './nodeScan';
import { usePolling } from './usePolling';

/** Saved kube-bench runs per signed-in cluster (from the results ConfigMap in each cluster). */
export function useNodeScans(targets: Array<{ key: string; contextName: string }>, version: number): Map<string, NodeScanRun[]> {
  const id = targets.length ? JSON.stringify([targets.map(t => [t.key, t.contextName]), version]) : null;
  const polled = usePolling(
    id,
    async () =>
      new Map(
        await Promise.all(
          targets.map(async t => {
            try {
              return [t.key, readRuns(await headlampClient(t.contextName).get(`/api/v1/namespaces/${SCAN_NS}/configmaps/${RESULTS_CM}`))] as [string, NodeScanRun[]];
            } catch {
              // Never scanned (404) or not readable: no runs to show.
              return [t.key, []] as [string, NodeScanRun[]];
            }
          })
        )
      ),
    300
  );
  return polled ?? new Map();
}
