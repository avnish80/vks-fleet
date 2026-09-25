import React from 'react';
import { PLUGIN_NAME } from '../config';
import { PluginConfig } from '../types';

/**
 * Settings an administrator ships next to the plugin (config.json in the
 * plugin folder, e.g. from a ConfigMap in an in-cluster deployment). Used
 * when a browser has no settings of its own, so every operator starts with
 * the same Supervisors and tenant names.
 */
let cached: Promise<Partial<PluginConfig> | null> | null = null;

export function managedConfigUrls(): string[] {
  return [`/plugins/${PLUGIN_NAME}/config.json`, `plugins/${PLUGIN_NAME}/config.json`];
}

export function parseManaged(data: unknown): Partial<PluginConfig> | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<PluginConfig>;
  return Array.isArray(d.supervisors) && d.supervisors.length ? d : null;
}

export function loadManagedConfig(): Promise<Partial<PluginConfig> | null> {
  if (!cached) {
    cached = (async () => {
      for (const url of managedConfigUrls()) {
        try {
          const res = await window.fetch(url, { cache: 'no-store' });
          if (!res.ok) continue;
          const parsed = parseManaged(await res.json());
          if (parsed) return parsed;
        } catch {
          // Not served here (desktop app, or no config.json): try the next form.
        }
      }
      return null;
    })();
  }
  return cached;
}

export function useManagedConfig(): Partial<PluginConfig> | null {
  const [managed, setManaged] = React.useState<Partial<PluginConfig> | null>(null);
  React.useEffect(() => {
    let alive = true;
    loadManagedConfig().then(m => alive && setManaged(m));
    return () => {
      alive = false;
    };
  }, []);
  return managed;
}
