import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { HeadlampClusterInfo, parseHeadlampConfig } from '../contexts';
import { SupervisorConfig } from '../types';
import { contextFor } from '../vcfa';
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

function withParam(path: string, param: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${param}`;
}

function withDryRun(path: string, dryRun: boolean): string {
  return dryRun ? withParam(path, 'dryRun=All') : path;
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
      const path = req.method === 'PATCH' ? withParam(req.path, 'fieldManager=vks-fleet') : req.path;
      return ApiProxy.request(withDryRun(path, dryRun), params, false);
    },
  };
}

/**
 * Client for one Supervisor entry. For VCFA tenants each namespace has its
 * own context, so every request goes to the context serving its namespace.
 */
export function supervisorClient(s: SupervisorConfig): SupervisorClient {
  return {
    get<T>(path: string): Promise<T> {
      return headlampClient(contextFor(s, path)).get<T>(path);
    },
  };
}

export function supervisorWriter(s: SupervisorConfig): SupervisorWriter {
  return {
    send(req: WriteRequest, dryRun: boolean): Promise<unknown> {
      return headlampWriter(contextFor(s, req.path)).send(req, dryRun);
    },
  };
}
