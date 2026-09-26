import { PluginConfig } from '../types';

/** The browser's own settings win; with none, the administrator's preset (config.json) is used. */
export function effectiveSettings(
  raw: Partial<PluginConfig> | undefined,
  managed: Partial<PluginConfig> | null
): Partial<PluginConfig> | undefined {
  const own = (raw?.supervisors ?? []).some(s => s?.headlampCluster);
  if (!managed) return raw;
  const merged = own
    ? { ...raw, baseline: raw?.baseline ?? managed.baseline, links: raw?.links ?? managed.links }
    : { ...managed, refreshSeconds: raw?.refreshSeconds ?? managed.refreshSeconds, baseline: raw?.baseline ?? managed.baseline };
  // Guardrails an administrator sets can't be undone from a browser.
  if (managed.readOnly === true) merged.readOnly = true;
  if (managed.identitySwitch === false) merged.identitySwitch = false;
  // Silences an administrator ships apply alongside the browser's own.
  if (managed.silences?.length) merged.silences = [...(managed.silences ?? []), ...((merged.silences ?? []).filter(s => !managed.silences!.some(m => m.id === s.id)))];
  return merged;
}
