/**
 * What each cluster serves, remembered for a while, so refreshes don't repeat
 * lookups that can only fail: a resource that isn't installed (answered "not
 * found" everywhere), and which API version of a group answers. Only clients
 * that carry a name (real contexts, demo) are remembered.
 */
export const SERVED_TTL_MS = 10 * 60 * 1000;

const missing = new Map<string, number>();
const versions = new Map<string, { version: string; at: number }>();

const fresh = (at: number, now: number) => now - at < SERVED_TTL_MS;

export function isMissing(key: string | undefined, now = Date.now()): boolean {
  if (!key) return false;
  const at = missing.get(key);
  return at !== undefined && fresh(at, now);
}

export function markMissing(key: string | undefined, now = Date.now()): void {
  if (key) missing.set(key, now);
}

export function servedVersion(key: string | undefined, now = Date.now()): string | undefined {
  const v = key ? versions.get(key) : undefined;
  return v && fresh(v.at, now) ? v.version : undefined;
}

export function rememberVersion(key: string | undefined, version: string, now = Date.now()): void {
  if (key) versions.set(key, { version, at: now });
}

export function forgetServed(): void {
  missing.clear();
  versions.clear();
}

/** A list of a resource type (…/pods, …/namespaces/x/pods), not one named object. */
export function isListPath(path: string): boolean {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  const rest = parts[0] === 'api' ? parts.slice(2) : parts[0] === 'apis' ? parts.slice(3) : undefined;
  if (!rest || !rest.length) return false;
  if (rest[0] === 'namespaces') return rest.length === 3;
  return rest.length === 1;
}

/**
 * Wraps a cluster's reads: a list that answered "not found" (the resource
 * type isn't installed) isn't asked for again for a while. Named objects are
 * always asked for.
 */
export function rememberingGet<T>(name: string, path: string, get: () => Promise<T>, now = Date.now()): Promise<T> {
  const key = isListPath(path) ? `${name}|list|${path.split('?')[0]}` : undefined;
  if (isMissing(key, now)) return Promise.reject(Object.assign(new Error(`not served (remembered): ${path}`), { status: 404 }));
  return get().catch(err => {
    if ((err as { status?: number })?.status === 404) markMissing(key, now);
    throw err;
  });
}
