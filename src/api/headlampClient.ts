import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { HeadlampClusterInfo, parseHeadlampConfig } from '../contexts';
import { SupervisorConfig } from '../types';
import { contextFor } from '../vcfa';
import { demoClient, demoClusterList, demoModeOn, demoWriter, isDemoContext } from '../demo';
import { SupervisorClient, SupervisorWriter, WriteRequest } from './client';
import { limited } from './limiter';
import { rememberingGet } from './served';
import { changeContext, current, stamp } from '../elevation';

/**
 * SupervisorClient backed by Headlamp's API proxy, targeting one Headlamp
 * cluster by name regardless of which cluster the user currently has open.
 * Used for Supervisors and, through their contexts, for workload clusters.
 *
 * This is the only file that calls ApiProxy. If the request signature changes
 * between Headlamp releases, fix it here.
 */
export function headlampClient(headlampCluster: string): SupervisorClient {
  if (isDemoContext(headlampCluster)) return demoClient(headlampCluster);
  return {
    name: headlampCluster,
    get<T>(path: string): Promise<T> {
      // Third argument: autoLogoutOnAuthError. Keep it false so an expired
      // token shows as an error in this view instead of logging the user out
      // of whatever cluster they are looking at.
      return rememberingGet(headlampCluster, path, () => limited(headlampCluster, () => ApiProxy.request(path, { cluster: headlampCluster }, false) as Promise<T>));
    },
  };
}

/**
 * The clusters (kubeconfig contexts) Headlamp knows about, with their API
 * servers, from Headlamp's own /config endpoint. Returns [] if unavailable.
 */
export async function listHeadlampClusters(): Promise<HeadlampClusterInfo[]> {
  if (demoModeOn()) return demoClusterList();
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
/**
 * asViewer: for requests that change nothing (access reviews), which always go
 * through the read sign-in, whether or not elevation is on or active.
 */
export function headlampWriter(headlampCluster: string, opts: { asViewer?: boolean } = {}): SupervisorWriter {
  if (isDemoContext(headlampCluster)) return demoWriter(headlampCluster);
  return {
    send(original: WriteRequest, dryRun: boolean): Promise<unknown> {
      // Read by default, elevate to change: while elevated, changes go to the admin context and are stamped.
      const { context, elevated } = opts.asViewer ? { context: headlampCluster, elevated: false } : changeContext(headlampCluster);
      const req = elevated ? stamp(original, current()) : original;
      const params: Record<string, unknown> = {
        method: req.method,
        cluster: context,
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
    name: s.headlampCluster,
    get<T>(path: string): Promise<T> {
      return headlampClient(contextFor(s, path)).get<T>(path);
    },
  };
}

export function supervisorWriter(s: SupervisorConfig, opts: { asViewer?: boolean } = {}): SupervisorWriter {
  return {
    send(req: WriteRequest, dryRun: boolean): Promise<unknown> {
      return headlampWriter(contextFor(s, req.path), opts).send(req, dryRun);
    },
  };
}
