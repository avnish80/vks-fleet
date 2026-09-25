import React from 'react';
import { headlampClient, listHeadlampClusters } from './api/headlampClient';
import { HeadlampClusterInfo, matchContexts } from './contexts';
import { FleetCluster, WorkloadHealth } from './types';
import { fetchWorkloadHealth, noContextHealth } from './workload';

export interface WorkloadState {
  /** Fleet cluster key → health. Missing while the first check is running. */
  byKey: Map<string, WorkloadHealth>;
  /** Everything Headlamp knows about, for building login hints. */
  contexts: HeadlampClusterInfo[];
}

/**
 * Checks inside each workload cluster that has a matching Headlamp context.
 * Runs at half the fleet refresh rate to keep the fan-out light.
 */
export function useWorkloadHealth(clusters: FleetCluster[], refreshSeconds: number): WorkloadState {
  const [state, setState] = React.useState<WorkloadState>({ byKey: new Map(), contexts: [] });

  // Only re-subscribe when the set of clusters or their endpoints change.
  const identity = JSON.stringify(clusters.map(c => [c.key, c.name, c.endpoint?.host, c.endpoint?.port]));

  React.useEffect(() => {
    let cancelled = false;
    let running = false;
    const targets: Pick<FleetCluster, 'key' | 'name' | 'endpoint'>[] = JSON.parse(identity).map(
      ([key, name, host, port]: [string, string, string | undefined, number | undefined]) => ({
        key,
        name,
        endpoint: host ? { host, port: port ?? 6443 } : undefined,
      })
    );

    const run = async () => {
      if (running || targets.length === 0) return;
      running = true;
      try {
        const contexts = await listHeadlampClusters();
        const matched = matchContexts(targets, contexts);
        const now = new Date();
        const entries = await Promise.all(
          targets.map(async t => {
            const ctx = matched.get(t.key);
            const health = ctx ? await fetchWorkloadHealth(headlampClient(ctx), ctx, now) : noContextHealth();
            return [t.key, health] as [string, WorkloadHealth];
          })
        );
        if (!cancelled) setState({ byKey: new Map(entries), contexts });
      } finally {
        running = false;
      }
    };

    run();
    const timer = window.setInterval(run, refreshSeconds * 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [identity, refreshSeconds]);

  return state;
}
