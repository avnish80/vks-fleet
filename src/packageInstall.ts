/**
 * Installing and removing packages (Carvel) from the clusters' own
 * repositories, the way the VCF CLI does it: a service account with the
 * rights kapp-controller needs, the values in a Secret, and a PackageInstall
 * pointing at the package version.
 */
import { ActionPlan, Check } from './actions';
import { WriteRequest } from './api/client';
import { defaultInstallName, isCorePackage, PackageDefinition, PackageInstallInfo, shortPackage } from './packages';

const PKG = '/apis/packaging.carvel.dev/v1alpha1';
const MERGE_JSON = 'application/json';

/** Packages that usually need others first (VKS standard packages). A hint, not a rule. */
export const USUALLY_NEEDS: Record<string, string[]> = {
  contour: ['cert-manager'],
  harbor: ['cert-manager', 'contour'],
  prometheus: ['cert-manager'],
  grafana: ['cert-manager'],
  'external-dns': [],
};

export interface InstallInput {
  cluster: string;
  def: PackageDefinition;
  /** Where the PackageInstall goes (defaults to the package's own namespace). */
  namespace: string;
  name: string;
  /** values.yaml text (YAML or JSON), or empty for the package defaults. */
  values?: string;
  installed: PackageInstallInfo[];
  /** Versions this cluster's repositories offer for the package. */
  versionsHere: string[];
}

export const installNames = (name: string, ns: string) => ({
  sa: `${name}-${ns}-sa`,
  role: `${name}-${ns}-cluster-role`,
  binding: `${name}-${ns}-cluster-rolebinding`,
  secret: `${name}-${ns}-values`,
});

export function installPlan(i: InstallInput): ActionPlan {
  const { def, namespace: ns, name } = i;
  const n = installNames(name, ns);
  const checks: Check[] = [];
  const same = i.installed.find(p => p.refName === def.refName);
  if (same) checks.push({ level: 'block', text: `${def.refName} is already installed here (${same.namespace}/${same.name}, ${same.version ?? '?'}). Update it instead.` });
  if (i.installed.some(p => p.namespace === ns && p.name === name)) checks.push({ level: 'block', text: `A package install named ${ns}/${name} already exists.` });
  if (!i.versionsHere.includes(def.version)) checks.push({ level: 'block', text: `Version ${def.version} isn't in this cluster's repositories.` });
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 40)
    checks.push({ level: 'block', text: `The install name "${name}" isn't valid: use lowercase letters, digits and dashes, up to 40 characters (for example "${defaultInstallName(def.refName)}").` });
  if (ns !== def.namespace) {
    checks.push({ level: 'warn', text: `The package lives in ${def.namespace}; installing into ${ns} only works if the repository is global (kapp-controller's packaging-global namespace) and ${ns} exists.` });
  }
  const short = shortPackage(def.refName);
  const have = new Set(i.installed.map(p => shortPackage(p.refName)));
  const missing = (USUALLY_NEEDS[short] ?? []).filter(x => !have.has(x));
  if (missing.length) checks.push({ level: 'warn', text: `${short} usually needs ${missing.join(' and ')} installed first.` });
  checks.push({ level: 'ok', text: 'kapp-controller installs it with a dedicated service account that has cluster-wide rights, as the VCF CLI does.' });
  checks.push({ level: 'ok', text: i.values?.trim() ? 'Your values are stored in a Secret next to the install.' : 'The package defaults are used (no values given).' });
  const meta = (reason: string) => ({
    labels: { 'app.kubernetes.io/managed-by': 'vks-fleet', 'vks-fleet/package-install': name },
    annotations: reason ? { 'vks-fleet/reason': reason } : {},
  });
  return {
    id: `pkg-install#${i.cluster}#${ns}/${name}#${def.refName}@${def.version}#${(i.values ?? '').length}`,
    title: `Install ${def.refName} in ${i.cluster}`,
    summary: `${def.refName} ${def.version} as ${ns}/${name}.`,
    checks,
    reasonRequired: true,
    applyLabel: 'Install',
    requests: (reason: string): WriteRequest[] => {
      const m = meta(reason);
      return [
        { method: 'POST', path: `/api/v1/namespaces/${ns}/serviceaccounts`, contentType: MERGE_JSON, body: { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: n.sa, namespace: ns, ...m } } },
        {
          method: 'POST',
          path: '/apis/rbac.authorization.k8s.io/v1/clusterroles',
          contentType: MERGE_JSON,
          body: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name: n.role, ...m }, rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }] },
        },
        {
          method: 'POST',
          path: '/apis/rbac.authorization.k8s.io/v1/clusterrolebindings',
          contentType: MERGE_JSON,
          body: {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRoleBinding',
            metadata: { name: n.binding, ...m },
            roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: n.role },
            subjects: [{ kind: 'ServiceAccount', name: n.sa, namespace: ns }],
          },
        },
        ...(i.values?.trim()
          ? [{ method: 'POST' as const, path: `/api/v1/namespaces/${ns}/secrets`, contentType: MERGE_JSON, body: { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: n.secret, namespace: ns, ...m }, stringData: { 'values.yaml': i.values } } }]
          : []),
        {
          method: 'POST',
          path: `${PKG}/namespaces/${ns}/packageinstalls`,
          contentType: MERGE_JSON,
          body: {
            apiVersion: 'packaging.carvel.dev/v1alpha1',
            kind: 'PackageInstall',
            metadata: { name, namespace: ns, ...m },
            spec: {
              serviceAccountName: n.sa,
              packageRef: { refName: def.refName, versionSelection: { constraints: def.version } },
              ...(i.values?.trim() ? { values: [{ secretRef: { name: n.secret } }] } : {}),
            },
          },
        },
      ];
    },
  };
}

/**
 * Removing a package: delete its PackageInstall; kapp-controller then deletes
 * what the package created, using the install's own service account, so that
 * account (and the rest of what the plugin created) must outlive it; removing
 * those is a separate, later step.
 */
export function uninstallPlan(cluster: string, p: PackageInstallInfo): ActionPlan {
  const checks: Check[] = [];
  if (p.managedByVks || isCorePackage(p.refName)) checks.push({ level: 'block', text: `${p.refName} is managed by VKS (part of the cluster itself); don't remove it here.` });
  checks.push({ level: 'warn', text: `Everything ${shortPackage(p.refName)} created in the cluster is deleted, including its data volumes if the package owns them.` });
  checks.push({ level: 'ok', text: 'The service account, its role and the values Secret stay until you remove them (kapp-controller needs the account to finish deleting).' });
  return {
    id: `pkg-uninstall#${cluster}#${p.namespace}/${p.name}`,
    title: `Remove ${p.refName} from ${cluster}`,
    summary: `Deletes PackageInstall ${p.namespace}/${p.name} (${p.version ?? '?'}).`,
    checks,
    reasonRequired: true,
    confirmText: p.name,
    applyLabel: 'Remove',
    requests: () => [{ method: 'DELETE', path: `${PKG}/namespaces/${p.namespace}/packageinstalls/${p.name}` }],
  };
}

/** Leftovers the plugin created for an install that no longer exists: commands to remove them. */
export function leftoverCleanup(context: string, name: string, ns: string): string[] {
  const n = installNames(name, ns);
  return [
    `kubectl --context ${context} -n ${ns} delete secret ${n.secret} --ignore-not-found`,
    `kubectl --context ${context} delete clusterrolebinding ${n.binding} --ignore-not-found`,
    `kubectl --context ${context} delete clusterrole ${n.role} --ignore-not-found`,
    `kubectl --context ${context} -n ${ns} delete serviceaccount ${n.sa} --ignore-not-found`,
  ];
}
