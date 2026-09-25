/**
 * Connects fleet rows to Headlamp clusters (kubeconfig contexts), so a VKS
 * cluster can be opened in Headlamp's own views and its insides checked.
 *
 * Matching is by API endpoint, not by name: cluster names can repeat across
 * namespaces and Supervisors, and context names are whatever the login tool
 * chose. The context carries the user's own credentials, so what they can see
 * inside the cluster is still decided by their RBAC.
 */
import { FleetCluster } from './types';

export interface HeadlampClusterInfo {
  name: string;
  server?: string;
}

/** Reads the cluster list out of Headlamp's /config response. Tolerant of shape changes. */
export function parseHeadlampConfig(data: unknown): HeadlampClusterInfo[] {
  const clusters = (data as { clusters?: unknown } | null)?.clusters;
  if (!Array.isArray(clusters)) return [];
  return clusters
    .filter((c: any) => c && typeof c.name === 'string')
    .map((c: any) => ({ name: c.name, server: typeof c.server === 'string' ? c.server : undefined }));
}

export function endpointKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

/** "https://40.60.0.1:6443" → "40.60.0.1:6443" (default port 443 for https). */
export function serverKey(server: string | undefined): string | undefined {
  if (!server) return undefined;
  try {
    const u = new URL(server);
    const port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
    return endpointKey(u.hostname, port);
  } catch {
    return undefined;
  }
}

export function serverHost(server: string | undefined): string | undefined {
  if (!server) return undefined;
  try {
    return new URL(server).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Fleet cluster key → Headlamp context name.
 * If several contexts point at the same endpoint, prefer the one named like
 * the cluster (what `kubectl vsphere login` creates), else the first by name.
 * If Headlamp didn't report servers at all, fall back to an exact name match,
 * but only for names that are unique in the fleet.
 */
export function matchContexts(
  fleet: Pick<FleetCluster, 'key' | 'name' | 'endpoint'>[],
  contexts: HeadlampClusterInfo[]
): Map<string, string> {
  const result = new Map<string, string>();
  const sorted = [...contexts].sort((a, b) => a.name.localeCompare(b.name));
  const haveServers = sorted.some(c => serverKey(c.server));

  if (haveServers) {
    const byServer = new Map<string, HeadlampClusterInfo[]>();
    for (const c of sorted) {
      const k = serverKey(c.server);
      if (k) byServer.set(k, [...(byServer.get(k) ?? []), c]);
    }
    for (const fc of fleet) {
      if (!fc.endpoint) continue;
      const candidates = byServer.get(endpointKey(fc.endpoint.host, fc.endpoint.port));
      if (!candidates?.length) continue;
      result.set(fc.key, (candidates.find(c => c.name === fc.name) ?? candidates[0]).name);
    }
    return result;
  }

  const nameCount = new Map<string, number>();
  for (const fc of fleet) nameCount.set(fc.name, (nameCount.get(fc.name) ?? 0) + 1);
  const contextNames = new Set(sorted.map(c => c.name));
  for (const fc of fleet) {
    if (nameCount.get(fc.name) === 1 && contextNames.has(fc.name)) result.set(fc.key, fc.name);
  }
  return result;
}
