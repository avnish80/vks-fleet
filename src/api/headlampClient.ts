import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import { SupervisorClient } from './client';

/**
 * SupervisorClient backed by Headlamp's API proxy, targeting one Headlamp
 * cluster by name regardless of which cluster the user currently has open.
 *
 * This is the only file that calls ApiProxy. If the request signature changes
 * between Headlamp releases, fix it here.
 */
export function headlampClient(headlampCluster: string): SupervisorClient {
  return {
    get<T>(path: string): Promise<T> {
      // Third argument: autoLogoutOnAuthError. Keep it false so an expired
      // Supervisor token shows as an error in this view instead of logging the
      // user out of whatever cluster they are looking at.
      return ApiProxy.request(path, { cluster: headlampCluster }, false) as Promise<T>;
    },
  };
}
