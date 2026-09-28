import { headlampClient } from './api/headlampClient';
import { fetchSummary, ObservabilitySummary } from './observability';
import { usePolling } from './usePolling';

/** Monitoring stack, headline numbers, forecasts and alerts per signed-in cluster (every 5 minutes). */
export function useObservability(targets: Array<{ key: string; name: string; contextName: string }>, seconds = 300): ObservabilitySummary[] | null {
  const id = targets.length ? JSON.stringify(targets.map(t => [t.key, t.contextName])) : null;
  const polled = usePolling(id, () => Promise.all(targets.map(t => fetchSummary(headlampClient(t.contextName), t.key, t.name, t.contextName))), seconds);
  return targets.length ? polled : [];
}
