import React from 'react';
import { headlampClient } from './api/headlampClient';
import { ClusterExtras, fetchClusterExtras } from './extras';
import { SupervisorConfig } from './types';

export function useClusterExtras(
  supervisor: SupervisorConfig | undefined,
  namespace: string,
  name: string,
  refreshSeconds: number
): ClusterExtras | null {
  const [extras, setExtras] = React.useState<ClusterExtras | null>(null);
  const target = supervisor?.headlampCluster;

  React.useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const run = async () => {
      const e = await fetchClusterExtras(headlampClient(target), namespace, name);
      if (!cancelled) setExtras(e);
    };
    run();
    const timer = window.setInterval(run, refreshSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [target, namespace, name, refreshSeconds]);

  return extras;
}
