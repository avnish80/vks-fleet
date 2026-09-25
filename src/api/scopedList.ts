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
  namespaces: string[],
  namespacedOnly = false
): Promise<ListResult<T>> {
  if (!namespacedOnly) {
    try {
      const list = await client.get<{ items?: T[] }>(`${apiPrefix}/${plural}`);
      return { items: list?.items ?? [], scope: 'cluster', readableNamespaces: [], warnings: [] };
    } catch (err) {
      // 403: not allowed across namespaces. 404 with namespaces to fall back on:
      // a namespace-scoped endpoint (e.g. VCF Automation's proxy) that has no
      // cluster-wide path at all.
      const status = statusOf(err);
      if (status !== 403 && !(status === 404 && namespaces.length)) {
        throw err;
      }
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
    const reasons = settled.map(r => (r.status === 'rejected' ? r.reason : undefined));
    // Every namespace says "not found": the resource isn't served here (e.g. that API version).
    if (reasons.every(r => statusOf(r) === 404)) throw reasons[0];
    throw new Error(`Couldn't list ${plural} in any configured namespace. ${warnings[0]}`);
  }
  return { items, scope: 'namespaced', readableNamespaces, warnings };
}
