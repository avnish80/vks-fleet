/**
 * A form from a package's values schema (OpenAPI v3, as Carvel packages ship
 * it): one field per setting, nested objects flattened to dotted paths, lists
 * and free-form objects as JSON. Only values that differ from the defaults
 * are sent, so an install's values stay short and readable.
 */

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';

export interface Field {
  path: string[];
  key: string;
  type: FieldType;
  enum?: string[];
  default?: unknown;
  description?: string;
}

const MAX_DEPTH = 4;

export function schemaFields(schema: any, prefix: string[] = [], depth = 0): Field[] {
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return [];
  const out: Field[] = [];
  for (const [name, raw] of Object.entries<any>(props)) {
    const path = [...prefix, name];
    const key = path.join('.');
    const description = raw?.description ? String(raw.description).slice(0, 300) : undefined;
    if (raw?.type === 'object' && raw?.properties && depth < MAX_DEPTH) {
      out.push(...schemaFields(raw, path, depth + 1));
    } else if (Array.isArray(raw?.enum) && raw.enum.length) {
      out.push({ path, key, type: 'enum', enum: raw.enum.map(String), default: raw.default, description });
    } else if (['string', 'number', 'integer', 'boolean'].includes(raw?.type)) {
      out.push({ path, key, type: raw.type, default: raw.default, description });
    } else {
      out.push({ path, key, type: 'json', default: raw?.default, description });
    }
  }
  return out;
}

/** Turns a field's text input into its typed value; undefined means "leave the default". */
export function parseField(f: Field, text: string | boolean | undefined): { value?: unknown; error?: string } {
  if (text === undefined || text === '') return {};
  switch (f.type) {
    case 'boolean':
      return { value: text === true || text === 'true' };
    case 'number':
    case 'integer': {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) return { error: `${f.key}: expected ${f.type === 'integer' ? 'a whole number' : 'a number'}` };
      return { value: n };
    }
    case 'json':
      try {
        return { value: JSON.parse(String(text)) };
      } catch {
        return { error: `${f.key}: expected JSON (for example ["a","b"] or {"k":"v"})` };
      }
    default:
      return { value: String(text) };
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The values object from the form's entries, keeping only what differs from the defaults. */
export function buildValues(fields: Field[], entries: Record<string, string | boolean | undefined>): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const { value, error } = parseField(f, entries[f.key]);
    if (error) errors.push(error);
    if (value === undefined || same(value, f.default)) continue;
    let node: any = values;
    for (const part of f.path.slice(0, -1)) node = node[part] ??= {};
    node[f.path[f.path.length - 1]] = value;
  }
  return { values, errors };
}

/** values.yaml content. JSON is valid YAML, and kapp-controller reads it as such. */
export function valuesText(values: Record<string, unknown>): string {
  return Object.keys(values).length ? `${JSON.stringify(values, null, 2)}\n` : '';
}
