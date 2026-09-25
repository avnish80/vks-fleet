/**
 * Issues: related findings and signals folded into one problem with its
 * cause, the evidence, what it affects and what to do. Rules come from real
 * incidents (a deletion stuck on a pinned pod and a volume; a node whose pod
 * networking stopped working). Anything no rule explains is passed through as
 * its own issue, so nothing is hidden.
 */
import { formatDuration, STUCK_AFTER_MS } from './capi/v1beta1';
import { fleetFindings } from './findings';
import { clusterDeepLink, clusterPath, headlampNodePath, machinePath } from './routes';
import { FleetCluster, Finding, Issue, Severity, SupervisorResult, WorkloadHealth } from './types';
import { ClusterPackages, isCorePackage, shortPackage } from './packages';
import { isPlatformNamespace } from './workload';

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const MIN_SANDBOX_ATTEMPTS = 5;

function base(c: FleetCluster, id: string, severity: Severity, now: Date): Omit<Issue, 'title' | 'cause' | 'fix'> {
  return {
    id: `${c.key}#${id}`,
    severity,
    supervisorId: c.supervisorId,
    clusterKey: c.key,
    clusterName: c.name,
    namespace: c.namespace,
    tenantName: c.tenantName,
    evidence: [],
    affected: { clusters: [c.name], tenants: [c.tenantName], nodes: [], pods: [] },
    links: [{ label: `Open ${c.name}`, path: clusterPath(c) }],
    findingIds: [],
    detectedAt: now.toISOString(),
  };
}

function reasonsSummary(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}: ${n}`)
    .join(', ');
}

function clusterIssues(c: FleetCluster, wl: WorkloadHealth | undefined, findings: Finding[], now: Date): Issue[] {
  const out: Issue[] = [];
  const mine = findings.filter(f => f.clusterKey === c.key);
  const podIssues = wl?.podIssues ?? [];
  const sandboxNodes = new Set((wl?.sandboxFailures ?? []).filter(s => s.attempts >= MIN_SANDBOX_ATTEMPTS).map(s => s.node));

  // Rule: a node whose pod networking fails. Explains the stuck pods on it.
  for (const s of wl?.sandboxFailures ?? []) {
    if (s.attempts < MIN_SANDBOX_ATTEMPTS) continue;
    const pods = podIssues.filter(p => p.node === s.node);
    const platformHit = pods.some(p => isPlatformNamespace(p.namespace));
    const machine = c.machines.find(m => m.nodeName === s.node || m.name === s.node);
    const issue: Issue = {
      ...base(c, `net-${s.node}`, platformHit ? 'critical' : 'warning', now),
      title: `Pods can't start on node ${s.node}: pod networking fails`,
      cause: s.error,
      fix:
        "Restart the network plugin's pods (CNI, Multus) on that node. If it keeps failing, cordon the node, delete the stuck pods so they reschedule elsewhere, and replace the node.",
    };
    issue.evidence.push(`${s.attempts} failed network setups for ${s.pods} pod${s.pods === 1 ? '' : 's'} in the last hour.`);
    if (pods.length) issue.evidence.push(`Stuck on this node: ${reasonsSummary(pods.map(p => p.reason))}.`);
    if (platformHit) issue.evidence.push('Platform pods are affected (for example DNS or sign-in), so the whole cluster can be impacted.');
    if (machine?.deletingSince) issue.evidence.push('The node is also being deleted.');
    issue.affected.nodes = [s.node];
    issue.affected.pods = pods.map(p => `${p.namespace}/${p.name}`);
    if (machine) issue.links.push({ label: `Machine ${machine.nodeName ?? machine.name}`, path: machinePath(c, machine.name) });
    issue.primary = machine
      ? { label: `Machine ${machine.nodeName ?? machine.name}`, path: machinePath(c, machine.name) }
      : { label: 'Inside the cluster', path: clusterDeepLink(c, { hash: 'inside' }) };
    if (wl?.contextName) issue.links.push({ label: 'Node in Headlamp', path: headlampNodePath(wl.contextName, s.node) });
    out.push(issue);
  }

  // Rule: a deletion that's stuck. Explains the machine finding and the repair count.
  for (const m of c.machines) {
    if (!m.deletingSince) continue;
    const age = now.getTime() - new Date(m.deletingSince).getTime();
    if (age < STUCK_AFTER_MS) continue;
    const label = m.nodeName ?? m.name;
    const pool = c.nodePools.find(p => p.name === m.pool);
    const issue: Issue = {
      ...base(c, `stuck-${m.name}`, 'warning', now),
      title: `Node ${label} has been stuck deleting for ${formatDuration(age)}`,
      cause:
        "Cluster API can't finish removing the node: usually a drain blocked by a PodDisruptionBudget or a pod pinned to the node, or a volume that won't detach.",
      fix: 'Open the machine to see the stage it is stuck in and which pods hold it. Fix those (unpin or scale down), or use Unblock deletion as a last resort, then clear the timeout.',
    };
    const podsHere = podIssues.filter(p => p.node === label);
    if (podsHere.length) issue.evidence.push(`Pods with problems on the node: ${reasonsSummary(podsHere.map(p => p.reason))}.`);
    if (sandboxNodes.has(label)) issue.evidence.push('Pod networking also fails on this node (see the related issue).');
    issue.evidence.push(
      pool?.nodeDrainTimeout || pool?.nodeVolumeDetachTimeout
        ? `Pool ${pool.name} timeouts: drain ${pool.nodeDrainTimeout ?? 'none'}, volume detach ${pool.nodeVolumeDetachTimeout ?? 'none'}.`
        : `Pool ${m.pool ?? '—'} has no drain or volume timeout, so Cluster API waits indefinitely.`
    );
    if (m.vm?.powerState) issue.evidence.push(`VM power state: ${m.vm.powerState}.`);
    issue.affected.nodes = [label];
    issue.affected.pods = podsHere.map(p => `${p.namespace}/${p.name}`);
    issue.links.unshift({ label: `Machine ${label}`, path: machinePath(c, m.name) });
    issue.primary = { label: `Machine ${label}`, path: machinePath(c, m.name) };
    issue.findingIds = mine
      .filter(f => (/#issue-/.test(f.id) && f.title.includes(label)) || /#mhc-repairing$/.test(f.id))
      .map(f => f.id);
    out.push(issue);
  }

  // Rule: automatic repair stopped.
  const blockedRepair = mine.find(f => /#mhc-blocked$/.test(f.id));
  if (blockedRepair) {
    const notReady = c.machines.filter(m => m.ready === false && !m.deletingSince).map(m => m.nodeName ?? m.name);
    const issue: Issue = {
      ...base(c, 'repair-stopped', 'critical', now),
      title: `Automatic node repair has stopped on ${c.name}`,
      cause: 'Too many nodes are unhealthy at once, so the health check stopped replacing them to avoid making things worse.',
      fix: blockedRepair.fix,
    };
    if (blockedRepair.detail) issue.evidence.push(blockedRepair.detail);
    if (notReady.length) issue.evidence.push(`Not ready: ${notReady.join(', ')}.`);
    issue.affected.nodes = notReady;
    issue.findingIds = [blockedRepair.id];
    issue.primary = { label: 'Machines', path: clusterDeepLink(c, { hash: 'machines' }) };
    out.push(issue);
  }

  // Rule: the cluster's API can't be reached from Headlamp.
  if (wl?.status === 'unreachable') {
    out.push({
      ...base(c, 'unreachable', 'warning', now),
      title: `Can't reach the API of ${c.name}`,
      cause: wl.error ?? 'Requests to the cluster time out or fail.',
      fix: "Check the control-plane VM and the cluster's load balancer IP. The Supervisor view still shows its machines.",
      primary: { label: 'Machines', path: clusterDeepLink(c, { hash: 'machines' }) },
    });
  } else if (wl?.status === 'expired') {
    out.push({
      ...base(c, 'signin', 'info', now),
      title: `Sign-in to ${c.name} has expired`,
      cause: 'The token from kubectl vsphere login has run out.',
      fix: 'Log in again on the machine running Headlamp and reload its kubeconfig.',
      primary: { label: 'Sign-in command', path: clusterDeepLink(c, { hash: 'inside' }) },
    });
  }

  // Rule: failing pods not explained by a network issue.
  const unexplained = podIssues.filter(p => !(p.node && sandboxNodes.has(p.node)));
  if (unexplained.length) {
    const platform = unexplained.filter(p => isPlatformNamespace(p.namespace));
    const issue: Issue = {
      ...base(c, 'pods', platform.length ? 'warning' : 'info', now),
      title: `${unexplained.length} pod${unexplained.length === 1 ? '' : 's'} failing in ${c.name}`,
      cause: reasonsSummary(unexplained.map(p => p.reason)),
      fix: 'Open the cluster in Headlamp and check the pods\' events and logs.',
    };
    if (platform.length) issue.evidence.push(`Platform pods among them: ${platform.map(p => `${p.namespace}/${p.name}`).slice(0, 5).join(', ')}.`);
    if (wl?.deploymentIssues.length) {
      issue.evidence.push(`Deployments not fully available: ${wl.deploymentIssues.map(d => `${d.namespace}/${d.name}`).slice(0, 5).join(', ')}.`);
    }
    issue.affected.pods = unexplained.map(p => `${p.namespace}/${p.name}`);
    issue.primary = { label: 'Pods with problems', path: clusterDeepLink(c, { hash: 'inside' }) };
    out.push(issue);
  }
  return out;
}

function serviceIssue(r: SupervisorResult, f: Finding, now: Date): Issue {
  const vks = (f.namespace ?? '').startsWith('svc-tkg');
  return {
    id: f.id,
    severity: vks ? 'critical' : f.severity,
    supervisorId: r.supervisor.id,
    namespace: f.namespace,
    title: f.title,
    cause: f.detail ?? f.title,
    evidence: vks ? ['This is the VKS service itself: cluster changes, upgrades and repairs on this Supervisor depend on it.'] : [],
    affected: {
      clusters: r.clusters.map(c => c.name),
      tenants: Array.from(new Set(r.clusters.map(c => c.tenantName))),
      nodes: [],
      pods: [],
    },
    fix: f.fix,
    primary: f.target ? { label: 'Open the service pods', path: f.target } : undefined,
    links: f.target ? [{ label: 'Service pods in Headlamp', path: f.target }] : [],
    findingIds: [f.id],
    detectedAt: now.toISOString(),
  };
}

function passthrough(f: Finding, clusters: Map<string, FleetCluster>, now: Date): Issue {
  const c = f.clusterKey ? clusters.get(f.clusterKey) : undefined;
  return {
    id: f.id,
    severity: f.severity,
    supervisorId: f.supervisorId,
    clusterKey: f.clusterKey,
    clusterName: f.clusterName,
    namespace: f.namespace,
    tenantName: f.tenantName,
    title: f.title,
    cause: f.detail ?? f.title,
    evidence: [],
    affected: { clusters: c ? [c.name] : [], tenants: f.tenantName ? [f.tenantName] : [], nodes: [], pods: [] },
    fix: f.fix,
    primary: f.target ? { label: 'Go to it', path: f.target } : undefined,
    links: c ? [{ label: `Open ${c.name}`, path: clusterPath(c) }] : f.target ? [{ label: 'Open', path: f.target }] : [],
    findingIds: [f.id],
    detectedAt: now.toISOString(),
  };
}

function packageIssue(c: FleetCluster, cp: ClusterPackages, now: Date): Issue | undefined {
  const failed = cp.items.filter(p => p.state === 'failed');
  if (!failed.length) return undefined;
  const core = failed.filter(p => isCorePackage(p.refName));
  const issue: Issue = {
    ...base(c, 'packages', core.length ? 'critical' : 'warning', now),
    title: `${failed.length} package${failed.length === 1 ? '' : 's'} failing to reconcile in ${c.name}: ${failed.map(p => shortPackage(p.refName)).join(', ')}`,
    cause: failed[0].message ?? 'kapp-controller reports the reconcile failed.',
    fix: "Open the package installs in Headlamp and read kapp-controller's error; common causes are image pulls, values that don't validate, or a repository that no longer offers the version.",
  };
  for (const p of failed) issue.evidence.push(`${p.namespace}/${p.name} (${p.version ?? 'no version'}): ${p.message ?? 'failed'}`);
  if (core.length) issue.evidence.push('Core platform packages are affected, so networking, storage or sign-in may be impacted.');
  issue.primary = { label: 'Packages', path: clusterDeepLink(c, { hash: 'packages' }) };
  return issue;
}

/** All issues for the fleet, most severe first. */
export function buildIssues(
  results: SupervisorResult[],
  workload: Map<string, WorkloadHealth>,
  now: Date = new Date(),
  packages?: Map<string, ClusterPackages>
): Issue[] {
  const findings = fleetFindings(results, now);
  const clusters = new Map(results.flatMap(r => r.clusters).map(c => [c.key, c]));
  const issues: Issue[] = [];
  for (const c of clusters.values()) {
    issues.push(...clusterIssues(c, workload.get(c.key), findings, now));
    const cp = packages?.get(c.key);
    const pi = cp ? packageIssue(c, cp, now) : undefined;
    if (pi) issues.push(pi);
  }
  const explained = new Set(issues.flatMap(i => i.findingIds));
  for (const r of results) {
    for (const f of findings.filter(x => x.supervisorId === r.supervisor.id && /#svc-(?!leftovers)/.test(x.id))) {
      issues.push(serviceIssue(r, f, now));
      explained.add(f.id);
    }
  }
  for (const f of findings) if (!explained.has(f.id)) issues.push(passthrough(f, clusters, now));
  return issues.sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || (a.clusterName ?? '').localeCompare(b.clusterName ?? '')
  );
}

export function countIssues(issues: Issue[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
  for (const i of issues) out[i.severity] += 1;
  return out;
}

/** A Markdown write-up of the issue, for a ticket, a chat, or an AI assistant. */
export function diagnosisMarkdown(issue: Issue, c?: FleetCluster, supervisorName?: string): string {
  const lines: string[] = [];
  lines.push(`## ${issue.title}`, '');
  lines.push(`- Severity: ${issue.severity}`);
  if (c) {
    lines.push(`- Cluster: ${c.name} (namespace ${c.namespace}, Supervisor ${supervisorName ?? c.supervisorId})`);
    lines.push(`- Tenant: ${c.tenantName}${c.tenantNamed ? ` (${c.tenantId})` : ''}`);
    lines.push(`- Kubernetes: ${c.kubernetesVersion ?? 'unknown'}, class ${c.clusterClass ?? 'unknown'}`);
    lines.push(
      `- Nodes: control plane ${c.controlPlane ? `${c.controlPlane.ready}/${c.controlPlane.desired}` : '?'}, workers ${
        c.workers ? `${c.workers.ready}/${c.workers.desired}` : '?'
      }`
    );
  } else if (supervisorName) {
    lines.push(`- Supervisor: ${supervisorName}`);
  }
  lines.push(`- Detected: ${issue.detectedAt}`, '');
  lines.push('### Cause', '', issue.cause, '');
  if (issue.evidence.length) {
    lines.push('### Evidence', '');
    for (const e of issue.evidence) lines.push(`- ${e}`);
    lines.push('');
  }
  const a = issue.affected;
  if (a.clusters.length || a.nodes.length || a.pods.length) {
    lines.push('### Affected', '');
    if (a.clusters.length) lines.push(`- Clusters: ${a.clusters.join(', ')}`);
    if (a.tenants.length) lines.push(`- Tenants: ${a.tenants.join(', ')}`);
    if (a.nodes.length) lines.push(`- Nodes: ${a.nodes.join(', ')}`);
    if (a.pods.length) lines.push(`- Pods (${a.pods.length}): ${a.pods.slice(0, 20).join(', ')}${a.pods.length > 20 ? ', …' : ''}`);
    lines.push('');
  }
  lines.push('### Suggested fix', '', issue.fix, '');
  if (c?.issues.length) {
    lines.push('### Supervisor observations', '');
    for (const i of c.issues) lines.push(`- ${i}`);
    lines.push('');
  }
  lines.push('_Generated by the vks-fleet Headlamp plugin._');
  return lines.join('\n');
}
