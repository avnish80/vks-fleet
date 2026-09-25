import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { normalizeConfig, PLUGIN_NAME } from '../config';
import { PluginConfig } from '../types';
import { useManagedConfig } from './managed';

/** Raw, user-edited settings. Always read through usePluginConfig() for the normalized form. */
export const settingsStore = new ConfigStore<Partial<PluginConfig>>(PLUGIN_NAME);

const useRawConfig = settingsStore.useConfig();

export function useRawSettings(): Partial<PluginConfig> {
  return useRawConfig() ?? {};
}

/** The browser's own settings win; with none, the administrator's preset (config.json) is used. */
export function effectiveSettings(
  raw: Partial<PluginConfig> | undefined,
  managed: Partial<PluginConfig> | null
): Partial<PluginConfig> | undefined {
  const own = (raw?.supervisors ?? []).some(s => s?.headlampCluster);
  if (!managed) return raw;
  if (own) return { ...raw, baseline: raw?.baseline ?? managed.baseline };
  return { ...managed, refreshSeconds: raw?.refreshSeconds ?? managed.refreshSeconds, baseline: raw?.baseline ?? managed.baseline };
}

/** Normalized config; `supervisors` is the registry every view iterates over. */
export function usePluginConfig(): PluginConfig {
  const raw = useRawConfig();
  const managed = useManagedConfig();
  return normalizeConfig(effectiveSettings(raw, managed));
}
