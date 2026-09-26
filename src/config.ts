import { normalizeBaseline } from './baseline';
import { PluginConfig, SupervisorConfig } from './types';

export const PLUGIN_NAME = 'vks-fleet';
export const DEFAULT_REFRESH_SECONDS = 30;
export const MIN_REFRESH_SECONDS = 10;
/** Label VCFA puts on the Supervisor namespaces it creates; its value is the organization ID. */
export const DEFAULT_TENANT_LABEL = 'vmware-system-vcf/organization-id';

const DNS_LABELISH = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export function isValidSupervisorId(id: string): boolean {
  return DNS_LABELISH.test(id) && id.length <= 63;
}

export function parseNamespaces(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean)
    )
  );
}

/** Parses lines of "<tenant ID> = <name>". Blank lines and lines without "=" are ignored. */
export function parseTenantNames(text: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const id = line.slice(0, i).trim();
    const name = line.slice(i + 1).trim();
    if (id && name) names[id] = name;
  }
  return names;
}

export function formatTenantNames(names: Record<string, string> | undefined): string {
  return Object.entries(names ?? {})
    .map(([id, name]) => `${id} = ${name}`)
    .join('\n');
}

function sanitizeNames(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && k.trim() && v.trim()) out[k.trim()] = v.trim();
    }
  }
  return out;
}

function normalizeSupervisor(raw: Partial<SupervisorConfig>): SupervisorConfig | null {
  const headlampCluster = (raw.headlampCluster ?? '').trim();
  if (!headlampCluster) {
    return null;
  }
  const id = (raw.id ?? '').trim() || headlampCluster.toLowerCase();
  if (!isValidSupervisorId(id)) {
    return null;
  }
  return {
    id,
    headlampCluster,
    displayName: raw.displayName?.trim() || undefined,
    namespaces: Array.isArray(raw.namespaces) ? parseNamespaces(raw.namespaces.join(',')) : [],
    // Never set → VCFA default. Explicitly cleared → namespace is the tenant.
    tenantLabelKey:
      raw.tenantLabelKey === undefined ? DEFAULT_TENANT_LABEL : String(raw.tenantLabelKey).trim(),
    tenantNames: sanitizeNames(raw.tenantNames),
    mode: raw.mode === 'vcfa' ? 'vcfa' : 'supervisor',
    org: raw.org?.trim() || undefined,
    namespaceContexts: raw.namespaceContexts ? sanitizeNames(raw.namespaceContexts) : undefined,
    namespaceProjects: raw.namespaceProjects ? sanitizeNames(raw.namespaceProjects) : undefined,
    orgContext: raw.orgContext?.trim() || undefined,
  };
}

/**
 * Turns whatever is in the settings store into a usable config.
 * This is the Supervisor registry: phase 1 stores one entry, phase 2 many.
 * Invalid entries are dropped and duplicate ids keep the first entry, so
 * cluster keys stay unique.
 */
export function normalizeConfig(raw: Partial<PluginConfig> | undefined | null): PluginConfig {
  const seen = new Set<string>();
  const supervisors: SupervisorConfig[] = [];
  for (const entry of raw?.supervisors ?? []) {
    const s = normalizeSupervisor(entry ?? {});
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      supervisors.push(s);
    }
  }
  const refresh = Number(raw?.refreshSeconds);
  // Org names set once (e.g. from the org cards) apply to every Supervisor entry.
  const orgNames = raw?.orgNames && typeof raw.orgNames === 'object' ? sanitizeNames(raw.orgNames) : {};
  for (const sv of supervisors) sv.tenantNames = { ...orgNames, ...sv.tenantNames };
  return {
    orgNames,
    supervisors,
    refreshSeconds:
      Number.isFinite(refresh) && refresh >= MIN_REFRESH_SECONDS ? refresh : DEFAULT_REFRESH_SECONDS,
    baseline: normalizeBaseline(raw?.baseline),
    readOnly: raw?.readOnly === true,
    nodeScanImage: typeof raw?.nodeScanImage === 'string' && raw.nodeScanImage.trim() ? raw.nodeScanImage.trim() : undefined,
    identitySwitch: raw?.identitySwitch !== false,
    silences: (Array.isArray(raw?.silences) ? raw!.silences : []).filter(
      x => x && typeof x.id === 'string' && x.match && (x.match.issueId || x.match.clusterKey) && typeof x.until === 'string'
    ),
    links: (Array.isArray(raw?.links) ? raw!.links : [])
      .filter(l => l && typeof l.label === 'string' && typeof l.url === 'string' && /^https?:\/\//.test(l.url))
      .map(l => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter(l => l.label),
  };
}
