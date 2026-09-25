import { headlampClient } from './api/headlampClient';
import { fetchBackups } from './backups';
import { BackupStatus } from './types';
import { usePolling } from './usePolling';

/** Backup status for every signed-in cluster, every few minutes. */
export function useBackups(targets: Array<{ key: string; contextName: string }>, seconds = 300): Map<string, BackupStatus> | null {
  const id = targets.length ? JSON.stringify(targets.map(t => [t.key, t.contextName])) : null;
  return usePolling(
    id,
    async () => {
      const list = await Promise.all(targets.map(t => fetchBackups(headlampClient(t.contextName), t.key, t.contextName)));
      return new Map(list.map(b => [b.clusterKey, b]));
    },
    seconds
  );
}
