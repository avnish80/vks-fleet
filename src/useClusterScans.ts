import { headlampClient, headlampWriter } from './api/headlampClient';
import { ClusterScan, fetchClusterScan } from './clusterScan';
import { alignToBenchmark, cisBenchmark } from './benchmark';
import { useFleetData } from './fleetContext';
import React from 'react';
import { usePolling } from './usePolling';

export interface ScanTarget {
  key: string;
  name: string;
  contextName: string;
}

/** Applications, security posture and GitOps for every signed-in cluster, every few minutes. */
export function useClusterScans(targets: ScanTarget[], allowedRegistries: string[], seconds = 300): ClusterScan[] | null {
  const id = targets.length ? JSON.stringify([targets.map(t => [t.key, t.contextName]), allowedRegistries]) : null;
  const polled = usePolling(
    id,
    () =>
      Promise.all(
        targets.map(t => fetchClusterScan(headlampClient(t.contextName), t.key, t.name, t.contextName, allowedRegistries, new Date(), headlampWriter(t.contextName)))
      ),
    seconds
  );
  // Each cluster is measured against the CIS benchmark written for its Kubernetes version.
  const { all } = useFleetData();
  const versions = React.useMemo(() => new Map((all ?? []).flatMap(r => r.clusters).map(c => [c.key, c.kubernetesVersion])), [all]);
  const aligned = React.useMemo(
    () =>
      polled?.map(s => {
        const b = cisBenchmark(versions.get(s.clusterKey));
        return { ...s, compliance: alignToBenchmark(s.compliance, b), benchmark: b.version, benchmarkBeyond: b.beyond };
      }) ?? null,
    [polled, versions]
  );
  return targets.length ? aligned : [];
}
