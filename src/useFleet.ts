import React from 'react';
import { supervisorClient } from './api/headlampClient';
import { fetchFleet } from './fleet';
import { SupervisorConfig, SupervisorResult } from './types';

export interface FleetState {
  results: SupervisorResult[] | null;
  refreshing: boolean;
  refresh: () => void;
}

export function useFleet(supervisors: SupervisorConfig[], refreshSeconds: number): FleetState {
  const [results, setResults] = React.useState<SupervisorResult[] | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  // Re-run only when the Supervisor list actually changes, not on every render.
  const supervisorsKey = JSON.stringify(supervisors);

  React.useEffect(() => {
    let cancelled = false;
    // Per-effect guard: a slow poll never overlaps the next one, and a stale
    // poll from before a refresh or config change is simply ignored.
    let running = false;
    const sups: SupervisorConfig[] = JSON.parse(supervisorsKey);

    const run = async () => {
      if (running) {
        return;
      }
      running = true;
      setRefreshing(true);
      try {
        const r = await fetchFleet(sups, s => supervisorClient(s));
        if (!cancelled) {
          setResults(r);
        }
      } finally {
        running = false;
        if (!cancelled) {
          setRefreshing(false);
        }
      }
    };

    run();
    const timer = window.setInterval(run, refreshSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [supervisorsKey, refreshSeconds, tick]);

  const refresh = React.useCallback(() => setTick(t => t + 1), []);
  return { results, refreshing, refresh };
}
