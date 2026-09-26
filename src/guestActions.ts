/**
 * Actions inside a VKS cluster (sent through that cluster's own context):
 * Pod Security levels, default-deny network policies, and Carvel package
 * updates, pause/resume and reconcile. Same shape as the Supervisor actions:
 * checks first, then the exact writes, which run as a dry run first.
 */
import { ActionPlan, Check } from './actions';
import { NamespacePosture } from './clusterScan';
import { PackageInstallInfo } from './packages';
import { PssLevel } from './pss';

const MERGE = 'application/merge-patch+json';

export function podSecurityPlan(cluster: string, ns: NamespacePosture, level: PssLevel, mode: 'enforce' | 'warn'): ActionPlan {
  const refused = ns.refused[level];
  const checks: Check[] = [];
  if (mode === 'enforce' && refused.length) {
    checks.push({
      level: 'warn',
      text: `${refused.length} running pod${refused.length === 1 ? '' : 's'} would be refused when recreated: ${refused
        .slice(0, 4)
        .map(r => `${r.pod} (${r.reasons.slice(0, 2).join(', ')})`)
        .join('; ')}${refused.length > 4 ? '; …' : ''}. Running pods keep running.`,
    });
  } else if (mode === 'enforce') {
    checks.push({ level: 'ok', text: `Every running pod in ${ns.name} already meets "${level}".` });
  }
  if (mode === 'warn') checks.push({ level: 'ok', text: 'Warn and audit only: nothing is refused; users see warnings when they create pods that break the level.' });
  if (ns.enforce === level && mode === 'enforce') checks.push({ level: 'block', text: `${ns.name} already enforces "${level}".` });
  const labels =
    mode === 'enforce'
      ? { 'pod-security.kubernetes.io/enforce': level, 'pod-security.kubernetes.io/enforce-version': 'latest' }
      : { 'pod-security.kubernetes.io/warn': level, 'pod-security.kubernetes.io/audit': level };
  return {
    id: `psa#${cluster}#${ns.name}#${level}#${mode}`,
    title: `${mode === 'enforce' ? 'Enforce' : 'Warn about'} "${level}" in ${ns.name}`,
    summary: `Labels namespace ${ns.name} in ${cluster} with Pod Security ${mode === 'enforce' ? 'enforce' : 'warn and audit'} = ${level}.`,
    checks,
    reasonRequired: mode === 'enforce',
    confirmText: mode === 'enforce' ? ns.name : undefined,
    applyLabel: mode === 'enforce' ? 'Enforce' : 'Start warning',
    requests: () => [{ method: 'PATCH', path: `/api/v1/namespaces/${encodeURIComponent(ns.name)}`, contentType: MERGE, body: { metadata: { labels } } }],
  };
}

export function defaultDenyPlan(cluster: string, ns: NamespacePosture, variant: 'other-namespaces' | 'all'): ActionPlan {
  const checks: Check[] = [];
  if (ns.exposed.length) {
    checks.push({
      level: 'warn',
      text: `${ns.exposed.join(', ')} ${ns.exposed.length === 1 ? 'is' : 'are'} reached from outside; load balancer traffic arrives from nodes, so check they still answer afterwards.`,
    });
  }
  checks.push({
    level: 'warn',
    text:
      variant === 'all'
        ? 'Denies all incoming traffic to every pod here, including from the same namespace. Add allow policies for what should get through.'
        : 'Pods in other namespaces (including an ingress controller) can no longer reach pods here; pods within the namespace still can.',
  });
  checks.push({ level: 'ok', text: 'Outgoing traffic is not affected. Remove the policy to undo.' });
  const name = variant === 'all' ? 'vks-fleet-default-deny-ingress' : 'vks-fleet-deny-from-other-namespaces';
  return {
    id: `netpol#${cluster}#${ns.name}#${variant}`,
    title: variant === 'all' ? `Deny all incoming traffic in ${ns.name}` : `Deny traffic from other namespaces into ${ns.name}`,
    summary: `Creates NetworkPolicy ${name} in ${ns.name} (${cluster}).`,
    checks,
    reasonRequired: true,
    confirmText: ns.name,
    applyLabel: 'Create policy',
    requests: () => [
      {
        method: 'POST',
        path: `/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns.name)}/networkpolicies`,
        contentType: 'application/json',
        body: {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: { name, namespace: ns.name, labels: { 'app.kubernetes.io/managed-by': 'vks-fleet' } },
          spec: { podSelector: {}, policyTypes: ['Ingress'], ...(variant === 'all' ? {} : { ingress: [{ from: [{ podSelector: {} }] }] }) },
        },
      },
    ],
  };
}

const pkgiUrl = (p: PackageInstallInfo) =>
  `/apis/packaging.carvel.dev/v1alpha1/namespaces/${encodeURIComponent(p.namespace)}/packageinstalls/${encodeURIComponent(p.name)}`;

function managedBlock(p: PackageInstallInfo): Check[] {
  return p.managedByVks
    ? [{ level: 'block', text: `${p.refName} is managed by VKS; it changes with the cluster's Kubernetes release (use Upgrade instead).` }]
    : [];
}

export function packageVersionPlan(cluster: string, p: PackageInstallInfo, version: string): ActionPlan {
  const checks = managedBlock(p);
  if (p.version === version) checks.push({ level: 'block', text: `${p.refName} is already at ${version}.` });
  if (p.paused) checks.push({ level: 'warn', text: 'The install is paused; the new version applies once it is resumed.' });
  checks.push({ level: 'ok', text: 'kapp-controller rolls the package to the new version; its resources update in place.' });
  return {
    id: `pkg#${cluster}#${p.namespace}/${p.name}#${version}`,
    title: `Update ${p.refName} in ${cluster}`,
    summary: `${p.version ?? '?'} → ${version} (PackageInstall ${p.namespace}/${p.name}).`,
    checks,
    reasonRequired: true,
    applyLabel: 'Update',
    requests: () => [{ method: 'PATCH', path: pkgiUrl(p), contentType: MERGE, body: { spec: { packageRef: { versionSelection: { constraints: version } } } } }],
  };
}

export function packagePausePlan(cluster: string, p: PackageInstallInfo, paused: boolean): ActionPlan {
  const checks = managedBlock(p);
  if (!!p.paused === paused) checks.push({ level: 'block', text: `Already ${paused ? 'paused' : 'running'}.` });
  if (paused) checks.push({ level: 'warn', text: 'While paused, kapp-controller does not repair drift or apply updates for this package.' });
  return {
    id: `pkg#${cluster}#${p.namespace}/${p.name}#pause-${paused}`,
    title: `${paused ? 'Pause' : 'Resume'} ${p.refName} in ${cluster}`,
    summary: `Sets spec.paused to ${paused} on PackageInstall ${p.namespace}/${p.name}.`,
    checks,
    reasonRequired: paused,
    applyLabel: paused ? 'Pause' : 'Resume',
    requests: () => [{ method: 'PATCH', path: pkgiUrl(p), contentType: MERGE, body: { spec: { paused } } }],
  };
}

/** Reconcile now: pause then resume, as `kctrl package installed kick` does. */
export function packageKickPlan(cluster: string, p: PackageInstallInfo): ActionPlan {
  const checks = managedBlock(p);
  if (p.paused) checks.push({ level: 'block', text: 'The install is paused; resume it instead.' });
  checks.push({ level: 'ok', text: 'kapp-controller reconciles the package straight away instead of at its next sync.' });
  return {
    id: `pkg#${cluster}#${p.namespace}/${p.name}#kick`,
    title: `Reconcile ${p.refName} in ${cluster} now`,
    summary: 'Pauses and resumes the PackageInstall, which triggers an immediate reconcile.',
    checks,
    reasonRequired: false,
    applyLabel: 'Reconcile now',
    requests: () => [
      { method: 'PATCH', path: pkgiUrl(p), contentType: MERGE, body: { spec: { paused: true } } },
      { method: 'PATCH', path: pkgiUrl(p), contentType: MERGE, body: { spec: { paused: false } } },
    ],
  };
}
