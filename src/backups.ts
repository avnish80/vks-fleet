/**
 * Backup status from Velero inside each signed-in cluster: schedules, recent
 * backups, the last success and the last failure.
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { BackupRecord, BackupStatus } from './types';

const VELERO = '/apis/velero.io/v1';
const OK = new Set(['Completed']);
const BAD = new Set(['Failed', 'PartiallyFailed', 'FailedValidation']);

export function backupRecord(b: any): BackupRecord {
  return {
    name: b?.metadata?.name ?? '',
    phase: b?.status?.phase ?? 'Unknown',
    started: b?.status?.startTimestamp,
    completed: b?.status?.completionTimestamp,
    schedule: b?.metadata?.labels?.['velero.io/schedule-name'],
    errors: b?.status?.errors,
    warnings: b?.status?.warnings,
  };
}

export function summarizeBackups(
  clusterKey: string,
  contextName: string,
  backups: any[],
  schedules: any[]
): BackupStatus {
  const recent = backups
    .map(backupRecord)
    .sort((a, b) => (b.completed ?? b.started ?? '').localeCompare(a.completed ?? a.started ?? ''));
  return {
    clusterKey,
    contextName,
    schedules: schedules.map(s => ({
      name: s?.metadata?.name ?? '',
      schedule: s?.spec?.schedule ?? '',
      lastBackup: s?.status?.lastBackup,
      paused: s?.spec?.paused === true,
    })),
    recent: recent.slice(0, 10),
    lastSuccess: recent.find(r => OK.has(r.phase)),
    lastFailure: recent.find(r => BAD.has(r.phase)),
  };
}

export async function fetchBackups(client: SupervisorClient, clusterKey: string, contextName: string): Promise<BackupStatus> {
  const [b, s] = await Promise.allSettled([client.get<any>(`${VELERO}/backups`), client.get<any>(`${VELERO}/schedules`)]);
  if (b.status === 'rejected') {
    const missing = statusOf(b.reason) === 404;
    return { clusterKey, contextName, missing, error: missing ? undefined : describeError(b.reason), schedules: [], recent: [] };
  }
  return summarizeBackups(clusterKey, contextName, b.value?.items ?? [], s.status === 'fulfilled' ? s.value?.items ?? [] : []);
}

/** Hours since the last successful backup, if any. */
export function hoursSinceSuccess(b: BackupStatus | undefined, now: Date): number | undefined {
  const t = b?.lastSuccess?.completed;
  return t ? (now.getTime() - new Date(t).getTime()) / 3600000 : undefined;
}
