/** Issues from the in-cluster scan: security posture, GitOps, and image drift across clusters. */
import { ClusterScan, groupApps, SecurityFinding } from './clusterScan';
import { clusterDeepLink } from './routes';
import { FleetCluster, Issue } from './types';

export const APPS_PATH = '/vks-fleet/apps';
export const SECURITY_PATH = '/vks-fleet/security';

/** The issue id a security finding becomes (silences match on it). */
export const securityIssueId = (clusterKey: string, f: Pick<SecurityFinding, 'kind' | 'title'>) => `${clusterKey}#scan#sec-${f.kind}-${f.title}`;

function base(c: FleetCluster | undefined, supervisorId: string, id: string, severity: Issue['severity'], now: Date): Issue {
  return {
    id: `${c?.key ?? supervisorId}#scan#${id}`,
    severity,
    supervisorId,
    clusterKey: c?.key,
    clusterName: c?.name,
    namespace: c?.namespace,
    title: '',
    cause: '',
    evidence: [],
    affected: { clusters: c ? [c.name] : [], tenants: c ? [c.tenantName] : [], nodes: [], pods: [] },
    fix: '',
    links: [],
    findingIds: [],
    detectedAt: now.toISOString(),
  };
}

const RUNBOOK: Record<string, (ctx: string, objects: string[]) => Issue['runbook']> = {
  privileged: (ctx, objs) => [
    { title: 'What the pod asks for', commands: [`kubectl --context ${ctx} get pod -n ${objs[0]?.split('/')[0]} ${objs[0]?.split('/')[1]} -o jsonpath='{.spec.hostNetwork} {.spec.hostPID} {.spec.containers[*].securityContext}{"\\n"}'`] },
    { title: 'Enforce a Pod Security level on the namespace (baseline blocks privileged pods)', commands: [`kubectl --context ${ctx} label namespace ${objs[0]?.split('/')[0]} pod-security.kubernetes.io/enforce=baseline --overwrite --dry-run=server`] },
  ],
  psa: (ctx, objs) => [
    { title: 'Try a level first (server dry run shows which pods would be refused)', commands: [`kubectl --context ${ctx} label namespace ${objs[0]} pod-security.kubernetes.io/enforce=baseline --overwrite --dry-run=server`] },
  ],
  'cluster-admin': ctx => [
    { title: 'Who has cluster-admin', commands: [`kubectl --context ${ctx} get clusterrolebindings -o wide | grep cluster-admin`] },
    { title: 'Replace with a namespaced role (example)', commands: [`kubectl --context ${ctx} create rolebinding <name> -n <namespace> --clusterrole=admin --user=<user>`] },
  ],
  registry: ctx => [{ title: 'Images in use, by registry', commands: [`kubectl --context ${ctx} get pods -A -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\\n"}{end}' | tr ' ' '\\n' | sort | uniq -c | sort -rn | head -30`] }],
  wildcard: ctx => [{ title: 'Cluster roles with verbs * on resources *', commands: [`kubectl --context ${ctx} get clusterroles -o json | jq -r '.items[] | select(any(.rules[]?; (.verbs|index("*")) and (.resources|index("*")))) | .metadata.name'`] }],
  secrets: ctx => [{ title: 'Who can list Secrets in all namespaces', commands: [`kubectl --context ${ctx} get clusterrolebindings -o wide | grep -v system:`, `kubectl --context ${ctx} auth can-i list secrets -A --as=<user>`] }],
  netpol: (ctx, objs) => [
    { title: 'Try a default-deny first (server dry run)', commands: [`kubectl --context ${ctx} -n ${objs[0]} create -f - --dry-run=server <<'EOF'\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: deny-from-other-namespaces}\nspec: {podSelector: {}, policyTypes: [Ingress], ingress: [{from: [{podSelector: {}}]}]}\nEOF`] },
  ],
  exposed: ctx => [{ title: 'Services reachable from outside', commands: [`kubectl --context ${ctx} get svc -A --field-selector spec.type=LoadBalancer`, `kubectl --context ${ctx} get svc -A --field-selector spec.type=NodePort`] }],
  root: (ctx, objs) => [{ title: 'Which user the pod runs as', commands: [`kubectl --context ${ctx} exec -n ${objs[0]?.split('/')[0]} ${objs[0]?.split('/')[1]} -- id`] }],
  cert: (ctx, objs) => [
    { title: 'Certificate status', commands: [`kubectl --context ${ctx} describe certificate -n ${objs[0]?.split('/')[0]} ${objs[0]?.split('/')[1]} | tail -25`] },
    { title: 'Its issuer and recent requests', commands: [`kubectl --context ${ctx} get certificaterequests,orders,challenges -n ${objs[0]?.split('/')[0]} 2>/dev/null | tail -10`] },
  ],
};

export function scanIssues(scans: ClusterScan[], clusters: FleetCluster[], now: Date = new Date()): Issue[] {
  const out: Issue[] = [];
  const byKey = new Map(clusters.map(c => [c.key, c]));
  for (const s of scans) {
    const c = byKey.get(s.clusterKey);
    if (!c) continue;
    for (const f of s.security) {
      out.push({
        ...base(c, c.supervisorId, `sec-${f.kind}-${f.title}`, f.severity, now),
        id: securityIssueId(c.key, f),
        title: `${f.title} in ${c.name}`,
        cause: f.detail,
        evidence: f.objects.slice(0, 6).concat(f.objects.length > 6 ? [`…and ${f.objects.length - 6} more`] : []),
        fix: f.kind === 'latest' ? 'Pin images to a version (or digest).' : f.kind === 'psa' ? 'Set a Pod Security level (baseline or restricted) on each namespace.' : 'See the runbook.',
        primary: { label: 'Security', path: SECURITY_PATH },
        runbook: RUNBOOK[f.kind]?.(s.contextName, f.objects),
      });
    }
    for (const g of s.gitops) {
      if (g.suspended) continue;
      const bad = g.tool === 'Argo CD' ? g.health === 'Degraded' || g.health === 'Missing' : g.ready === false;
      const drifted = g.tool === 'Argo CD' && g.sync === 'OutOfSync' && !bad;
      if (!bad && !drifted) continue;
      out.push({
        ...base(c, c.supervisorId, `gitops-${g.tool}-${g.namespace}/${g.name}`, bad ? 'warning' : 'info', now),
        title: `${g.tool} ${g.kind} ${g.name} ${bad ? (g.tool === 'Argo CD' ? `is ${g.health}` : 'failed') : 'is out of sync'} in ${c.name}`,
        cause: g.message ?? (bad ? 'The last sync or reconcile did not succeed.' : 'The cluster differs from Git.'),
        fix: bad ? 'Read the sync or reconcile message and fix the manifests or the cluster state it points at.' : 'Sync it, or check whether someone changed the cluster by hand.',
        primary: { label: 'Applications', path: `${APPS_PATH}#gitops` },
        runbook:
          g.tool === 'Argo CD'
            ? [{ title: 'Application status', commands: [`kubectl --context ${s.contextName} get application -n ${g.namespace} ${g.name} -o jsonpath='{.status.sync.status} {.status.health.status}{"\\n"}{.status.operationState.message}{"\\n"}'`] }]
            : [{ title: 'Reconcile status', commands: [`kubectl --context ${s.contextName} describe ${g.kind.toLowerCase()} -n ${g.namespace} ${g.name} | tail -20`] }],
      });
    }
  }
  // Image drift: the same app on different image versions in different clusters.
  for (const app of groupApps(scans.flatMap(s => s.workloads))) {
    if (app.clusters.length < 2 || !app.drift.length) continue;
    const first = clusters.find(c => app.workloads.some(w => w.clusterKey === c.key));
    out.push({
      ...base(undefined, first?.supervisorId ?? '', `drift-${app.app}`, 'info', now),
      title: `App ${app.app} runs different image versions across clusters`,
      cause: app.drift.map(d => `${d.repo}: ${d.tags.join(', ')}`).join('; '),
      evidence: app.workloads.map(w => `${w.clusterName}: ${w.namespace}/${w.name} → ${w.images.join(', ')}`).slice(0, 8),
      affected: { clusters: app.clusters, tenants: [], nodes: [], pods: [] },
      fix: 'Intended (a staged rollout)? Fine. Otherwise bring the clusters to the same version.',
      primary: { label: 'Applications', path: APPS_PATH },
    });
  }
  return out;
}

export const clusterAppsLink = (c: FleetCluster) => clusterDeepLink(c, { hash: 'inside' });
