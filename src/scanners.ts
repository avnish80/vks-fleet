/**
 * Reports that security tools already write into each cluster, gathered
 * across the fleet (read-only; nothing is installed by the plugin):
 *  - Trivy Operator (aquasecurity.github.io/v1alpha1): VulnerabilityReports
 *    (image CVEs), ConfigAuditReports, ExposedSecretReports and
 *    ClusterComplianceReports (its CIS / NSA-CISA runs);
 *  - Kyverno and other policy engines: PolicyReports and
 *    ClusterPolicyReports (wgpolicyk8s.io/v1alpha2, or openreports.io/v1alpha1).
 */
import { describeError, statusOf, SupervisorClient } from './api/client';
import { isPlatformNamespace } from './workload';

/** Who fixes an image: VKS (its releases and standard packages) or the cluster owner. */
export type ImageOwner = 'vks' | 'you';

const VKS_IMAGE = /(^|\/)vsphere\/(supervisor|vksm)\/|(^|\/)tkg\/|packages\.broadcom\.com|projects\.registry\.vmware\.com/i;

export function imageOwner(image: string, namespace: string): ImageOwner {
  return VKS_IMAGE.test(image) || isPlatformNamespace(namespace) ? 'vks' : 'you';
}

/** Where a VKS image comes from, e.g. "vks-standard-packages 3.7.0-20260618". */
export function vksSource(image: string): string {
  const m = /(vks-standard-packages|vksm-extensions|tkg-standard-packages|vks-addons)\/(?:ga\/)?([^/@:]+)/.exec(image);
  if (m) return `${m[1]} ${m[2]}`;
  if (/localhost:5000\/tkg|(^|\/)tkg\//.test(image)) return 'VKS release images';
  return 'VKS platform';
}

export type Sev = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
const SEVS: Sev[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const sev = (s: unknown): Sev => (SEVS.includes(String(s).toUpperCase() as Sev) ? (String(s).toUpperCase() as Sev) : 'UNKNOWN');

export interface Vuln {
  id: string;
  severity: Sev;
  pkg: string;
  installed?: string;
  fixed?: string;
  title?: string;
  link?: string;
}

export interface ImageReport {
  image: string;
  owner: ImageOwner;
  /** For VKS images: the release or package set they come from. */
  source?: string;
  namespace: string;
  workload: string;
  container?: string;
  counts: Record<Sev, number>;
  /** Critical and high findings (capped), for the fleet's top CVEs. */
  top: Vuln[];
  fixable: number;
}

export interface ConfigAudit {
  owner: ImageOwner;
  namespace: string;
  workload: string;
  failed: Array<{ id: string; title: string; severity: Sev }>;
}

export interface TrivyCompliance {
  id: string;
  title: string;
  pass: number;
  fail: number;
  failing: Array<{ id: string; name: string; severity: Sev; totalFail: number }>;
}

export interface PolicyResult {
  policy: string;
  rule?: string;
  result: 'pass' | 'fail' | 'warn' | 'error' | 'skip';
  severity?: string;
  message?: string;
  resource?: string;
}

export interface ScannerReports {
  clusterKey: string;
  clusterName: string;
  contextName: string;
  trivy: boolean;
  images: ImageReport[];
  audits: ConfigAudit[];
  exposedSecrets: Array<{ image: string; workload: string; count: number }>;
  compliance: TrivyCompliance[];
  policyEngine: boolean;
  policy: PolicyResult[];
  policySummary: { pass: number; fail: number; warn: number; error: number; skip: number };
  errors: string[];
}

const TRIVY = '/apis/aquasecurity.github.io/v1alpha1';
const TOP_PER_IMAGE = 40;

const workloadOf = (r: any) => {
  const l = r?.metadata?.labels ?? {};
  return `${l['trivy-operator.resource.kind'] ?? ''}${l['trivy-operator.resource.kind'] ? ' ' : ''}${l['trivy-operator.resource.name'] ?? r?.metadata?.name ?? ''}`;
};

export function parseVulnerabilityReports(items: any[]): ImageReport[] {
  return items.map(r => {
    const rep = r?.report ?? {};
    const art = rep.artifact ?? {};
    const server = rep.registry?.server;
    const image = `${server && server !== 'index.docker.io' ? `${server}/` : ''}${art.repository ?? '?'}${art.tag ? `:${art.tag}` : art.digest ? `@${String(art.digest).slice(0, 19)}` : ''}`;
    const s = rep.summary ?? {};
    const counts: Record<Sev, number> = {
      CRITICAL: Number(s.criticalCount ?? 0),
      HIGH: Number(s.highCount ?? 0),
      MEDIUM: Number(s.mediumCount ?? 0),
      LOW: Number(s.lowCount ?? 0),
      UNKNOWN: Number(s.unknownCount ?? 0),
    };
    const vulns: any[] = rep.vulnerabilities ?? [];
    const owner = imageOwner(image, r?.metadata?.namespace ?? '');
    return {
      image,
      owner,
      source: owner === 'vks' ? vksSource(image) : undefined,
      namespace: r?.metadata?.namespace ?? '',
      workload: workloadOf(r),
      container: r?.metadata?.labels?.['trivy-operator.container.name'],
      counts,
      top: vulns
        .filter(v => ['CRITICAL', 'HIGH'].includes(sev(v?.severity)))
        .slice(0, TOP_PER_IMAGE)
        .map(v => ({
          id: String(v?.vulnerabilityID ?? ''),
          severity: sev(v?.severity),
          pkg: String(v?.resource ?? ''),
          installed: v?.installedVersion,
          fixed: v?.fixedVersion || undefined,
          title: v?.title ? String(v.title).slice(0, 160) : undefined,
          link: v?.primaryLink,
        })),
      fixable: vulns.filter(v => v?.fixedVersion).length,
    };
  });
}

export function parseConfigAudits(items: any[]): ConfigAudit[] {
  return items
    .map(r => ({
      owner: (isPlatformNamespace(r?.metadata?.namespace ?? '') ? 'vks' : 'you') as ImageOwner,
      namespace: r?.metadata?.namespace ?? '',
      workload: workloadOf(r),
      failed: (r?.report?.checks ?? [])
        .filter((c: any) => c?.success === false)
        .map((c: any) => ({ id: String(c?.checkID ?? ''), title: String(c?.title ?? ''), severity: sev(c?.severity) })),
    }))
    .filter(a => a.failed.length);
}

/** Exposed secrets: counts per image only (the matched text is never kept). */
export function parseExposedSecrets(items: any[]): Array<{ image: string; workload: string; count: number }> {
  return items
    .map(r => ({
      image: `${r?.report?.artifact?.repository ?? '?'}${r?.report?.artifact?.tag ? `:${r.report.artifact.tag}` : ''}`,
      workload: workloadOf(r),
      count: (r?.report?.secrets ?? []).length || Number(r?.report?.summary?.criticalCount ?? 0) + Number(r?.report?.summary?.highCount ?? 0),
    }))
    .filter(x => x.count > 0);
}

export function parseTrivyCompliance(items: any[]): TrivyCompliance[] {
  return items.map(r => {
    const checks: any[] = r?.status?.summaryReport?.controlCheck ?? [];
    return {
      id: String(r?.spec?.compliance?.id ?? r?.metadata?.name ?? ''),
      title: String(r?.spec?.compliance?.title ?? r?.metadata?.name ?? ''),
      pass: Number(r?.status?.summary?.passCount ?? 0),
      fail: Number(r?.status?.summary?.failCount ?? 0),
      failing: checks
        .filter(c => Number(c?.totalFail ?? 0) > 0)
        .map(c => ({ id: String(c?.id ?? ''), name: String(c?.name ?? ''), severity: sev(c?.severity), totalFail: Number(c?.totalFail) })),
    };
  });
}

export function parsePolicyReports(items: any[]): { results: PolicyResult[]; summary: ScannerReports['policySummary'] } {
  const summary = { pass: 0, fail: 0, warn: 0, error: 0, skip: 0 };
  const results: PolicyResult[] = [];
  for (const r of items) {
    const s = r?.summary ?? {};
    for (const k of Object.keys(summary) as Array<keyof typeof summary>) summary[k] += Number(s[k] ?? 0);
    for (const x of r?.results ?? []) {
      const result = String(x?.result ?? '').toLowerCase() as PolicyResult['result'];
      if (result !== 'fail' && result !== 'warn' && result !== 'error') continue;
      const res = (x?.resources ?? [])[0] ?? r?.scope;
      results.push({
        policy: String(x?.policy ?? ''),
        rule: x?.rule,
        result,
        severity: x?.severity,
        message: x?.message ? String(x.message).slice(0, 240) : undefined,
        resource: res ? `${res.kind ?? ''} ${res.namespace ? `${res.namespace}/` : ''}${res.name ?? ''}`.trim() : undefined,
      });
    }
  }
  return { results, summary };
}

async function list(client: SupervisorClient, paths: string[]): Promise<any[] | undefined> {
  for (const p of paths) {
    try {
      return (await client.get<{ items?: any[] }>(p))?.items ?? [];
    } catch (err) {
      if (statusOf(err) !== 404) throw err;
    }
  }
  return undefined; // not installed
}

export async function fetchScannerReports(client: SupervisorClient, clusterKey: string, clusterName: string, contextName: string): Promise<ScannerReports> {
  const errors: string[] = [];
  const read = async (label: string, paths: string[]) => {
    try {
      return await list(client, paths);
    } catch (err) {
      errors.push(`${label}: ${describeError(err)}`);
      return undefined;
    }
  };
  const [vulns, audits, secrets, comp, pr, cpr] = await Promise.all([
    read('Vulnerability reports', [`${TRIVY}/vulnerabilityreports?limit=2000`]),
    read('Config audit reports', [`${TRIVY}/configauditreports?limit=2000`]),
    read('Exposed secret reports', [`${TRIVY}/exposedsecretreports?limit=2000`]),
    read('Compliance reports', [`${TRIVY}/clustercompliancereports`]),
    read('Policy reports', ['/apis/openreports.io/v1alpha1/reports', '/apis/wgpolicyk8s.io/v1alpha2/policyreports']),
    read('Cluster policy reports', ['/apis/openreports.io/v1alpha1/clusterreports', '/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports']),
  ]);
  const policy = parsePolicyReports([...(pr ?? []), ...(cpr ?? [])]);
  return {
    clusterKey,
    clusterName,
    contextName,
    trivy: vulns !== undefined || audits !== undefined,
    images: parseVulnerabilityReports(vulns ?? []),
    audits: parseConfigAudits(audits ?? []),
    exposedSecrets: parseExposedSecrets(secrets ?? []),
    compliance: parseTrivyCompliance(comp ?? []),
    policyEngine: pr !== undefined || cpr !== undefined,
    policy: policy.results,
    policySummary: policy.summary,
    errors,
  };
}

/* ---------------- Across the fleet ---------------- */

export interface FleetCve {
  id: string;
  severity: Sev;
  fixed?: string;
  title?: string;
  link?: string;
  images: Set<string>;
  clusters: Set<string>;
  workloads: Set<string>;
}

/** The fleet's CVEs (critical and high), most widespread first. */
export function topCves(reports: ScannerReports[], owner?: ImageOwner): FleetCve[] {
  const m = new Map<string, FleetCve>();
  for (const r of reports) {
    for (const img of r.images.filter(i => !owner || i.owner === owner)) {
      for (const v of img.top) {
        const cur = m.get(v.id) ?? { id: v.id, severity: v.severity, fixed: v.fixed, title: v.title, link: v.link, images: new Set(), clusters: new Set(), workloads: new Set() };
        cur.images.add(img.image);
        cur.clusters.add(r.clusterName);
        cur.workloads.add(`${r.clusterName}: ${img.namespace}/${img.workload}`);
        if (!cur.fixed && v.fixed) cur.fixed = v.fixed;
        m.set(v.id, cur);
      }
    }
  }
  const rank = (s: Sev) => SEVS.indexOf(s);
  return Array.from(m.values()).sort((a, b) => rank(a.severity) - rank(b.severity) || b.clusters.size - a.clusters.size || b.images.size - a.images.size);
}

export interface FleetImage {
  image: string;
  owner: ImageOwner;
  source?: string;
  counts: Record<Sev, number>;
  fixable: number;
  clusters: Set<string>;
  workloads: Set<string>;
}

/** Unique images across the fleet with their vulnerability counts. */
export function fleetImages(reports: ScannerReports[], owner?: ImageOwner): FleetImage[] {
  const m = new Map<string, FleetImage>();
  for (const r of reports) {
    for (const img of r.images.filter(i => !owner || i.owner === owner)) {
      const cur = m.get(img.image) ?? { image: img.image, owner: img.owner, source: img.source, counts: img.counts, fixable: img.fixable, clusters: new Set(), workloads: new Set() };
      cur.clusters.add(r.clusterName);
      cur.workloads.add(`${r.clusterName}: ${img.namespace}/${img.workload}`);
      m.set(img.image, cur);
    }
  }
  return Array.from(m.values()).sort((a, b) => b.counts.CRITICAL - a.counts.CRITICAL || b.counts.HIGH - a.counts.HIGH);
}

export interface VksSourceSummary {
  source: string;
  images: number;
  critical: number;
  high: number;
  /** Critical and high findings with a fixed version available. */
  fixable: number;
  clusters: Set<string>;
  namespaces: Set<string>;
}

/** VKS-managed images grouped by where they come from (a standard-packages version, a release). */
export function vksSummary(reports: ScannerReports[]): VksSourceSummary[] {
  const m = new Map<string, VksSourceSummary & { seen: Set<string> }>();
  for (const r of reports) {
    for (const img of r.images.filter(i => i.owner === 'vks')) {
      const key = img.source ?? 'VKS platform';
      const cur = m.get(key) ?? { source: key, images: 0, critical: 0, high: 0, fixable: 0, clusters: new Set(), namespaces: new Set(), seen: new Set() };
      if (!cur.seen.has(img.image)) {
        cur.seen.add(img.image);
        cur.images += 1;
        cur.critical += img.counts.CRITICAL;
        cur.high += img.counts.HIGH;
        cur.fixable += img.top.filter(v => v.fixed).length;
      }
      cur.clusters.add(r.clusterName);
      cur.namespaces.add(img.namespace);
      m.set(key, cur);
    }
  }
  return Array.from(m.values())
    .map(({ seen, ...rest }) => rest)
    .sort((a, b) => b.critical - a.critical);
}

