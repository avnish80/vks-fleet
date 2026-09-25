import { ListScope } from '../types';
import { describeError, statusOf, SupervisorClient } from './client';

export interface ListResult<T> {
  items: T[];
  scope: ListScope;
  /** For namespaced lists: the namespaces that were readable. */
  readableNamespaces: string[];
  warnings: string[];
}

/**
 * Lists a namespaced resource the way the caller's identity allows:
 *  - an operator with cluster-wide read gets one cluster-wide list;
 *  - a tenant user gets 403 there, so we list each configured namespace.
 * The UI never decides scope; the Supervisor's RBAC does.
 *
 * @param apiPrefix e.g. "/apis/cluster.x-k8s.io/v1beta1"
 * @param plural    e.g. "clusters"
 */
export async function scopedList<T>(
  client: SupervisorClient,
  apiPrefix: string,
  plural: string,
  namespaces: string[]
): Promise<ListResult<T>> {
  try {
    const list = await client.get<{ items?: T[] }>(`${apiPrefix}/${plural}`);
    return { items: list?.items ?? [], scope: 'cluster', readableNamespaces: [], warnings: [] };
  } catch (err) {
    if (statusOf(err) !== 403) {
      throw err;
    }
  }

  if (namespaces.length === 0) {
    throw new Error(
      `You don't have access to list ${plural} across all namespaces. ` +
        'Add the Supervisor namespaces you can access in the plugin settings.'
    );
  }

  const settled = await Promise.allSettled(
    namespaces.map(ns =>
      client.get<{ items?: T[] }>(`${apiPrefix}/namespaces/${encodeURIComponent(ns)}/${plural}`)
    )
  );

  const items: T[] = [];
  const warnings: string[] = [];
  const readableNamespaces: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      items.push(...(result.value?.items ?? []));
      readableNamespaces.push(namespaces[i]);
    } else {
      warnings.push(`Couldn't list ${plural} in namespace ${namespaces[i]}: ${describeError(result.reason)}`);
    }
  });

  if (warnings.length === namespaces.length) {
    throw new Error(`Couldn't list ${plural} in any configured namespace. ${warnings[0]}`);
  }
  return { items, scope: 'namespaced', readableNamespaces, warnings };
}
