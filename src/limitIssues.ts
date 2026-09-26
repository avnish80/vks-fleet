/** Issues from namespace limits and org quotas (VCF Automation or vCenter). */
import { namespacePath } from './inventoryIssues';
import { Configured, NamespaceLimits, OrgQuota, overcommit } from './limits';
import { formatBytes } from './quantity';
import { Issue, SupervisorResult } from './types';

export const OVERCOMMIT_WARN = 2;
export const OVERCOMMIT_CRIT = 4;
export const ORG_ALLOCATION_WARN = 0.85;

export function limitIssues(
  results: SupervisorResult[],
  limits: Map<string, NamespaceLimits>,
  configured: Map<string, Configured>,
  orgQuotas: OrgQuota[],
  now: Date = new Date()
): Issue[] {
  const out: Issue[] = [];
  const supOf = new Map(results.flatMap(r => (r.namespaces ?? []).map(n => [n.name, r.supervisor.id] as [string, string])));
  for (const [ns, l] of limits) {
    const c = configured.get(ns);
    const ratio = c ? overcommit(c.memoryBytes, l.memoryLimitBytes) : undefined;
    if (!c || ratio === undefined || ratio < OVERCOMMIT_WARN || !l.memoryLimitBytes) continue;
    const sup = supOf.get(ns) ?? '';
    out.push({
      id: `${sup}#limits#mem-${ns}`,
      severity: ratio >= OVERCOMMIT_CRIT ? 'critical' : 'warning',
      supervisorId: sup,
      namespace: ns,
      title: `Memory in ${ns} is ${ratio.toFixed(1)}× overcommitted`,
      cause: `VMs here are configured with ${formatBytes(c.memoryBytes)}, but the namespace may use at most ${formatBytes(l.memoryLimitBytes)} (${
        l.source === 'vcfa' ? `VCF Automation, class ${l.className ?? '?'}` : 'vCenter resource-pool limit'
      }). Best-effort VMs are allowed to go over; under load they share the limit, so expect ballooning, swapping and slow nodes.`,
      evidence: [`Configured: ${c.vcpu} vCPU, ${formatBytes(c.memoryBytes)}`, `Memory limit: ${formatBytes(l.memoryLimitBytes)}`],
      affected: { clusters: [], tenants: [], nodes: [], pods: [] },
      fix:
        l.source === 'vcfa'
          ? "Raise the namespace's memory limit in VCF Automation (its class or an override), or run fewer or smaller nodes and VMs."
          : "Raise the namespace's memory limit in vCenter, or run fewer or smaller nodes and VMs.",
      primary: { label: 'Capacity', path: '/vks-fleet/capacity' },
      links: [{ label: 'Namespace', path: namespacePath(sup, ns) }],
      findingIds: [],
      detectedAt: now.toISOString(),
    });
  }
  for (const q of orgQuotas) {
    for (const st of q.storage) {
      const r = st.capacityBytes ? st.allocatedBytes / st.capacityBytes : 0;
      if (r < ORG_ALLOCATION_WARN) continue;
      out.push({
        id: `vcfa#org-quota#${q.org}/${st.storageClass}`,
        severity: r >= 0.95 ? 'critical' : 'warning',
        supervisorId: results[0]?.supervisor.id ?? '',
        title: `Org ${q.org} has allocated ${Math.round(r * 100)}% of its ${st.storageClass} quota`,
        cause: `${formatBytes(st.allocatedBytes)} of ${formatBytes(st.capacityBytes)} is handed out as namespace storage limits; new namespaces or larger limits will be refused.`,
        evidence: [],
        affected: { clusters: [], tenants: [q.org], nodes: [], pods: [] },
        fix: "Raise the org's region quota in VCF Automation, or lower namespace limits that aren't used.",
        primary: { label: 'Capacity', path: '/vks-fleet/capacity' },
        links: [],
        findingIds: [],
        detectedAt: now.toISOString(),
      });
    }
  }
  return out;
}
