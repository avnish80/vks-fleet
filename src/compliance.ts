/**
 * CIS-aligned checks for VKS clusters, from what the Kubernetes API shows:
 *  - control-plane flags, read from the static pods' command lines;
 *  - each kubelet's live configuration (nodes/<n>/proxy/configz);
 *  - RBAC, Pod Security, network policies, service accounts and workloads.
 * File-permission checks need a node-level scan and are listed as such, never
 * as passed. Titles are our own; "ref" names the CIS Kubernetes Benchmark
 * section each control aligns with. This is not a certified CIS assessment.
 */
import { isPlatformNamespace } from './workload';

export type Owner = 'vks' | 'you' | 'shared';
export type CheckMethod = 'api' | 'node-scan' | 'manual';
export type ControlStatus = 'pass' | 'fail' | 'review' | 'unknown' | 'node-scan';

export interface ControlResult {
  id: string;
  ref: string;
  section: string;
  title: string;
  level: 1 | 2;
  owner: Owner;
  method: CheckMethod;
  status: ControlStatus;
  evidence: string;
  remediation: string;
}

export type Flags = Map<string, string>;

export interface ComplianceEvidence {
  apiserver?: Flags;
  controllerManager?: Flags;
  scheduler?: Flags;
  etcd?: Flags;
  /** Kubelet configs by node (from configz), when readable. */
  kubelets: Array<{ node: string; config: any }>;
  pods: any[];
  namespaces: any[];
  networkPolicies: any[];
  clusterRoles: any[];
  clusterRoleBindings: any[];
  serviceAccounts: any[];
  /** Lists that couldn't be read (so checks relying on them are "not readable", never passed). */
  unreadable?: Array<'pods' | 'namespaces' | 'networkPolicies' | 'clusterRoles' | 'clusterRoleBindings' | 'serviceAccounts'>;
}

const cannot = (e: ComplianceEvidence, what: NonNullable<ComplianceEvidence['unreadable']>[number]) => (e.unreadable ?? []).includes(what);

/** "--a=b" and "--c" style arguments into a map (bare flags become "true"). */
export function parseFlags(args: string[] | undefined): Flags {
  const m: Flags = new Map();
  for (const a of args ?? []) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');
    m.set(i > 0 ? a.slice(2, i) : a.slice(2), i > 0 ? a.slice(i + 1) : 'true');
  }
  return m;
}

/** Flags of a control-plane component from its static pod (kubeadm labels component=<name>). */
export function componentFlags(pods: any[], component: string): Flags | undefined {
  const pod = pods.find(
    p => p?.metadata?.namespace === 'kube-system' && (p?.metadata?.labels?.component === component || String(p?.metadata?.name ?? '').startsWith(`${component}-`))
  );
  const c = pod?.spec?.containers?.find((x: any) => x?.name === component) ?? pod?.spec?.containers?.[0];
  return c ? parseFlags([...(c.command ?? []), ...(c.args ?? [])]) : undefined;
}

type Eval = (e: ComplianceEvidence) => { status: ControlStatus; evidence: string };

interface ControlDef {
  id: string;
  ref: string;
  section: string;
  title: string;
  level: 1 | 2;
  owner: Owner;
  method: CheckMethod;
  remediation: string;
  evaluate?: Eval;
}

const pass = (evidence: string) => ({ status: 'pass' as const, evidence });
const fail = (evidence: string) => ({ status: 'fail' as const, evidence });
const review = (evidence: string) => ({ status: 'review' as const, evidence });
const unknown = (evidence: string) => ({ status: 'unknown' as const, evidence });

/** A flag check on one component: missing component → unknown. */
function flag(
  pick: (e: ComplianceEvidence) => Flags | undefined,
  component: string,
  test: (f: Flags) => boolean,
  describe: (f: Flags) => string
): Eval {
  return e => {
    const f = pick(e);
    if (!f) return unknown(`${component} static pod not readable (needs read access to kube-system).`);
    return test(f) ? pass(describe(f)) : fail(describe(f));
  };
}

const show = (f: Flags, name: string) => (f.has(name) ? `--${name}=${f.get(name)}` : `--${name} not set`);
const api = (e: ComplianceEvidence) => e.apiserver;
const cm = (e: ComplianceEvidence) => e.controllerManager;
const sch = (e: ComplianceEvidence) => e.scheduler;
const etcd = (e: ComplianceEvidence) => e.etcd;
const list = (f: Flags, n: string) => (f.get(n) ?? '').split(',').map(x => x.trim()).filter(Boolean);
const atLeast = (f: Flags, n: string, min: number) => Number(f.get(n)) >= min;

/** A kubelet check across the nodes whose config could be read. */
function kubelet(test: (c: any) => boolean, describe: (c: any) => string): Eval {
  return e => {
    if (!e.kubelets.length) return unknown('No kubelet configuration readable (needs the nodes/proxy permission).');
    const bad = e.kubelets.filter(k => !test(k.config));
    return bad.length
      ? fail(`${bad.length} of ${e.kubelets.length} nodes: ${bad.slice(0, 3).map(k => `${k.node} (${describe(k.config)})`).join('; ')}`)
      : pass(`All ${e.kubelets.length} nodes checked: ${describe(e.kubelets[0].config)}`);
  };
}

const userPods = (e: ComplianceEvidence) =>
  e.pods.filter(p => !isPlatformNamespace(p?.metadata?.namespace ?? '') && p?.status?.phase !== 'Succeeded' && p?.status?.phase !== 'Failed');
const containers = (p: any) => [...(p?.spec?.containers ?? []), ...(p?.spec?.initContainers ?? [])];
const podName = (p: any) => `${p.metadata.namespace}/${p.metadata.name}`;

function pods(test: (p: any) => boolean, what: string): Eval {
  return e => {
    if (cannot(e, 'pods')) return unknown('Pods not readable.');
    const bad = userPods(e).filter(test);
    return bad.length
      ? fail(`Pods that ${what} (${bad.length}): ${bad.slice(0, 4).map(podName).join(', ')}${bad.length > 4 ? '…' : ''}`)
      : pass(`No user pods ${what}.`);
  };
}

const SYSTEM = /^system:|^vmware-system|^kube-|^wcp:/;
const humanSubjects = (b: any) =>
  (b?.subjects ?? []).filter((s: any) => !SYSTEM.test(String(s?.name ?? '')) && !(s?.kind === 'ServiceAccount' && isPlatformNamespace(s?.namespace ?? '')));

function rbac(match: (rule: any) => boolean, what: string, level: 'fail' | 'review' = 'review'): Eval {
  return e => {
    if (cannot(e, 'clusterRoleBindings') || !e.clusterRoleBindings.length) return unknown('Cluster role bindings not readable.');
    if (cannot(e, 'clusterRoles')) return unknown('Cluster roles not readable.');
    const roles = new Map(e.clusterRoles.map(r => [r?.metadata?.name, r]));
    const hits = e.clusterRoleBindings
      .filter(b => b?.roleRef?.kind === 'ClusterRole' && !SYSTEM.test(b?.roleRef?.name ?? '') && (roles.get(b.roleRef.name)?.rules ?? []).some(match))
      .flatMap(b => humanSubjects(b).map((s: any) => `${s.kind} ${s.name} via ${b.roleRef.name}`));
    if (!hits.length) return pass(`No people or apps ${what}.`);
    const r = `People or apps who ${what} (${hits.length}): ${hits.slice(0, 3).join('; ')}${hits.length > 3 ? '…' : ''}`;
    return level === 'fail' ? fail(r) : review(r);
  };
}

const CONTROLS: ControlDef[] = [
  // ---- Control plane: file permissions (node scan)
  { id: 'CP-FILES', ref: 'CIS 1.1', section: 'Control plane', title: 'Control-plane config files have restrictive permissions and ownership', level: 1, owner: 'vks', method: 'node-scan', remediation: 'Checked by a node-level scan (kube-bench); set by the VKS node image.' },
  // ---- API server (CIS 1.2)
  { id: 'API-ANON', ref: 'CIS 1.2', section: 'API server', title: 'Anonymous requests are disabled (or tightly limited)', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS; if your policy requires it, raise it with VKS support.',
    evaluate: e => { const f = api(e); if (!f) return unknown('kube-apiserver static pod not readable.'); return f.get('anonymous-auth') === 'false' ? pass('--anonymous-auth=false') : review(`${show(f, 'anonymous-auth')} (defaults to true; anonymous access is limited to health endpoints by RBAC)`); } },
  { id: 'API-TOKENFILE', ref: 'CIS 1.2', section: 'API server', title: 'No static token file', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => !f.has('token-auth-file'), f => show(f, 'token-auth-file')) },
  { id: 'API-KUBELET-TLS', ref: 'CIS 1.2', section: 'API server', title: 'API server authenticates to kubelets with a client certificate', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.has('kubelet-client-certificate') && f.has('kubelet-client-key'), f => `${show(f, 'kubelet-client-certificate')}, ${f.has('kubelet-client-key') ? 'key set' : 'key not set'}`) },
  { id: 'API-KUBELET-CA', ref: 'CIS 1.2', section: 'API server', title: "API server verifies kubelets' serving certificates", level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.has('kubelet-certificate-authority'), f => show(f, 'kubelet-certificate-authority')) },
  { id: 'API-AUTHZ', ref: 'CIS 1.2', section: 'API server', title: 'Authorization uses Node and RBAC, never AlwaysAllow', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => { const m = list(f, 'authorization-mode'); return m.includes('Node') && m.includes('RBAC') && !m.includes('AlwaysAllow'); }, f => show(f, 'authorization-mode')) },
  { id: 'API-ADMIT-ALWAYS', ref: 'CIS 1.2', section: 'API server', title: 'AlwaysAdmit admission plugin is not enabled', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => !list(f, 'enable-admission-plugins').includes('AlwaysAdmit'), f => show(f, 'enable-admission-plugins')) },
  { id: 'API-ADMIT-NODE', ref: 'CIS 1.2', section: 'API server', title: 'NodeRestriction admission plugin is enabled', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => list(f, 'enable-admission-plugins').includes('NodeRestriction'), f => show(f, 'enable-admission-plugins')) },
  { id: 'API-PROFILING', ref: 'CIS 1.2', section: 'API server', title: 'Profiling endpoint is disabled', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.get('profiling') === 'false', f => show(f, 'profiling')) },
  { id: 'API-AUDIT', ref: 'CIS 1.2 / 3.2', section: 'Audit', title: 'API audit logging is on, with an audit policy', level: 1, owner: 'shared', method: 'api', remediation: "Audit logging comes from the cluster's VKS configuration; check the audit settings your VKS release offers.", evaluate: flag(api, 'kube-apiserver', f => (f.has('audit-log-path') || f.has('audit-webhook-config-file')) && f.has('audit-policy-file'), f => `${show(f, 'audit-log-path')}, ${show(f, 'audit-policy-file')}`) },
  { id: 'API-AUDIT-RETAIN', ref: 'CIS 1.2', section: 'Audit', title: 'Audit logs are retained (30 days, 10 files, 100 MB)', level: 1, owner: 'shared', method: 'api', remediation: 'Retention comes with the audit configuration; forwarding logs off the node also covers it.', evaluate: e => { const f = api(e); if (!f) return unknown('kube-apiserver static pod not readable.'); if (!f.has('audit-log-path')) return review('File-based audit log not configured (logs may be forwarded instead).'); const ok = atLeast(f, 'audit-log-maxage', 30) && atLeast(f, 'audit-log-maxbackup', 10) && atLeast(f, 'audit-log-maxsize', 100); const d = `maxage ${f.get('audit-log-maxage') ?? '-'}, maxbackup ${f.get('audit-log-maxbackup') ?? '-'}, maxsize ${f.get('audit-log-maxsize') ?? '-'}`; return ok ? pass(d) : fail(d); } },
  { id: 'API-SA-LOOKUP', ref: 'CIS 1.2', section: 'API server', title: 'Service account tokens are checked against existing accounts', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.get('service-account-lookup') !== 'false', f => show(f, 'service-account-lookup') + ' (default true)') },
  { id: 'API-ETCD-TLS', ref: 'CIS 1.2', section: 'API server', title: 'API server talks to etcd over TLS with client certificates', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.has('etcd-certfile') && f.has('etcd-keyfile') && f.has('etcd-cafile'), f => `${show(f, 'etcd-certfile')}, ${show(f, 'etcd-cafile')}`) },
  { id: 'API-TLS', ref: 'CIS 1.2', section: 'API server', title: 'API server serves TLS and verifies client certificates', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(api, 'kube-apiserver', f => f.has('tls-cert-file') && f.has('tls-private-key-file') && f.has('client-ca-file'), f => `${show(f, 'tls-cert-file')}, ${show(f, 'client-ca-file')}`) },
  { id: 'API-ENCRYPTION', ref: 'CIS 1.2', section: 'API server', title: 'Secrets are encrypted at rest in etcd', level: 1, owner: 'vks', method: 'api', remediation: 'Check the encryption settings your VKS release provides.', evaluate: flag(api, 'kube-apiserver', f => f.has('encryption-provider-config'), f => show(f, 'encryption-provider-config')) },
  // ---- Controller manager (CIS 1.3) and scheduler (CIS 1.4)
  { id: 'CM-PROFILING', ref: 'CIS 1.3', section: 'Controller manager', title: 'Profiling is disabled', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(cm, 'kube-controller-manager', f => f.get('profiling') === 'false', f => show(f, 'profiling')) },
  { id: 'CM-SA-CREDS', ref: 'CIS 1.3', section: 'Controller manager', title: 'Controllers use individual service account credentials', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(cm, 'kube-controller-manager', f => f.get('use-service-account-credentials') === 'true', f => show(f, 'use-service-account-credentials')) },
  { id: 'CM-SA-KEY', ref: 'CIS 1.3', section: 'Controller manager', title: 'Service account signing key and root CA are set', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(cm, 'kube-controller-manager', f => f.has('service-account-private-key-file') && f.has('root-ca-file'), f => `${show(f, 'service-account-private-key-file')}, ${show(f, 'root-ca-file')}`) },
  { id: 'CM-BIND', ref: 'CIS 1.3', section: 'Controller manager', title: 'Listens on localhost only', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(cm, 'kube-controller-manager', f => f.get('bind-address') === '127.0.0.1', f => show(f, 'bind-address')) },
  { id: 'SCH-PROFILING', ref: 'CIS 1.4', section: 'Scheduler', title: 'Profiling is disabled', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(sch, 'kube-scheduler', f => f.get('profiling') === 'false', f => show(f, 'profiling')) },
  { id: 'SCH-BIND', ref: 'CIS 1.4', section: 'Scheduler', title: 'Listens on localhost only', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(sch, 'kube-scheduler', f => f.get('bind-address') === '127.0.0.1', f => show(f, 'bind-address')) },
  // ---- etcd (CIS 2)
  { id: 'ETCD-TLS', ref: 'CIS 2', section: 'etcd', title: 'etcd serves TLS and requires client certificates', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(etcd, 'etcd', f => f.has('cert-file') && f.has('key-file') && f.get('client-cert-auth') === 'true' && f.get('auto-tls') !== 'true', f => `${show(f, 'client-cert-auth')}, ${show(f, 'auto-tls')}`) },
  { id: 'ETCD-PEER', ref: 'CIS 2', section: 'etcd', title: 'etcd peers use TLS with client certificates', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS.', evaluate: flag(etcd, 'etcd', f => f.has('peer-cert-file') && f.get('peer-client-cert-auth') === 'true' && f.get('peer-auto-tls') !== 'true', f => `${show(f, 'peer-client-cert-auth')}, ${show(f, 'peer-auto-tls')}`) },
  // ---- Worker nodes (CIS 4)
  { id: 'NODE-FILES', ref: 'CIS 4.1', section: 'Worker nodes', title: 'Kubelet config files have restrictive permissions and ownership', level: 1, owner: 'vks', method: 'node-scan', remediation: 'Checked by a node-level scan (kube-bench); set by the VKS node image.' },
  { id: 'KUBELET-ANON', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet rejects anonymous requests', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => c?.authentication?.anonymous?.enabled === false, c => `anonymous.enabled=${c?.authentication?.anonymous?.enabled}`) },
  { id: 'KUBELET-AUTHZ', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet authorizes requests through the API (Webhook)', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => c?.authorization?.mode === 'Webhook', c => `authorization.mode=${c?.authorization?.mode}`) },
  { id: 'KUBELET-CA', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet verifies client certificates', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => !!c?.authentication?.x509?.clientCAFile, c => `clientCAFile ${c?.authentication?.x509?.clientCAFile ? 'set' : 'not set'}`) },
  { id: 'KUBELET-RO', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet read-only port is off', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => !c?.readOnlyPort, c => `readOnlyPort=${c?.readOnlyPort ?? 0}`) },
  { id: 'KUBELET-STREAM', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Idle streaming connections time out', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => c?.streamingConnectionIdleTimeout !== '0s' && c?.streamingConnectionIdleTimeout !== 0, c => `streamingConnectionIdleTimeout=${c?.streamingConnectionIdleTimeout ?? 'default'}`) },
  { id: 'KUBELET-ROTATE', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet client certificates rotate', level: 1, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => c?.rotateCertificates !== false, c => `rotateCertificates=${c?.rotateCertificates ?? 'default'}`) },
  { id: 'KUBELET-KERNEL', ref: 'CIS 4.2', section: 'Worker nodes', title: 'Kubelet protects kernel defaults', level: 2, owner: 'vks', method: 'api', remediation: 'Managed by VKS (node image).', evaluate: kubelet(c => c?.protectKernelDefaults === true, c => `protectKernelDefaults=${c?.protectKernelDefaults ?? false}`) },
  // ---- RBAC and service accounts (CIS 5.1)
  { id: 'RBAC-ADMIN', ref: 'CIS 5.1', section: 'RBAC', title: 'cluster-admin is only granted where required', level: 1, owner: 'you', method: 'api', remediation: 'Replace cluster-admin grants with namespaced roles (the Security page lists them).', evaluate: e => { if (!e.clusterRoleBindings.length) return unknown('Cluster role bindings not readable.'); const hits = e.clusterRoleBindings.filter(b => b?.roleRef?.name === 'cluster-admin').flatMap(b => humanSubjects(b).map((s: any) => `${s.kind} ${s.name}`)); return hits.length ? review(`cluster-admin granted to: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? '…' : ''}`) : pass('Only system accounts hold cluster-admin.'); } },
  { id: 'RBAC-SECRETS', ref: 'CIS 5.1', section: 'RBAC', title: 'Reading Secrets cluster-wide is minimised', level: 1, owner: 'you', method: 'api', remediation: 'Scope Secret access to the namespaces that need it.', evaluate: rbac(r => ((r?.resources ?? []).includes('secrets') || (r?.resources ?? []).includes('*')) && (r?.verbs ?? []).some((v: string) => ['get', 'list', 'watch', '*'].includes(v)), 'can read every Secret') },
  { id: 'RBAC-WILDCARD', ref: 'CIS 5.1', section: 'RBAC', title: 'Wildcards in roles are minimised', level: 1, owner: 'you', method: 'api', remediation: 'List resources and verbs explicitly.', evaluate: rbac(r => (r?.verbs ?? []).includes('*') || (r?.resources ?? []).includes('*'), 'hold roles with wildcards') },
  { id: 'RBAC-PODCREATE', ref: 'CIS 5.1', section: 'RBAC', title: 'Creating pods cluster-wide is minimised', level: 1, owner: 'you', method: 'api', remediation: 'Grant pod creation per namespace.', evaluate: rbac(r => ((r?.resources ?? []).includes('pods') || (r?.resources ?? []).includes('*')) && (r?.verbs ?? []).some((v: string) => ['create', '*'].includes(v)), 'can create pods in every namespace') },
  { id: 'RBAC-ESCALATE', ref: 'CIS 5.1', section: 'RBAC', title: 'bind, escalate and impersonate are minimised', level: 1, owner: 'you', method: 'api', remediation: 'These let a holder grant themselves more; keep them to administrators.', evaluate: rbac(r => (r?.verbs ?? []).some((v: string) => ['bind', 'escalate', 'impersonate'].includes(v)), 'can bind, escalate or impersonate') },
  { id: 'RBAC-MASTERS', ref: 'CIS 5.1', section: 'RBAC', title: 'The system:masters group is not used', level: 1, owner: 'you', method: 'api', remediation: 'Remove bindings to system:masters; use RBAC roles.', evaluate: e => { if (!e.clusterRoleBindings.length) return unknown('Cluster role bindings not readable.'); const hits = e.clusterRoleBindings.filter(b => (b?.subjects ?? []).some((s: any) => s?.name === 'system:masters') && b?.metadata?.name !== 'cluster-admin'); return hits.length ? fail(`Bound in: ${hits.map(b => b.metadata.name).join(', ')}`) : pass('Only the built-in cluster-admin binding references system:masters.'); } },
  { id: 'SA-DEFAULT', ref: 'CIS 5.1', section: 'RBAC', title: "Default service accounts don't mount tokens automatically", level: 1, owner: 'you', method: 'api', remediation: 'Set automountServiceAccountToken: false on each namespace\'s default service account.', evaluate: e => { if (cannot(e, 'serviceAccounts') || !e.serviceAccounts.length) return unknown('Service accounts not readable.'); const bad = e.serviceAccounts.filter(s => s?.metadata?.name === 'default' && !isPlatformNamespace(s?.metadata?.namespace ?? '') && s?.automountServiceAccountToken !== false); return bad.length ? fail(`Namespaces whose default account mounts its token (${bad.length}): ${bad.slice(0, 5).map(s => s.metadata.namespace).join(', ')}`) : pass('Every user namespace\'s default service account opts out.'); } },
  // ---- Pod Security (CIS 5.2)
  { id: 'PSS-ADMISSION', ref: 'CIS 5.2', section: 'Pod Security', title: 'Every user namespace has a Pod Security level enforced', level: 1, owner: 'you', method: 'api', remediation: 'Use Pod Security… on the Security page (preview first, then enforce).', evaluate: e => { if (cannot(e, 'namespaces')) return unknown('Namespaces not readable.'); const ns = e.namespaces.filter(n => !isPlatformNamespace(n?.metadata?.name ?? '') && !['default', 'kube-public', 'kube-node-lease'].includes(n?.metadata?.name)); if (!ns.length) return pass('No user namespaces.'); const bad = ns.filter(n => { const l = n?.metadata?.labels?.['pod-security.kubernetes.io/enforce']; return !l || l === 'privileged'; }); return bad.length ? fail(`Namespaces without baseline or restricted (${bad.length}): ${bad.slice(0, 5).map(n => n.metadata.name).join(', ')}`) : pass(`All ${ns.length} user namespaces enforce baseline or restricted.`); } },
  { id: 'PSS-PRIV', ref: 'CIS 5.2', section: 'Pod Security', title: 'Privileged containers are not admitted', level: 1, owner: 'you', method: 'api', remediation: 'Enforce baseline in the namespace; rework the workload not to need privileged mode.', evaluate: pods(p => containers(p).some((c: any) => c?.securityContext?.privileged), 'run privileged') },
  { id: 'PSS-HOSTNS', ref: 'CIS 5.2', section: 'Pod Security', title: 'Host PID, IPC and network namespaces are not shared', level: 1, owner: 'you', method: 'api', remediation: 'Enforce baseline in the namespace.', evaluate: pods(p => !!(p?.spec?.hostPID || p?.spec?.hostIPC || p?.spec?.hostNetwork), 'share host namespaces') },
  { id: 'PSS-ESCALATION', ref: 'CIS 5.2', section: 'Pod Security', title: 'Privilege escalation is disallowed', level: 1, owner: 'you', method: 'api', remediation: 'Set allowPrivilegeEscalation: false (restricted enforces it).', evaluate: pods(p => containers(p).some((c: any) => c?.securityContext?.allowPrivilegeEscalation !== false), 'allow privilege escalation') },
  { id: 'PSS-ROOT', ref: 'CIS 5.2', section: 'Pod Security', title: 'Containers run as a non-root user', level: 2, owner: 'you', method: 'api', remediation: 'Set runAsNonRoot: true (restricted enforces it).', evaluate: pods(p => containers(p).some((c: any) => !(c?.securityContext?.runAsNonRoot === true || (p?.spec?.securityContext?.runAsNonRoot === true && c?.securityContext?.runAsNonRoot !== false))), 'may run as root') },
  { id: 'PSS-NETRAW', ref: 'CIS 5.2', section: 'Pod Security', title: 'NET_RAW and added capabilities are dropped', level: 1, owner: 'you', method: 'api', remediation: 'Drop ALL capabilities and add back only what is needed (restricted enforces it).', evaluate: pods(p => containers(p).some((c: any) => !(c?.securityContext?.capabilities?.drop ?? []).map((x: string) => String(x).toUpperCase()).some((x: string) => x === 'ALL' || x === 'NET_RAW')), "don't drop NET_RAW") },
  { id: 'PSS-HOSTPATH', ref: 'CIS 5.2', section: 'Pod Security', title: 'hostPath volumes are not used', level: 1, owner: 'you', method: 'api', remediation: 'Use persistent volumes instead (baseline enforces it).', evaluate: pods(p => (p?.spec?.volumes ?? []).some((v: any) => v?.hostPath), 'mount hostPath volumes') },
  { id: 'PSS-HOSTPORT', ref: 'CIS 5.2', section: 'Pod Security', title: 'Host ports are not used', level: 1, owner: 'you', method: 'api', remediation: 'Use a Service instead (baseline enforces it).', evaluate: pods(p => containers(p).some((c: any) => (c?.ports ?? []).some((x: any) => x?.hostPort)), 'bind host ports') },
  // ---- Network (CIS 5.3)
  { id: 'NET-CNI', ref: 'CIS 5.3', section: 'Network', title: 'The CNI enforces NetworkPolicies', level: 1, owner: 'vks', method: 'api', remediation: 'VKS ships Antrea or Calico, both of which enforce NetworkPolicies.', evaluate: e => { if (cannot(e, 'pods')) return unknown('Pods not readable.'); const cni = e.pods.find(p => /antrea|calico/.test(String(p?.metadata?.name ?? ''))); return cni ? pass(`CNI running: ${String(cni.metadata.name).replace(/-[a-z0-9]{5}$/, '')}`) : unknown('CNI pods not visible.'); } },
  { id: 'NET-POLICIES', ref: 'CIS 5.3', section: 'Network', title: 'Every namespace with workloads has a NetworkPolicy', level: 2, owner: 'you', method: 'api', remediation: 'Use Isolate or Deny all on the Security page, then add allow policies.', evaluate: e => { if (cannot(e, 'pods') || cannot(e, 'networkPolicies')) return unknown('Pods or network policies not readable.'); const withPods = new Set(userPods(e).map(p => p.metadata.namespace)); const withPol = new Set(e.networkPolicies.map(n => n?.metadata?.namespace)); const bad = Array.from(withPods).filter(n => !withPol.has(n)); return bad.length ? fail(`Namespaces with workloads but no policy (${bad.length}): ${bad.slice(0, 5).join(', ')}`) : pass(`All ${withPods.size} namespaces with workloads have one.`); } },
  // ---- Secrets (CIS 5.4)
  { id: 'SEC-ENV', ref: 'CIS 5.4', section: 'Secrets', title: 'Secrets are mounted as files, not environment variables', level: 2, owner: 'you', method: 'api', remediation: 'Mount Secrets as volumes; environment variables leak into logs and crash dumps.', evaluate: pods(p => containers(p).some((c: any) => (c?.env ?? []).some((v: any) => v?.valueFrom?.secretKeyRef) || (c?.envFrom ?? []).some((v: any) => v?.secretRef)), 'take Secrets as environment variables') },
  { id: 'SEC-EXTERNAL', ref: 'CIS 5.4', section: 'Secrets', title: 'An external secret store is considered', level: 2, owner: 'you', method: 'manual', remediation: 'For example Vault or External Secrets Operator; review with your security team.' },
  // ---- General (CIS 5.7)
  { id: 'GEN-SECCOMP', ref: 'CIS 5.7', section: 'General', title: 'Pods use the RuntimeDefault seccomp profile', level: 2, owner: 'you', method: 'api', remediation: 'Set seccompProfile: RuntimeDefault (restricted enforces it).', evaluate: pods(p => !(['RuntimeDefault', 'Localhost'].includes(p?.spec?.securityContext?.seccompProfile?.type) || containers(p).every((c: any) => ['RuntimeDefault', 'Localhost'].includes(c?.securityContext?.seccompProfile?.type))), 'run without a seccomp profile') },
  { id: 'GEN-DEFAULT-NS', ref: 'CIS 5.7', section: 'General', title: 'The default namespace is not used for workloads', level: 2, owner: 'you', method: 'api', remediation: 'Move workloads into their own namespaces.', evaluate: e => { if (cannot(e, 'pods')) return unknown('Pods not readable.'); const inDefault = e.pods.filter(p => p?.metadata?.namespace === 'default' && p?.status?.phase === 'Running'); return inDefault.length ? fail(`Pods running in default (${inDefault.length}): ${inDefault.slice(0, 4).map(p => p.metadata.name).join(', ')}`) : pass('Nothing runs in default.'); } },
  { id: 'GEN-BOUNDARIES', ref: 'CIS 5.7', section: 'General', title: 'Namespaces separate teams and applications', level: 1, owner: 'you', method: 'manual', remediation: 'Review with the application owners.' },
];

export const CONTROL_COUNT = CONTROLS.length;

export function evaluateCompliance(e: ComplianceEvidence): ControlResult[] {
  return CONTROLS.map(c => {
    const r = c.method === 'node-scan'
      ? { status: 'node-scan' as const, evidence: 'Needs a node-level scan (file permissions are not visible through the API).' }
      : c.method === 'manual' || !c.evaluate
      ? { status: 'review' as const, evidence: 'Needs a person to review.' }
      : c.evaluate(e);
    return { id: c.id, ref: c.ref, section: c.section, title: c.title, level: c.level, owner: c.owner, method: c.method, remediation: c.remediation, ...r };
  });
}

export interface ComplianceScore {
  pass: number;
  fail: number;
  review: number;
  unknown: number;
  nodeScan: number;
  /** pass / (pass + fail), as a percentage. */
  pct: number;
  /** Controls that produced a pass or fail, out of all. */
  scored: number;
  total: number;
}

export function scoreResults(results: ControlResult[]): ComplianceScore {
  const n = (s: ControlStatus) => results.filter(r => r.status === s).length;
  const p = n('pass');
  const f = n('fail');
  return {
    pass: p,
    fail: f,
    review: n('review'),
    unknown: n('unknown'),
    nodeScan: n('node-scan'),
    pct: p + f ? Math.round((p / (p + f)) * 100) : 0,
    scored: p + f,
    total: results.length,
  };
}

export const complianceIssueId = (clusterKey: string, controlId: string) => `${clusterKey}#compliance#${controlId}`;
