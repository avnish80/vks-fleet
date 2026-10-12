/**
 * The security overview: how secure the fleet is, in one place. It only brings
 * together what the Posture, Compliance and Vulnerabilities tabs already
 * collect (nothing new is scanned): one row per cluster, the controls failing
 * in the most clusters, the risks that were accepted, and one evidence pack.
 *
 * The security score is the compliance result, nothing blended in: checks that
 * pass out of checks that pass or fail, with accepted (waived) controls
 * counted as passing, the same arithmetic as the Compliance tab. Pure
 * functions over plain data.
 */
import { ClusterScan, SECURITY_KIND_LABEL, SecurityFinding } from './clusterScan';
import { ComplianceScore, ControlResult, ControlStatus, scoreResults } from './compliance';
import { complianceMarkdown, isWaived } from './complianceReport';
import { latest, mergeNodeScan, NodeScanRun } from './nodeScan';
import { securityIssueId } from './scanIssues';
import { cisCoverage } from './benchmark';
import { fleetImages, ScannerReports, topCves } from './scanners';
import { Silence } from './types';

const DAY = 86400e3;

/** A cluster's CIS-aligned results, with node-scan results merged in. */
export function cisResults(scan: ClusterScan, runs: NodeScanRun[] = []): ControlResult[] {
  return mergeNodeScan(scan.compliance, runs).filter(r => (r.frameworks ?? ['cis']).includes('cis'));
}

/** The same results with accepted (waived) failures counted as passing. */
function effective(scan: ClusterScan, results: ControlResult[], silences: Silence[]): ControlResult[] {
  return results.map(r => (r.status === 'fail' && isWaived(silences, scan.clusterKey, r.id) ? { ...r, status: 'pass' as ControlStatus } : r));
}

export interface SecurityRow {
  clusterKey: string;
  clusterName: string;
  /** The cluster-wide default Pod Security level, when it could be probed. */
  psaDefault?: string;
  /** User namespaces whose effective level is "privileged", of how many. */
  privilegedNamespaces: number;
  namespaces: number;
  /** Compliance, with accepted controls counted as passing. */
  compliance: ComplianceScore;
  /** Controls failing and not accepted. */
  failing: number;
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
  sources: { nodeScan: boolean; scanner: boolean; policyEngine: boolean };
  /** Open posture findings (accepted ones left out): privileged or host-level pods, and cluster-admin grants. */
  privilegedPods: number;
  adminGrants: number;
  /** Critical posture findings still open. */
  criticalFindings: number;
  /** Days since the newest node scan (kube-bench); undefined when never scanned. */
  nodeScanDays?: number;
  /** Accepted risks: waived controls and accepted posture findings. */
  accepted: number;
}

export interface OverviewInput {
  scans: ClusterScan[];
  reports?: ScannerReports[];
  nodeScans?: Map<string, NodeScanRun[]>;
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

/** One row per signed-in cluster, the one with the lowest compliance first. */
export function securityRows(input: OverviewInput): SecurityRow[] {
  const rows = input.scans.map(scan => {
    const runs = input.nodeScans?.get(scan.clusterKey) ?? [];
    const results = cisResults(scan, runs);
    const open = scan.security.filter(f => !acceptedFinding(input.silences, scan, f));
    const objects = (kind: SecurityFinding['kind']) => open.filter(f => f.kind === kind && f.severity !== 'info').reduce((n, f) => n + f.objects.length, 0);
    const report = input.reports?.find(r => r.clusterKey === scan.clusterKey);
    const newest = [latest(runs, 'control-plane'), latest(runs, 'worker')].filter((r): r is NodeScanRun => !!r).map(r => new Date(r.at).getTime());
    const waived = results.filter(r => r.status === 'fail' && isWaived(input.silences, scan.clusterKey, r.id)).length;
    return {
      clusterKey: scan.clusterKey,
      clusterName: scan.clusterName,
      psaDefault: scan.psaDefault,
      privilegedNamespaces: scan.namespaces.filter(n => n.enforce === 'privileged').length,
      namespaces: scan.namespaces.length,
      compliance: scoreResults(effective(scan, results, input.silences)),
      failing: results.filter(r => r.status === 'fail').length - waived,
      vulns: report?.trivy ? vulnCounts([report]) : undefined,
      benchmark: scan.benchmark,
      benchmarkBeyond: scan.benchmarkBeyond,
      sources: { nodeScan: newest.length > 0, scanner: !!report?.trivy, policyEngine: !!report?.policyEngine },
      privilegedPods: objects('privileged'),
      adminGrants: objects('cluster-admin'),
      criticalFindings: open.filter(f => f.severity === 'critical').length,
      nodeScanDays: newest.length ? Math.max(0, Math.floor((input.now.getTime() - Math.max(...newest)) / DAY)) : undefined,
      accepted: waived + scan.security.filter(f => acceptedFinding(input.silences, scan, f)).length,
    };
  });
  return rows.sort((a, b) => a.compliance.pct - b.compliance.pct || b.failing - a.failing || a.clusterName.localeCompare(b.clusterName));
}

/** The fleet's security score: every cluster's checks together (not an average of percentages). Undefined when nothing could be scored. */
export function securityScore(input: OverviewInput): ComplianceScore | undefined {
  const all = scoreResults(input.scans.flatMap(scan => effective(scan, cisResults(scan, input.nodeScans?.get(scan.clusterKey) ?? []), input.silences)));
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

/** Controls failing across the fleet, the most widespread first: each is one thing to fix once. */
export function failingControls(input: OverviewInput): FailingControl[] {
  const by = new Map<string, FailingControl>();
  for (const scan of input.scans) {
    for (const r of cisResults(scan, input.nodeScans?.get(scan.clusterKey) ?? [])) {
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
    for (const r of cisResults(scan, input.nodeScans?.get(scan.clusterKey) ?? [])) {
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
 * One document for an auditor or a review: the summary, each cluster, what
 * fails across the fleet, the accepted risks, the open posture findings, the
 * most widespread vulnerabilities, and the full compliance evidence.
 */
export function evidencePack(input: OverviewInput): string {
  const rows = securityRows(input);
  const score = securityScore(input);
  const failing = failingControls(input);
  const accepted = acceptedRisks(input);
  const out: string[] = [];
  out.push('# VKS fleet security evidence', '', `Generated ${input.now.toISOString()} by vks-fleet. ${rows.length} cluster${rows.length === 1 ? '' : 's'}.`, '');
  out.push(
    'CIS-aligned checks evaluated through the Kubernetes API (and node scans where they were run), posture findings, and scanner reports. Not a certified CIS assessment.',
    ''
  );
  const used = Array.from(new Set(input.scans.map(s => s.benchmark).filter(Boolean))).sort();
  const cover = cisCoverage();
  out.push('## How this is measured', '');
  out.push(`- **Benchmark:** each cluster is measured against the CIS Kubernetes Benchmark written for its Kubernetes version${used.length ? ` (here: ${used.map(v => `v${v}`).join(', ')})` : ''}. v2.0 covers Kubernetes 1.34 to 1.35; a newer cluster is measured against it and marked.`);
  out.push(`- **Coverage:** the checks assess ${cover.assessed} of the ${cover.total} recommendations in CIS v2.0 (v1.12 has the same numbering). Not assessed: ${cover.notAssessed.join(', ')}.`);
  out.push('- **Compliance, Pod Security and posture:** read through each cluster\'s Kubernetes API (control-plane flags from the static pods, each kubelet\'s live configuration, RBAC, namespaces, workloads). Nothing is installed in the cluster.');
  out.push('- **File permissions** (CIS 1.1 and 4.1): from a node scan, a kube-bench Job the plugin runs on request on one control-plane node and one worker. Until a scan has run, these are shown as "needs node scan" and never counted as passing.');
  out.push('- **Vulnerabilities:** from the reports Trivy Operator writes in a cluster where it is installed; each image is counted once, your own apart from the ones VKS ships.');
  out.push('- **Policy results:** from PolicyReports, where a policy engine such as Kyverno writes them.');
  out.push('- **Accepted risks** are counted apart from open ones and return when their acceptance ends.', '');
  out.push('## Summary', '');
  out.push(`- Security score: ${score ? `${score.pct}% (${score.pass} of ${score.scored} scored checks pass; accepted controls count as passing)` : 'not scored'}`);
  out.push(`- Controls failing: ${failing.length} distinct, ${rows.reduce((n, r) => n + r.failing, 0)} across clusters`);
  out.push(`- Accepted risks: ${accepted.count}${accepted.next ? ` (the first acceptance ends ${accepted.next.until.slice(0, 10)}: ${accepted.next.label})` : ''}`);
  out.push('', '## Clusters', '', '| Cluster | Benchmark | Compliance | Failing | Pod Security default | Privileged namespaces | Privileged pods | cluster-admin grants | Critical CVEs (yours) | High CVEs (yours) | Critical CVEs (VKS images) | Last node scan | Accepted |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push(
      `| ${cell(r.clusterName)} | ${r.benchmark ? `CIS ${r.benchmark}${r.benchmarkBeyond ? ' (cluster is newer)' : ''}` : '—'} | ${r.compliance.scored ? `${r.compliance.pct}%` : '—'} | ${r.failing} | ${cell(r.psaDefault)} | ${r.privilegedNamespaces} of ${r.namespaces} | ${r.privilegedPods} | ${r.adminGrants} | ${cell(r.vulns?.critical)} | ${cell(r.vulns?.high)} | ${cell(r.vulns?.vksCritical)} | ${
        r.nodeScanDays === undefined ? 'never' : r.nodeScanDays === 0 ? 'today' : `${r.nodeScanDays} days ago`
      } | ${r.accepted} |`
    );
  }
  out.push('', '## Controls failing across the fleet', '');
  if (!failing.length) out.push('None.');
  else {
    out.push('| Control | Reference | Owner | Clusters | Remediation |', '|---|---|---|---|---|');
    for (const f of failing) out.push(`| ${cell(f.title)} | ${cell(f.ref)} | ${f.owner === 'vks' ? 'VKS' : f.owner === 'you' ? 'Cluster owner' : 'Shared'} | ${cell(f.clusters.join(', '))} | ${cell(f.remediation)} |`);
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
  if (!scanned.length) out.push('No cluster has a vulnerability scanner (Trivy Operator), so there is nothing to report here.');
  else {
    out.push(`From Trivy Operator in ${scanned.length} cluster${scanned.length === 1 ? '' : 's'}. The 25 most widespread critical and high CVEs:`, '', '| CVE | Severity | Fixed in | Clusters | Images | Title |', '|---|---|---|---|---|---|');
    for (const c of topCves(scanned).slice(0, 25)) out.push(`| ${c.id} | ${c.severity} | ${cell(c.fixed)} | ${c.clusters.size} | ${c.images.size} | ${cell(c.title)} |`);
  }
  const withRuns = input.scans.map(scan => ({ ...scan, compliance: cisResults(scan, input.nodeScans?.get(scan.clusterKey) ?? []) }));
  out.push('', '---', '', complianceMarkdown(withRuns, input.silences, input.now));
  return out.join('\n');
}
