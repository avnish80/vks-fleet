/**
 * The security overview: how secure the fleet is, in one place. It only brings
 * together what the Posture, Compliance and Vulnerabilities tabs already
 * collect (nothing new is scanned): one row per cluster, the risks that were
 * accepted, and one evidence pack.
 *
 * By default it is posture and vulnerabilities only. The generic CIS Kubernetes
 * Benchmark checks join it (a score, failing controls, "fix once") only when
 * they are switched on in the settings: VMware does not publish or support a
 * CIS benchmark for VKS, so nothing here presents one unless asked to. Pure
 * functions over plain data.
 */
import { cisCoverage } from './benchmark';
import { ClusterScan, SECURITY_KIND_LABEL, SecurityFinding } from './clusterScan';
import { ComplianceScore, ControlResult, ControlStatus, GENERIC_CIS_NOTICE, scoreResults } from './compliance';
import { complianceMarkdown, isWaived } from './complianceReport';
import { securityIssueId } from './scanIssues';
import { fleetImages, ScannerReports, topCves } from './scanners';
import { Silence } from './types';

const DAY = 86400e3;

/** The same results with accepted (waived) failures counted as passing. */
function effective(scan: ClusterScan, silences: Silence[]): ControlResult[] {
  return scan.compliance.map(r => (r.status === 'fail' && isWaived(silences, scan.clusterKey, r.id) ? { ...r, status: 'pass' as ControlStatus } : r));
}

export interface SecurityRow {
  clusterKey: string;
  clusterName: string;
  /** The cluster-wide default Pod Security level, when it could be probed. */
  psaDefault?: string;
  /** User namespaces whose effective level is "privileged", of how many. */
  privilegedNamespaces: number;
  namespaces: number;
  /** Generic CIS benchmark result, with accepted controls counted as passing. Only when those checks are switched on. */
  compliance?: ComplianceScore;
  /** Benchmark controls failing and not accepted. Only when those checks are switched on. */
  failing?: number;
  /**
   * Image vulnerabilities, when the cluster has a scanner (Trivy): counted once per
   * image (not once per pod running it), your own images apart from the ones VKS
   * ships and rebuilds. The same counting as the Vulnerabilities tab.
   */
  vulns?: { critical: number; high: number; vksCritical: number; vksHigh: number };
  /** The CIS benchmark version the cluster is measured against, and whether its Kubernetes is newer than that covers. */
  benchmark?: string;
  benchmarkBeyond?: boolean;
  /** What this cluster is measured with, beyond the API checks every signed-in cluster gets. */
  sources: { scanner: boolean; policyEngine: boolean };
  /** Open posture findings (accepted ones left out): privileged or host-level pods, and cluster-admin grants. */
  privilegedPods: number;
  adminGrants: number;
  /** Critical posture findings still open. */
  criticalFindings: number;
  /** Accepted risks: accepted posture findings (and waived benchmark controls, when those checks are on). */
  accepted: number;
}

export interface OverviewInput {
  scans: ClusterScan[];
  reports?: ScannerReports[];
  /** Whether the generic CIS Kubernetes Benchmark checks are switched on (off by default). */
  cis?: boolean;
  /** Active silences (waivers and accepted findings among them). */
  silences: Silence[];
  now: Date;
}

const acceptedFinding = (silences: Silence[], scan: ClusterScan, f: SecurityFinding) => silences.find(s => s.match.issueId === securityIssueId(scan.clusterKey, f));

/** Critical and high vulnerabilities, each image counted once: yours, and the images VKS ships. */
export function vulnCounts(reports: ScannerReports[]): { critical: number; high: number; vksCritical: number; vksHigh: number } {
  const sum = (owner: 'you' | 'vks', sev: 'CRITICAL' | 'HIGH') => fleetImages(reports, owner).reduce((n, i) => n + i.counts[sev], 0);
  return { critical: sum('you', 'CRITICAL'), high: sum('you', 'HIGH'), vksCritical: sum('vks', 'CRITICAL'), vksHigh: sum('vks', 'HIGH') };
}

/** One row per signed-in cluster, the one with the most open findings first (the lowest benchmark result first, when those checks are on). */
export function securityRows(input: OverviewInput): SecurityRow[] {
  const rows = input.scans.map(scan => {
    const results = input.cis ? scan.compliance : [];
    const open = scan.security.filter(f => !acceptedFinding(input.silences, scan, f));
    const objects = (kind: SecurityFinding['kind']) => open.filter(f => f.kind === kind && f.severity !== 'info').reduce((n, f) => n + f.objects.length, 0);
    const report = input.reports?.find(r => r.clusterKey === scan.clusterKey);
    const waived = results.filter(r => r.status === 'fail' && isWaived(input.silences, scan.clusterKey, r.id)).length;
    return {
      clusterKey: scan.clusterKey,
      clusterName: scan.clusterName,
      psaDefault: scan.psaDefault,
      privilegedNamespaces: scan.namespaces.filter(n => n.enforce === 'privileged').length,
      namespaces: scan.namespaces.length,
      compliance: input.cis ? scoreResults(effective(scan, input.silences)) : undefined,
      failing: input.cis ? results.filter(r => r.status === 'fail').length - waived : undefined,
      vulns: report?.trivy ? vulnCounts([report]) : undefined,
      benchmark: input.cis ? scan.benchmark : undefined,
      benchmarkBeyond: input.cis ? scan.benchmarkBeyond : undefined,
      sources: { scanner: !!report?.trivy, policyEngine: !!report?.policyEngine },
      privilegedPods: objects('privileged'),
      adminGrants: objects('cluster-admin'),
      criticalFindings: open.filter(f => f.severity === 'critical').length,
      accepted: waived + scan.security.filter(f => acceptedFinding(input.silences, scan, f)).length,
    };
  });
  const open = (r: SecurityRow) => r.criticalFindings * 100 + r.privilegedPods + r.adminGrants + r.privilegedNamespaces + (r.vulns?.critical ?? 0);
  return rows.sort((a, b) =>
    input.cis ? (a.compliance?.pct ?? 0) - (b.compliance?.pct ?? 0) || (b.failing ?? 0) - (a.failing ?? 0) || a.clusterName.localeCompare(b.clusterName) : open(b) - open(a) || a.clusterName.localeCompare(b.clusterName)
  );
}

/**
 * The generic CIS benchmark result for the fleet: every cluster's checks together (not an average of
 * percentages). Undefined when those checks are off, or nothing could be scored.
 */
export function securityScore(input: OverviewInput): ComplianceScore | undefined {
  if (!input.cis) return undefined;
  const all = scoreResults(input.scans.flatMap(scan => effective(scan, input.silences)));
  return all.scored ? all : undefined;
}

export interface FailingControl {
  id: string;
  ref: string;
  title: string;
  owner: ControlResult['owner'];
  remediation: string;
  /** Names of the clusters where it fails and isn't accepted. */
  clusters: string[];
}

/** Benchmark controls failing across the fleet, the most widespread first: each is one thing to fix once. Empty when those checks are off. */
export function failingControls(input: OverviewInput): FailingControl[] {
  const by = new Map<string, FailingControl>();
  for (const scan of input.cis ? input.scans : []) {
    for (const r of scan.compliance) {
      if (r.status !== 'fail' || isWaived(input.silences, scan.clusterKey, r.id)) continue;
      const cur = by.get(r.id) ?? { id: r.id, ref: r.ref, title: r.title, owner: r.owner, remediation: r.remediation, clusters: [] };
      cur.clusters.push(scan.clusterName);
      by.set(r.id, cur);
    }
  }
  // What the cluster owner can fix comes before what VKS manages, at the same spread.
  const rank = { you: 0, shared: 1, vks: 2 } as const;
  return Array.from(by.values()).sort((a, b) => b.clusters.length - a.clusters.length || rank[a.owner] - rank[b.owner] || a.id.localeCompare(b.id));
}

export interface AcceptedRisks {
  /** Waived controls and accepted posture findings, across the fleet. */
  count: number;
  /** The acceptance that ends first: when, and what it covers. */
  next?: { until: string; label: string; days: number };
}

/** The risks someone decided to accept, and when the first acceptance runs out. */
export function acceptedRisks(input: OverviewInput): AcceptedRisks {
  const used = new Map<string, Silence>();
  let count = 0;
  for (const scan of input.scans) {
    for (const r of input.cis ? scan.compliance : []) {
      const s = r.status === 'fail' ? isWaived(input.silences, scan.clusterKey, r.id) : undefined;
      if (s) {
        count += 1;
        used.set(s.id, s);
      }
    }
    for (const f of scan.security) {
      const s = acceptedFinding(input.silences, scan, f);
      if (s) {
        count += 1;
        used.set(s.id, s);
      }
    }
  }
  const first = Array.from(used.values()).sort((a, b) => a.until.localeCompare(b.until))[0];
  return { count, next: first ? { until: first.until, label: first.label, days: Math.max(0, Math.ceil((new Date(first.until).getTime() - input.now.getTime()) / DAY)) } : undefined };
}

const cell = (v: string | number | undefined) => (v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|'));

/**
 * One document for a review: how it is measured, each cluster, the accepted
 * risks, the open posture findings and the most widespread vulnerabilities.
 * The generic CIS benchmark results are part of it only when those checks are
 * switched on, and are labelled as generic.
 */
export function evidencePack(input: OverviewInput): string {
  const rows = securityRows(input);
  const score = securityScore(input);
  const failing = failingControls(input);
  const accepted = acceptedRisks(input);
  const cis = !!input.cis;
  const out: string[] = [];
  out.push('# VKS fleet security evidence', '', `Generated ${input.now.toISOString()} by vks-fleet. ${rows.length} cluster${rows.length === 1 ? '' : 's'}.`, '');
  out.push('## How this is measured', '');
  out.push("- **Pod Security and posture:** read through each cluster's Kubernetes API (namespace labels, the cluster default, running pods, role bindings, network policies). Nothing is installed in the cluster.");
  out.push('- **Vulnerabilities:** from the reports Trivy Operator writes in a cluster where it is installed; each image is counted once, your own apart from the ones VKS ships. A cluster without it reads "not measured".');
  out.push('- **Policy results:** from PolicyReports, where a policy engine such as Kyverno writes them.');
  out.push('- **Accepted risks** are counted apart from open ones and return when their acceptance ends.');
  if (cis) {
    const used = Array.from(new Set(input.scans.map(s => s.benchmark).filter(Boolean))).sort();
    const cover = cisCoverage();
    out.push(`- **Generic CIS Kubernetes Benchmark checks (switched on in the settings):** ${GENERIC_CIS_NOTICE}`);
    out.push(`  - Each cluster is aligned with the benchmark written for its Kubernetes version${used.length ? ` (here: ${used.map(v => `v${v}`).join(', ')})` : ''}; v2.0 covers Kubernetes 1.34 to 1.35, and a newer cluster is measured against it and marked.`);
    out.push(`  - Of the ${cover.total} recommendations in v2.0, ${cover.assessed} are assessed automatically through the Kubernetes API and ${cover.manual} are listed for a person to review (file permissions on the nodes are not visible through the API). Not covered: ${cover.notAssessed.join(', ')}.`);
  } else {
    out.push('- **No benchmark score:** VMware does not publish or support a CIS benchmark for VKS, so this document makes no benchmark claim. Generic CIS checks can be switched on in the plugin settings as a reference.');
  }
  out.push('', '## Summary', '');
  if (cis) {
    out.push(`- Generic CIS benchmark result: ${score ? `${score.pct}% (${score.pass} of ${score.scored} scored checks pass; accepted controls count as passing)` : 'not scored'}`);
    out.push(`- Benchmark controls failing: ${failing.length} distinct, ${rows.reduce((n, r) => n + (r.failing ?? 0), 0)} across clusters`);
  }
  out.push(`- Privileged namespaces: ${rows.reduce((n, r) => n + r.privilegedNamespaces, 0)} of ${rows.reduce((n, r) => n + r.namespaces, 0)} user namespaces`);
  out.push(`- Privileged or host-level pods: ${rows.reduce((n, r) => n + r.privilegedPods, 0)}; cluster-admin grants: ${rows.reduce((n, r) => n + r.adminGrants, 0)}`);
  out.push(`- Accepted risks: ${accepted.count}${accepted.next ? ` (the first acceptance ends ${accepted.next.until.slice(0, 10)}: ${accepted.next.label})` : ''}`);
  const cols = ['Cluster', ...(cis ? ['Benchmark', 'Benchmark result', 'Failing'] : []), 'Pod Security default', 'Privileged namespaces', 'Privileged pods', 'cluster-admin grants', 'Critical CVEs (yours)', 'High CVEs (yours)', 'Critical CVEs (VKS images)', 'Accepted'];
  out.push('', '## Clusters', '', `| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
  for (const r of rows) {
    const cells = [
      cell(r.clusterName),
      ...(cis ? [r.benchmark ? `CIS ${r.benchmark}${r.benchmarkBeyond ? ' (cluster is newer)' : ''}` : '—', r.compliance?.scored ? `${r.compliance.pct}%` : '—', String(r.failing ?? 0)] : []),
      cell(r.psaDefault),
      `${r.privilegedNamespaces} of ${r.namespaces}`,
      String(r.privilegedPods),
      String(r.adminGrants),
      r.vulns ? String(r.vulns.critical) : 'not measured',
      r.vulns ? String(r.vulns.high) : 'not measured',
      r.vulns ? String(r.vulns.vksCritical) : 'not measured',
      String(r.accepted),
    ];
    out.push(`| ${cells.join(' | ')} |`);
  }
  if (cis) {
    out.push('', '## Generic CIS benchmark controls failing across the fleet', '');
    if (!failing.length) out.push('None.');
    else {
      out.push('| Control | Reference | Owner | Clusters | Remediation |', '|---|---|---|---|---|');
      for (const f of failing) out.push(`| ${cell(f.title)} | ${cell(f.ref)} | ${f.owner === 'vks' ? 'VKS' : f.owner === 'you' ? 'Cluster owner' : 'Shared'} | ${cell(f.clusters.join(', '))} | ${cell(f.remediation)} |`);
    }
  }
  out.push('', '## Posture findings', '', '| Cluster | Severity | Check | Finding | Objects | Accepted until | Reason |', '|---|---|---|---|---|---|---|');
  for (const scan of input.scans) {
    for (const f of scan.security) {
      const s = acceptedFinding(input.silences, scan, f);
      out.push(`| ${cell(scan.clusterName)} | ${f.severity} | ${cell(SECURITY_KIND_LABEL[f.kind])} | ${cell(f.title)} | ${cell(f.objects.slice(0, 12).join(', '))}${f.objects.length > 12 ? ` and ${f.objects.length - 12} more` : ''} | ${cell(s?.until.slice(0, 10))} | ${cell(s?.reason)} |`);
    }
  }
  const scanned = (input.reports ?? []).filter(r => r.trivy);
  out.push('', '## Vulnerabilities', '');
  if (!scanned.length) out.push('Not measured: no cluster has a vulnerability scanner (Trivy Operator).');
  else {
    out.push(`From Trivy Operator in ${scanned.length} cluster${scanned.length === 1 ? '' : 's'}. The 25 most widespread critical and high CVEs:`, '', '| CVE | Severity | Fixed in | Clusters | Images | Title |', '|---|---|---|---|---|---|');
    for (const c of topCves(scanned).slice(0, 25)) out.push(`| ${c.id} | ${c.severity} | ${cell(c.fixed)} | ${c.clusters.size} | ${c.images.size} | ${cell(c.title)} |`);
  }
  if (cis) out.push('', '---', '', complianceMarkdown(input.scans, input.silences, input.now));
  return out.join('\n');
}
