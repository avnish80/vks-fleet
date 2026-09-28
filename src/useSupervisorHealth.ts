import { supervisorClient } from './api/headlampClient';
import { fetchSupervisorHealth, SupervisorHealth } from './supervisorHealth';
import { Inventory, SupervisorResult } from './types';
import { usePolling } from './usePolling';

/** Health of every Supervisor the signed-in account can read (every 2 minutes). */
export function useSupervisorHealth(results: SupervisorResult[] | null, inventories: Map<string, Inventory> | null, enabled: boolean): SupervisorHealth[] | null {
  const live = (results ?? []).filter(r => !r.error);
  const id = enabled && live.length ? live.map(r => r.supervisor.id).join(',') : null;
  const polled = usePolling(id, () => Promise.all(live.map(r => fetchSupervisorHealth(supervisorClient(r.supervisor), r, inventories?.get(r.supervisor.id)))), 120);
  return enabled ? polled : [];
}
