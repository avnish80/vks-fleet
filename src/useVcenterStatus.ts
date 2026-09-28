import { headlampClient } from './api/headlampClient';
import { PluginConfig } from './types';
import { usePolling } from './usePolling';
import { fetchVcenterStatus, VcenterRead } from './vcenterStatus';

/** The vCenter collector's latest status, when configured (every 2 minutes). */
export function useVcenterStatus(config: PluginConfig): VcenterRead | null {
  const v = config.vcenter;
  const polled = usePolling(v ? `vcenter|${v.context}|${v.namespace}|${v.configMap}` : null, () => fetchVcenterStatus(headlampClient(v!.context), v!.namespace, v!.configMap), 120);
  return v ? polled : null;
}
