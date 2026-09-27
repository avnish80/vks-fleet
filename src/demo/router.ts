/**
 * A tiny Kubernetes API over in-memory objects, for demo mode and tests.
 * Handles list, get by name, namespaced paths, discovery, and the label and
 * field selectors the plugin uses. Unknown resources answer 404, which the
 * plugin already treats as "not installed".
 */

export interface Store {
  /** Objects by "group|plural" ("" group for core). */
  objects: Map<string, any[]>;
  /** Special answers by exact path (logs, configz). */
  special?: Map<string, unknown>;
}

export const notFound = (path: string) => Object.assign(new Error(`the server could not find the requested resource (${path})`), { status: 404 });

export function add(store: Store, group: string, plural: string, items: any[]): void {
  const k = `${group}|${plural}`;
  store.objects.set(k, [...(store.objects.get(k) ?? []), ...items]);
}

export interface Route {
  group: string;
  plural?: string;
  namespace?: string;
  name?: string;
  sub?: string[];
  query: URLSearchParams;
}

export function parsePath(path: string): Route | undefined {
  const [p, q = ''] = path.split('?');
  const query = new URLSearchParams(q);
  const parts = p.split('/').filter(Boolean);
  let group: string;
  let rest: string[];
  if (parts[0] === 'api' && parts[1] === 'v1') {
    group = '';
    rest = parts.slice(2);
  } else if (parts[0] === 'apis' && parts.length >= 3) {
    group = parts[1];
    rest = parts.slice(3);
  } else return undefined;
  if (!rest.length) return { group, query };
  if (rest[0] === 'namespaces' && rest.length >= 3) {
    return { group, namespace: decodeURIComponent(rest[1]), plural: rest[2], name: rest[3] && decodeURIComponent(rest[3]), sub: rest.slice(4), query };
  }
  return { group, plural: rest[0], name: rest[1] && decodeURIComponent(rest[1]), sub: rest.slice(2), query };
}

function get(obj: any, dotted: string): unknown {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matches(obj: any, q: URLSearchParams): boolean {
  const label = q.get('labelSelector');
  if (label) {
    for (const term of label.split(',')) {
      const [k, v] = term.split('=');
      if ((obj?.metadata?.labels ?? {})[k] !== v) return false;
    }
  }
  const field = q.get('fieldSelector');
  if (field) {
    for (const term of field.split(',')) {
      const [k, v] = term.split('=');
      const actual = k === 'type' ? obj?.type : get(obj, k);
      if (String(actual ?? '') !== v) return false;
    }
  }
  return true;
}

export function answer(store: Store, path: string): unknown {
  const exact = store.special?.get(path.split('?')[0]);
  if (exact !== undefined) return exact;
  const r = parsePath(path);
  if (!r) throw notFound(path);
  // Discovery: which resources a group serves.
  if (!r.plural) {
    const resources = Array.from(store.objects.keys())
      .filter(k => k.startsWith(`${r.group}|`))
      .map(k => ({ name: k.split('|')[1], namespaced: true, kind: k.split('|')[1] }));
    if (!resources.length && r.group !== '') throw notFound(path);
    return { kind: 'APIResourceList', resources };
  }
  const items = store.objects.get(`${r.group}|${r.plural}`);
  if (!items) throw notFound(path);
  if (r.plural === 'namespaces' && !r.namespace && r.name) {
    const ns = items.find(o => o?.metadata?.name === r.name);
    if (!ns) throw notFound(path);
    return ns;
  }
  const scoped = items.filter(o => !r.namespace || o?.metadata?.namespace === r.namespace);
  if (r.name) {
    const one = scoped.find(o => o?.metadata?.name === r.name);
    if (!one) throw notFound(path);
    if (r.sub?.length) {
      const special = store.special?.get(`${r.group}|${r.plural}|${r.name}|${r.sub.join('/')}`);
      if (special === undefined) throw notFound(path);
      return special;
    }
    return one;
  }
  return { kind: 'List', items: scoped.filter(o => matches(o, r.query)) };
}
