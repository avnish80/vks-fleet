/**
 * Compliance over time and on paper: drift against a saved baseline, issues
 * for failing controls, and evidence exports for auditors (Markdown, CSV).
 */
import { ClusterScan } from './clusterScan';
import { complianceIssueId, ControlResult, ControlStatus, scoreResults } from './compliance';
import { Issue, Silence } from './types';

export const COMPLIANCE_PATH = '/vks-fleet/compliance';

export interface Baseline {
  at: string;
  statuses: Record<string, ControlStatus>;
}

export interface DriftItem {
  id: string;
  title: string;
  from: ControlStatus;
  to: ControlStatus;
  worse: boolean;
}

const rank: Record<ControlStatus, number> = { pass: 0, review: 1, 'node-scan': 1, unknown: 1, fail: 2 };

export function snapshot(results: ControlResult[], now: Date = new Date()): Baseline {
  return { at: now.toISOString(), statuses: Object.fromEntries(results.map(r => [r.id, r.status])) };
}

/** Controls whose result changed since the baseline (worse first). */
export function complianceDrift(baseline: Baseline | undefined, results: ControlResult[]): DriftItem[] {
  if (!baseline) return [];
  return results
    .filter(r => baseline.statuses[r.id] && baseline.statuses[r.id] !== r.status && (r.status === 'pass' || r.status === 'fail' || baseline.statuses[r.id] === 'pass' || baseline.statuses[r.id] === 'fail'))
    .map(r => ({ id: r.id, title: r.title, from: baseline.statuses[r.id], to: r.status, worse: rank[r.status] > rank[baseline.statuses[r.id]] }))
    .sort((a, b) => Number(b.worse) - Number(a.worse));
}

export const isWaived = (silences: Silence[], clusterKey: string, controlId: string) =>
  silences.find(s => s.match.issueId === complianceIssueId(clusterKey, controlId));

/** One issue per cluster for failing controls (waived ones left out), plus one per regression. */
export function complianceIssues(
  scans: ClusterScan[],
  clusters: Array<{ key: string; name: string; namespace: string; supervisorId: string; tenantName: string }>,
  silences: Silence[],
  baselines: Record<string, Baseline>,
  now: Date = new Date()
): Issue[] {
  const out: Issue[] = [];
  for (const s of scans) {
    const c = clusters.find(x => x.key === s.clusterKey);
    if (!c) continue;
    const cis = s.compliance.filter(r => (r.frameworks ?? ['cis']).includes('cis'));
    const failing = cis.filter(r => r.status === 'fail' && !isWaived(silences, c.key, r.id));
    const base = {
      supervisorId: c.supervisorId,
      clusterKey: c.key,
      clusterName: c.name,
      namespace: c.namespace,
      affected: { clusters: [c.name], tenants: [c.tenantName], nodes: [], pods: [] },
      links: [],
      findingIds: [],
      detectedAt: now.toISOString(),
    };
    if (failing.length) {
      const yours = failing.filter(r => r.owner !== 'vks').length;
      out.push({
        ...base,
        id: `${c.key}#compliance`,
        severity: yours ? 'warning' : 'info',
        title: `${failing.length} CIS-aligned control${failing.length === 1 ? '' : 's'} failing in ${c.name} (${yours} yours, ${failing.length - yours} VKS-managed)`,
        cause: 'Failing checks from the CIS-aligned benchmark. VKS-managed ones come from the platform configuration; yours from how the cluster is used.',
        evidence: failing.slice(0, 6).map(r => `${r.id}: ${r.title} (${r.evidence})`),
        fix: 'Open Compliance for each control\'s remediation, or waive it with a reason and an expiry if the risk is accepted.',
        primary: { label: 'Compliance', path: `${COMPLIANCE_PATH}#${encodeURIComponent(c.key)}` },
      });
    }
    for (const d of complianceDrift(baselines[c.key], cis).filter(x => x.worse && x.to === 'fail')) {
      if (isWaived(silences, c.key, d.id)) continue;
      out.push({
        ...base,
        id: `${complianceIssueId(c.key, d.id)}#drift`,
        severity: 'warning',
        title: `Compliance drift in ${c.name}: ${d.id} went from ${d.from} to ${d.to}`,
        cause: d.title,
        evidence: [],
        fix: 'Find what changed (a new workload, binding or namespace) and fix it, or save the current results as the new baseline if intended.',
        primary: { label: 'Compliance', path: `${COMPLIANCE_PATH}#${encodeURIComponent(c.key)}` },
      });
    }
  }
  return out;
}

const q = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function complianceCsv(scans: ClusterScan[], silences: Silence[]): string {
  const lines = ['scanned_at,cluster,control,reference,section,level,owner,method,result,evidence,remediation,waived_until,waiver_reason'];
  for (const s of scans) {
    for (const r of s.compliance) {
      const w = isWaived(silences, s.clusterKey, r.id);
      lines.push([s.at, q(s.clusterName), r.id, q(r.ref), q(r.section), r.level, r.owner, r.method, r.status, q(r.evidence), q(r.remediation), w?.until ?? '', q(w?.reason ?? '')].join(','));
    }
  }
  return lines.join('\n');
}

export function complianceMarkdown(scans: ClusterScan[], silences: Silence[], now: Date = new Date()): string {
  const out: string[] = [
    '# VKS compliance evidence (CIS-aligned)',
    '',
    `Generated ${now.toISOString().replace('T', ' ').slice(0, 16)} UTC by the vks-fleet Headlamp plugin.`,
    '',
    '> Checks aligned with the CIS Kubernetes Benchmark, evaluated through the Kubernetes API. This is not a certified CIS assessment. File-permission controls need a node-level scan and are marked as such.',
    '',
    '## Summary',
    '',
    '| Cluster | Score | Scored | Pass | Fail | Waived | Review | Not readable | Needs node scan | Scanned |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of scans) {
    const sc = scoreResults(s.compliance);
    const waived = s.compliance.filter(r => r.status === 'fail' && isWaived(silences, s.clusterKey, r.id)).length;
    out.push(`| ${s.clusterName} | ${sc.scored ? `${sc.pct}%` : '—'} | ${sc.scored} of ${sc.total} | ${sc.pass} | ${sc.fail - waived} | ${waived} | ${sc.review} | ${sc.unknown} | ${sc.nodeScan} | ${s.at.slice(0, 16).replace('T', ' ')} |`);
  }
  for (const s of scans) {
    out.push('', `## ${s.clusterName}`, '', '| Control | Ref | Owner | Level | Result | Evidence |', '|---|---|---|---|---|---|');
    for (const r of s.compliance) {
      const w = isWaived(silences, s.clusterKey, r.id);
      const result = w && r.status === 'fail' ? `waived until ${w.until.slice(0, 10)} (${w.reason})` : r.status;
      out.push(`| ${r.id}: ${r.title} | ${r.ref} | ${r.owner === 'vks' ? 'VKS' : r.owner === 'you' ? 'Cluster owner' : 'Shared'} | L${r.level} | ${result} | ${r.evidence.replace(/\|/g, '\\|')} |`);
    }
  }
  return out.join('\n');
}

/* ---------------- OSCAL ---------------- */

const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? (crypto as any).randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

/**
 * OSCAL 1.1 Assessment Results (JSON): one result per cluster, an observation
 * per control with its evidence, a finding per pass or fail, and waived
 * failures as risks with an approved deviation. Controls that couldn't be
 * checked stay observations only.
 */
export function complianceOscal(scans: ClusterScan[], silences: Silence[], framework: 'cis' | 'nsa', now: Date = new Date()): string {
  const results = scans.map(s => {
    const component = uuid();
    const observations: any[] = [];
    const findings: any[] = [];
    const risks: any[] = [];
    for (const r of s.compliance.filter(x => x.frameworks.includes(framework))) {
      const obs = uuid();
      observations.push({
        uuid: obs,
        title: r.id,
        description: r.title,
        methods: [r.method === 'manual' ? 'EXAMINE' : 'TEST'],
        types: ['finding'],
        subjects: [{ 'subject-uuid': component, type: 'component', title: s.clusterName }],
        'relevant-evidence': [{ description: r.evidence }],
        collected: s.at,
        props: [
          { name: 'result', value: r.status },
          { name: 'owner', value: r.owner },
          { name: 'reference', value: framework === 'nsa' ? r.nsa ?? r.ref : r.ref },
        ],
      });
      if (r.status !== 'pass' && r.status !== 'fail') continue;
      const w = r.status === 'fail' ? isWaived(silences, s.clusterKey, r.id) : undefined;
      const finding: any = {
        uuid: uuid(),
        title: `${r.id}: ${r.title}`,
        description: r.status === 'pass' ? r.evidence : r.remediation,
        target: { type: 'objective-id', 'target-id': r.id, status: { state: r.status === 'pass' ? 'satisfied' : 'not-satisfied' } },
        'related-observations': [{ 'observation-uuid': obs }],
      };
      if (w) {
        const risk = uuid();
        risks.push({ uuid: risk, title: `Accepted: ${r.id}`, description: w.reason, statement: r.evidence, status: 'deviation-approved', deadline: w.until });
        finding['related-risks'] = [{ 'risk-uuid': risk }];
      }
      findings.push(finding);
    }
    return {
      uuid: uuid(),
      title: `${s.clusterName} (${framework === 'nsa' ? 'NSA/CISA hardening' : 'CIS-aligned'})`,
      description: 'Checks evaluated through the Kubernetes API by the vks-fleet Headlamp plugin; node file permissions from kube-bench when a node scan was run.',
      start: s.at,
      end: s.at,
      'reviewed-controls': { 'control-selections': [{ 'include-all': {} }] },
      'local-definitions': { components: [{ uuid: component, type: 'service', title: s.clusterName, description: 'VKS cluster', status: { state: 'operational' } }] },
      observations,
      findings,
      ...(risks.length ? { risks } : {}),
    };
  });
  return JSON.stringify(
    {
      'assessment-results': {
        uuid: uuid(),
        metadata: {
          title: `VKS fleet compliance: ${framework === 'nsa' ? 'NSA/CISA Kubernetes hardening' : 'CIS-aligned'} checks`,
          'last-modified': now.toISOString(),
          version: '1',
          'oscal-version': '1.1.2',
          remarks: 'Not a certified assessment. Generated by the vks-fleet Headlamp plugin.',
        },
        'import-ap': { href: '#vks-fleet-assessment-plan' },
        results,
      },
    },
    null,
    2
  );
}
