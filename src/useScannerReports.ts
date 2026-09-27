import { headlampClient } from './api/headlampClient';
import { fetchScannerReports, ScannerReports } from './scanners';
import { usePolling } from './usePolling';

/** Trivy Operator and policy reports from every signed-in cluster (every 10 minutes: they change slowly and can be large). */
export function useScannerReports(targets: Array<{ key: string; name: string; contextName: string }>, seconds = 600): ScannerReports[] | null {
  const id = targets.length ? JSON.stringify(targets.map(t => [t.key, t.contextName])) : null;
  const polled = usePolling(id, () => Promise.all(targets.map(t => fetchScannerReports(headlampClient(t.contextName), t.key, t.name, t.contextName))), seconds);
  return targets.length ? polled : [];
}
