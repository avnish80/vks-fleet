/**
 * Packages: the Carvel PackageInstalls in each signed-in workload cluster
 * (how VKS and users install add-ons such as the CNI, CSI, cert-manager or
 * Velero), whether each reconciled, which newer versions the cluster's package
 * repositories offer, and version drift across the fleet.
 */
import { describeError, SupervisorClient } from './api/client';
import { parseConditions } from './capi/v1beta1';

export type PackageState = 'ok' | 'failed' | 'reconciling' | 'paused' | 'unknown';

export interface PackageInstallInfo {
  namespace: string;
  name: string;
  /** Package name, e.g. "calico.tanzu.vmware.com". */
  refName: string;
  /** Installed version, e.g. "3.31.5+vmware.3-fips-tkg.1". */
  version?: string;
  /** Version constraint asked for in the install. */
  constraint?: string;
  state: PackageState;
  message?: string;
  /** Newest version the cluster's repositories offer, when newer than installed. */
  update?: string;
}

export interface ClusterPackages {
  clusterKey: string;
  contextName: string;
  items: PackageInstallInfo[];
  /** Why packages couldn't be read (e.g. no permission, no kapp-controller). */
  error?: string;
}

/** Numeric parts of a version, ignoring words: "3.31.5+vmware.3-fips-tkg.1" → [3,31,5,3,1]. */
export function versionParts(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number);
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function packageState(pkgi: any): { state: PackageState; message?: string } {
  if (pkgi?.spec?.paused || pkgi?.spec?.canceled) return { state: 'paused', message: 'Reconciliation is paused or canceled.' };
  const conds = parseConditions(pkgi?.status?.conditions);
  const is = (t: string) => conds.find(c => c.type === t && c.status === 'True');
  const msg = pkgi?.status?.usefulErrorMessage || pkgi?.status?.friendlyDescription || undefined;
  if (is('ReconcileFailed')) return { state: 'failed', message: msg ?? is('ReconcileFailed')?.message };
  if (is('Reconciling')) return { state: 'reconciling', message: pkgi?.status?.friendlyDescription };
  if (is('ReconcileSucceeded')) return { state: 'ok' };
  return { state: 'unknown', message: msg };
}

/** Newest available version per package name, from data.packaging.carvel.dev Packages. */
export function newestVersions(packages: any[]): Map<string, string> {
  const newest = new Map<string, string>();
  for (const p of packages) {
    const ref = p?.spec?.refName;
    const v = p?.spec?.version;
    if (typeof ref !== 'string' || typeof v !== 'string') continue;
    const cur = newest.get(ref);
    if (!cur || compareVersions(v, cur) > 0) newest.set(ref, v);
  }
  return newest;
}

export function packageInstalls(pkgis: any[], available: Map<string, string>): PackageInstallInfo[] {
  return pkgis
    .map(p => {
      const refName: string = p?.spec?.packageRef?.refName ?? p?.metadata?.name ?? '';
      const version: string | undefined = p?.status?.version || undefined;
      const newest = available.get(refName);
      const { state, message } = packageState(p);
      return {
        namespace: p?.metadata?.namespace ?? '',
        name: p?.metadata?.name ?? '',
        refName,
        version,
        constraint: p?.spec?.packageRef?.versionSelection?.constraints,
        state,
        message,
        update: newest && version && compareVersions(newest, version) > 0 ? newest : undefined,
      };
    })
    .sort((a, b) => a.refName.localeCompare(b.refName));
}

export async function fetchClusterPackages(
  client: SupervisorClient,
  clusterKey: string,
  contextName: string
): Promise<ClusterPackages> {
  const [installs, available] = await Promise.allSettled([
    client.get<{ items?: any[] }>('/apis/packaging.carvel.dev/v1alpha1/packageinstalls'),
    client.get<{ items?: any[] }>('/apis/data.packaging.carvel.dev/v1alpha1/packages?limit=3000'),
  ]);
  if (installs.status === 'rejected') {
    return { clusterKey, contextName, items: [], error: describeError(installs.reason) };
  }
  const newest = available.status === 'fulfilled' ? newestVersions(available.value?.items ?? []) : new Map<string, string>();
  return { clusterKey, contextName, items: packageInstalls(installs.value?.items ?? [], newest) };
}

/** Packages that exist in more than one cluster at different installed versions. */
export interface DriftRow {
  refName: string;
  /** Cluster key → installed version (or undefined when not installed there). */
  versions: Map<string, string | undefined>;
  newest: string;
  distinct: number;
}

export function packageDrift(all: ClusterPackages[]): DriftRow[] {
  const byRef = new Map<string, Map<string, string | undefined>>();
  for (const cp of all) {
    for (const p of cp.items) {
      const row = byRef.get(p.refName) ?? new Map<string, string | undefined>();
      row.set(cp.clusterKey, p.version);
      byRef.set(p.refName, row);
    }
  }
  return Array.from(byRef.entries())
    .map(([refName, versions]) => {
      const vs = Array.from(new Set(Array.from(versions.values()).filter((v): v is string => !!v)));
      const newest = vs.sort(compareVersions)[vs.length - 1] ?? '';
      return { refName, versions, newest, distinct: vs.length };
    })
    .sort((a, b) => b.distinct - a.distinct || a.refName.localeCompare(b.refName));
}

/** Core platform packages: a failure here affects the whole cluster. */
export function isCorePackage(refName: string): boolean {
  return /^(antrea|calico|vsphere-pv-csi|vsphere-cpi|pinniped|guest-cluster-auth-service|metrics-server|secretgen-controller|capabilities)\./.test(
    refName
  );
}

export function shortPackage(refName: string): string {
  return refName.replace(/\.tanzu\.vmware\.com$|\.vmware\.com$/, '');
}
