/**
 * Which CIS Kubernetes Benchmark a cluster is measured against, and where each
 * of the plugin's checks sits in it.
 *
 * A CIS benchmark is written for a range of Kubernetes versions, so the
 * benchmark follows the cluster's version: v2.0 for Kubernetes 1.34 to 1.35,
 * v1.12 for 1.32 to 1.33, v1.11 for 1.29 to 1.31. v2.0 keeps v1.12's
 * numbering, recommendation for recommendation, so one mapping serves both.
 *
 * Only recommendation numbers are referenced here. The checks' titles and
 * remediation texts are the plugin's own wording: the benchmark itself is
 * CIS's document and is not reproduced. This is not a certified CIS assessment.
 */
import { ControlResult } from './compliance';

export interface CisBenchmark {
  /** "2.0", "1.12", … */
  version: string;
  /** The Kubernetes versions the benchmark was written for. */
  covers: string;
  /** The cluster's Kubernetes is newer than the benchmark covers (the newest benchmark is used). */
  beyond: boolean;
  /** Whether the plugin's checks carry exact recommendation numbers for this benchmark (v1.12 and v2.0). */
  exact: boolean;
  /** The kube-bench profile for node scans. */
  profile: string;
  /** A profile with the same checks that older kube-bench images already ship, to fall back on. */
  fallbackProfile?: string;
}

/** The newest CIS Kubernetes Benchmark the plugin knows, and the last Kubernetes minor it covers. */
export const NEWEST = { version: '2.0', lastMinor: 35 };

/** "v1.36.2+vmware.1" → 36. */
export function kubeMinor(version?: string): number | undefined {
  const m = /^v?1\.(\d+)/.exec(version ?? '');
  return m ? Number(m[1]) : undefined;
}

/** The benchmark for a cluster's Kubernetes version. Unknown versions get the newest. */
export function cisBenchmark(kubernetesVersion?: string): CisBenchmark {
  const minor = kubeMinor(kubernetesVersion);
  if (minor === undefined || minor >= 34) return { version: '2.0', covers: 'Kubernetes 1.34 to 1.35', beyond: minor !== undefined && minor > NEWEST.lastMinor, exact: true, profile: 'cis-2.0', fallbackProfile: 'cis-1.12' };
  if (minor >= 32) return { version: '1.12', covers: 'Kubernetes 1.32 to 1.33', beyond: false, exact: true, profile: 'cis-1.12' };
  if (minor >= 29) return { version: '1.11', covers: 'Kubernetes 1.29 to 1.31', beyond: false, exact: false, profile: 'cis-1.11' };
  if (minor === 28) return { version: '1.10', covers: 'Kubernetes 1.28', beyond: false, exact: false, profile: 'cis-1.10' };
  return { version: '1.9', covers: 'Kubernetes 1.27', beyond: false, exact: false, profile: 'cis-1.9' };
}

/** "CIS 2.0", for a column or a sentence. */
export const benchmarkLabel = (b: CisBenchmark) => `CIS ${b.version}`;

/**
 * Each check's recommendations in CIS v1.12 and v2.0 (the same numbers in
 * both). A range ("1.1.1-1.1.21") covers every recommendation in it. A check
 * that is absent has no counterpart in these benchmarks.
 */
export const CIS_ITEMS: Record<string, string[]> = {
  'CP-FILES': ['1.1.1-1.1.21'],
  'API-ANON': ['1.2.1'],
  'API-TOKENFILE': ['1.2.2'],
  'API-KUBELET-TLS': ['1.2.4'],
  'API-KUBELET-CA': ['1.2.5'],
  'API-AUTHZ': ['1.2.6-1.2.8'],
  'API-ADMIT-ALWAYS': ['1.2.10'],
  'API-ADMIT-NODE': ['1.2.14'],
  'API-PROFILING': ['1.2.15'],
  'API-AUDIT': ['1.2.16', '3.2.1'],
  'API-AUDIT-RETAIN': ['1.2.17-1.2.19'],
  'API-SA-LOOKUP': ['1.2.21'],
  'API-ETCD-TLS': ['1.2.23', '1.2.26'],
  'API-TLS': ['1.2.24', '1.2.25'],
  'API-ENCRYPTION': ['1.2.27', '1.2.28'],
  'CM-PROFILING': ['1.3.2'],
  'CM-SA-CREDS': ['1.3.3'],
  'CM-SA-KEY': ['1.3.4', '1.3.5'],
  'CM-BIND': ['1.3.7'],
  'SCH-PROFILING': ['1.4.1'],
  'SCH-BIND': ['1.4.2'],
  'ETCD-TLS': ['2.1-2.3'],
  'ETCD-PEER': ['2.4-2.6'],
  'NODE-FILES': ['4.1.1-4.1.10'],
  'KUBELET-ANON': ['4.2.1'],
  'KUBELET-AUTHZ': ['4.2.2'],
  'KUBELET-CA': ['4.2.3'],
  'KUBELET-RO': ['4.2.4'],
  'KUBELET-STREAM': ['4.2.5'],
  'KUBELET-ROTATE': ['4.2.10'],
  'RBAC-ADMIN': ['5.1.1'],
  'RBAC-SECRETS': ['5.1.2'],
  'RBAC-WILDCARD': ['5.1.3'],
  'RBAC-PODCREATE': ['5.1.4'],
  'SA-DEFAULT': ['5.1.5'],
  'RBAC-MASTERS': ['5.1.7'],
  'RBAC-ESCALATE': ['5.1.8'],
  'PSS-ADMISSION': ['5.2.1'],
  'PSS-PRIV': ['5.2.2'],
  'PSS-HOSTNS': ['5.2.3-5.2.5'],
  'PSS-ESCALATION': ['5.2.6'],
  'PSS-ROOT': ['5.2.7'],
  'PSS-NETRAW': ['5.2.8', '5.2.9'],
  'PSS-HOSTPATH': ['5.2.11'],
  'PSS-HOSTPORT': ['5.2.12'],
  'NET-CNI': ['5.3.1'],
  'NET-POLICIES': ['5.3.2'],
  'SEC-ENV': ['5.4.1'],
  'SEC-EXTERNAL': ['5.4.2'],
  'GEN-BOUNDARIES': ['5.6.1'],
  'GEN-SECCOMP': ['5.6.2'],
  'GEN-RO-ROOTFS': ['5.6.3'],
  'GEN-DEFAULT-NS': ['5.6.4'],
};

/** How many recommendations each section of CIS v2.0 has (v1.12 has the same). */
const SECTIONS: Array<[string, number]> = [
  ['1.1', 21], ['1.2', 30], ['1.3', 7], ['1.4', 2], ['2', 7], ['3.1', 3], ['3.2', 2], ['4.1', 10], ['4.2', 14], ['4.3', 1],
  ['5.1', 13], ['5.2', 12], ['5.3', 2], ['5.4', 2], ['5.5', 1], ['5.6', 4],
];

const expand = (item: string): string[] => {
  const [from, to] = item.split('-');
  if (!to) return [from];
  const prefix = from.slice(0, from.lastIndexOf('.') + 1);
  const a = Number(from.slice(prefix.length));
  const b = Number(to.slice(prefix.length));
  return Array.from({ length: b - a + 1 }, (_, k) => `${prefix}${a + k}`);
};

export interface Coverage {
  /** Recommendations in the benchmark. */
  total: number;
  /** Those the plugin's checks assess (through the API or a node scan). */
  assessed: number;
  /** Those it doesn't, by number. */
  notAssessed: string[];
}

/** How much of CIS v2.0 (and v1.12) the plugin's checks assess. */
export function cisCoverage(): Coverage {
  const all = SECTIONS.flatMap(([s, n]) => Array.from({ length: n }, (_, k) => `${s}.${k + 1}`));
  const assessed = new Set(Object.values(CIS_ITEMS).flatMap(items => items.flatMap(expand)));
  return { total: all.length, assessed: all.filter(i => assessed.has(i)).length, notAssessed: all.filter(i => !assessed.has(i)) };
}

/** A check's reference for a benchmark: exact recommendation numbers where they are known, otherwise its section. */
export function controlRef(control: Pick<ControlResult, 'id' | 'ref'>, benchmark: CisBenchmark): string {
  if (!control.ref.startsWith('CIS')) return control.ref;
  const items = benchmark.exact ? CIS_ITEMS[control.id] : undefined;
  return items ? `CIS ${benchmark.version}: ${items.join(', ')}` : `${control.ref.replace(/^CIS /, `CIS ${benchmark.version}: section `)}`;
}

/**
 * A cluster's results against its own benchmark: each check carries that
 * benchmark's reference, and a CIS check with no counterpart in it (kernel
 * defaults, from older benchmarks) is left out rather than scored.
 */
export function alignToBenchmark(results: ControlResult[], benchmark: CisBenchmark): ControlResult[] {
  return results
    .filter(r => !(benchmark.exact && r.frameworks.includes('cis') && !CIS_ITEMS[r.id]))
    .map(r => ({ ...r, ref: controlRef(r, benchmark) }));
}
