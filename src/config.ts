import { PluginConfig, SupervisorConfig } from './types';

export const PLUGIN_NAME = 'vks-fleet';
export const DEFAULT_REFRESH_SECONDS = 30;
export const MIN_REFRESH_SECONDS = 10;

const DNS_LABELISH = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export function isValidSupervisorId(id: string): boolean {
  return DNS_LABELISH.test(id) && id.length <= 63;
}

export function parseNamespaces(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean)
    )
  );
}

function normalizeSupervisor(raw: Partial<SupervisorConfig>): SupervisorConfig | null {
  const headlampCluster = (raw.headlampCluster ?? '').trim();
  if (!headlampCluster) {
    return null;
  }
  const id = (raw.id ?? '').trim() || headlampCluster.toLowerCase();
  if (!isValidSupervisorId(id)) {
    return null;
  }
  return {
    id,
    headlampCluster,
    displayName: raw.displayName?.trim() || undefined,
    namespaces: Array.isArray(raw.namespaces) ? parseNamespaces(raw.namespaces.join(',')) : [],
    tenantLabelKey: (raw.tenantLabelKey ?? '').trim(),
  };
}

/**
 * Turns whatever is in the settings store into a usable config.
 * This is the Supervisor registry: phase 1 stores one entry, phase 2 many.
 * Invalid entries are dropped and duplicate ids keep the first entry, so
 * cluster keys stay unique.
 */
export function normalizeConfig(raw: Partial<PluginConfig> | undefined | null): PluginConfig {
  const seen = new Set<string>();
  const supervisors: SupervisorConfig[] = [];
  for (const entry of raw?.supervisors ?? []) {
    const s = normalizeSupervisor(entry ?? {});
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      supervisors.push(s);
    }
  }
  const refresh = Number(raw?.refreshSeconds);
  return {
    supervisors,
    refreshSeconds:
      Number.isFinite(refresh) && refresh >= MIN_REFRESH_SECONDS ? refresh : DEFAULT_REFRESH_SECONDS,
  };
}
