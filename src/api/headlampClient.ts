import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { HeadlampClusterInfo, parseHeadlampConfig } from '../contexts';
import { SupervisorClient, SupervisorWriter, WriteRequest } from './client';

/**
 * SupervisorClient backed by Headlamp's API proxy, targeting one Headlamp
 * cluster by name regardless of which cluster the user currently has open.
 * Used for Supervisors and, through their contexts, for workload clusters.
 *
 * This is the only file that calls ApiProxy. If the request signature changes
 * between Headlamp releases, fix it here.
 */
export function headlampClient(headlampCluster: string): SupervisorClient {
  return {
    get<T>(path: string): Promise<T> {
      // Third argument: autoLogoutOnAuthError. Keep it false so an expired
      // token shows as an error in this view instead of logging the user out
      // of whatever cluster they are looking at.
      return ApiProxy.request(path, { cluster: headlampCluster }, false) as Promise<T>;
    },
  };
}

/**
 * The clusters (kubeconfig contexts) Headlamp knows about, with their API
 * servers, from Headlamp's own /config endpoint. Returns [] if unavailable.
 */
export async function listHeadlampClusters(): Promise<HeadlampClusterInfo[]> {
  try {
    // Fourth argument: useCluster = false, i.e. a Headlamp backend path, not a cluster API path.
    const config = await ApiProxy.request('/config', {}, false, false);
    return parseHeadlampConfig(config);
  } catch {
    return [];
  }
}

function withDryRun(path: string, dryRun: boolean): string {
  if (!dryRun) return path;
  return `${path}${path.includes('?') ? '&' : '?'}dryRun=All`;
}

/**
 * Writes to one Headlamp cluster with the signed-in user's own credentials,
 * so the Supervisor's RBAC decides what's allowed.
 */
export function headlampWriter(headlampCluster: string): SupervisorWriter {
  return {
    send(req: WriteRequest, dryRun: boolean): Promise<unknown> {
      const params: Record<string, unknown> = {
        method: req.method,
        cluster: headlampCluster,
        headers: {
          Accept: 'application/json',
          'Content-Type': req.contentType ?? 'application/json',
        },
      };
      if (req.body !== undefined) params.body = JSON.stringify(req.body);
      return ApiProxy.request(withDryRun(req.path, dryRun), params, false);
    },
  };
}
