import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { normalizeConfig, PLUGIN_NAME } from '../config';
import { PluginConfig } from '../types';

/** Raw, user-edited settings. Always read through usePluginConfig() for the normalized form. */
export const settingsStore = new ConfigStore<Partial<PluginConfig>>(PLUGIN_NAME);

const useRawConfig = settingsStore.useConfig();

export function useRawSettings(): Partial<PluginConfig> {
  return useRawConfig() ?? {};
}

/** Normalized config; `supervisors` is the registry every view iterates over. */
export function usePluginConfig(): PluginConfig {
  return normalizeConfig(useRawConfig());
}
