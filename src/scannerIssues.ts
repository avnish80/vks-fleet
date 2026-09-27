/** Issues from scanner reports: fixable critical CVEs, secrets baked into images, failing policies. */
import { ScannerReports } from './scanners';
import { Issue } from './types';

export const VULNS_PATH = '/vks-fleet/vulnerabilities';

export function scannerIssues(
  reports: ScannerReports[],
  clusters: Array<{ key: string; name: string; namespace: string; supervisorId: string; tenantName: string }>,
  now: Date = new Date()
): Issue[] {
  const out: Issue[] = [];
  for (const r of reports) {
    const c = clusters.find(x => x.key === r.clusterKey);
    if (!c) continue;
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
    // Your images: yours to rebuild. VKS images: fixed by VKS packages and releases (one summary).
    const critical = r.images.filter(i => i.owner === 'you' && i.counts.CRITICAL > 0);
    const fixable = critical.filter(i => i.top.some(v => v.severity === 'CRITICAL' && v.fixed));
    if (critical.length) {
      out.push({
        ...base,
        id: `${c.key}#vulns#critical`,
        severity: fixable.length ? 'warning' : 'info',
        title: `${critical.length} image${critical.length === 1 ? '' : 's'} with critical vulnerabilities in ${c.name} (${fixable.length} fixable)`,
        cause: 'From Trivy Operator vulnerability reports.',
        evidence: critical.slice(0, 6).map(i => `${i.image} in ${i.namespace}/${i.workload}: ${i.counts.CRITICAL} critical, ${i.counts.HIGH} high`),
        fix: 'Rebuild or update the images with fixes available (a newer base image usually resolves most).',
        primary: { label: 'Vulnerabilities', path: VULNS_PATH },
        runbook: [
          { title: 'Worst images in the cluster', commands: [`kubectl --context ${r.contextName} get vulnerabilityreports -A -o custom-columns=NS:.metadata.namespace,IMAGE:.report.artifact.repository,TAG:.report.artifact.tag,CRIT:.report.summary.criticalCount,HIGH:.report.summary.highCount --sort-by=.report.summary.criticalCount | tail -10`] },
        ],
      });
    }
    const vksCritical = r.images.filter(i => i.owner === 'vks' && i.counts.CRITICAL > 0);
    if (vksCritical.length) {
      const sources = Array.from(new Set(vksCritical.map(i => i.source ?? 'VKS platform')));
      const fixable = vksCritical.filter(i => i.top.some(v => v.severity === 'CRITICAL' && v.fixed)).length;
      out.push({
        ...base,
        id: `${c.key}#vulns#vks`,
        severity: 'info',
        title: `${vksCritical.length} VKS-managed image${vksCritical.length === 1 ? '' : 's'} with critical vulnerabilities in ${c.name} (${fixable} with fixes upstream)`,
        cause: `From ${sources.join(', ')}. These images are rebuilt by VKS, not by the cluster owner.`,
        evidence: vksCritical.slice(0, 6).map(i => `${i.namespace}/${i.workload}: ${i.counts.CRITICAL} critical`),
        fix: 'Check whether a newer VKS standard-packages version or VKS release is available (Packages and Upgrades pages), and whether the affected code paths are used.',
        primary: { label: 'Packages', path: '/vks-fleet/packages' },
      });
    }
    if (r.exposedSecrets.length) {
      out.push({
        ...base,
        id: `${c.key}#vulns#secrets`,
        severity: 'critical',
        title: `Secrets found inside ${r.exposedSecrets.length} image${r.exposedSecrets.length === 1 ? '' : 's'} in ${c.name}`,
        cause: 'Trivy Operator found credentials or keys baked into container images; anyone who can pull the image can read them.',
        evidence: r.exposedSecrets.slice(0, 5).map(x => `${x.image} (${x.workload}): ${x.count}`),
        fix: 'Rotate the exposed credentials, then rebuild the images without them (use Secrets or a vault at run time).',
        primary: { label: 'Vulnerabilities', path: VULNS_PATH },
      });
    }
    const failing = r.policy.filter(p => p.result === 'fail' || p.result === 'error');
    if (failing.length) {
      const byPolicy = new Map<string, number>();
      for (const p of failing) byPolicy.set(p.policy, (byPolicy.get(p.policy) ?? 0) + 1);
      out.push({
        ...base,
        id: `${c.key}#policy#fail`,
        severity: 'warning',
        title: `${failing.length} policy result${failing.length === 1 ? '' : 's'} failing in ${c.name} (${byPolicy.size} polic${byPolicy.size === 1 ? 'y' : 'ies'})`,
        cause: 'From PolicyReports (Kyverno or another policy engine).',
        evidence: Array.from(byPolicy.entries()).slice(0, 6).map(([p, n]) => `${p}: ${n}`),
        fix: 'Fix the resources the policies flag, or adjust the policies if they are too strict.',
        primary: { label: 'Compliance', path: '/vks-fleet/compliance#policy' },
      });
    }
  }
  return out;
}
