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
import { ScannerReports, topCves } from './scanners';
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
  /** Image vulnerabilities, when the cluster has a scanner (Trivy). */
  vulns?: { critical: number; high: number };
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
      vulns: report?.trivy ? { critical: report.images.reduce((n, i) => n + i.counts.CRITICAL, 0), high: report.images.reduce((n, i) => n + i.counts.HIGH, 0) } : undefined,
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
  out.push('## Summary', '');
  out.push(`- Security score: ${score ? `${score.pct}% (${score.pass} of ${score.scored} scored checks pass; accepted controls count as passing)` : 'not scored'}`);
  out.push(`- Controls failing: ${failing.length} distinct, ${rows.reduce((n, r) => n + r.failing, 0)} across clusters`);
  out.push(`- Accepted risks: ${accepted.count}${accepted.next ? ` (the first acceptance ends ${accepted.next.until.slice(0, 10)}: ${accepted.next.label})` : ''}`);
  out.push('', '## Clusters', '', '| Cluster | Compliance | Failing | Pod Security default | Privileged namespaces | Privileged pods | cluster-admin grants | Critical CVEs | High CVEs | Last node scan | Accepted |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push(
      `| ${cell(r.clusterName)} | ${r.compliance.scored ? `${r.compliance.pct}%` : '—'} | ${r.failing} | ${cell(r.psaDefault)} | ${r.privilegedNamespaces} of ${r.namespaces} | ${r.privilegedPods} | ${r.adminGrants} | ${cell(r.vulns?.critical)} | ${cell(r.vulns?.high)} | ${
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
