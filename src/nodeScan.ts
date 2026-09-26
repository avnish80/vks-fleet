/**
 * Full benchmark with kube-bench (the standard open-source CIS scanner), for
 * what the API can't show: file permissions and ownership on the nodes.
 *
 * Runs only on request: a dedicated namespace (labelled privileged, since
 * kube-bench reads host files) and two short-lived Jobs, one on a
 * control-plane node and one on a worker. Results are summarised into a
 * ConfigMap in the same namespace, which keeps a short history in the cluster
 * itself; the Jobs are deleted afterwards.
 */
import { ControlResult } from './compliance';

export const SCAN_NS = 'vks-fleet-scan';
export const RESULTS_CM = 'kube-bench-results';
export const DEFAULT_KUBE_BENCH_IMAGE = 'docker.io/aquasec/kube-bench:latest';
export const HISTORY = 5;

export type ScanTarget = 'control-plane' | 'worker';

export interface BenchTest {
  id: string;
  desc: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'INFO';
  remediation?: string;
  actual?: string;
}

export interface NodeScanRun {
  at: string;
  target: ScanTarget;
  node?: string;
  benchmark?: string;
  tests: BenchTest[];
}

export const jobName = (t: ScanTarget) => `vks-fleet-kube-bench-${t}`;

const HOST_PATHS: Array<[string, string]> = [
  ['var-lib-etcd', '/var/lib/etcd'],
  ['var-lib-kubelet', '/var/lib/kubelet'],
  ['var-lib-kube-scheduler', '/var/lib/kube-scheduler'],
  ['var-lib-kube-controller-manager', '/var/lib/kube-controller-manager'],
  ['etc-systemd', '/etc/systemd'],
  ['lib-systemd', '/lib/systemd/'],
  ['srv-kubernetes', '/srv/kubernetes/'],
  ['etc-kubernetes', '/etc/kubernetes'],
  ['etc-cni-netd', '/etc/cni/net.d/'],
  ['opt-cni-bin', '/opt/cni/bin/'],
];

export function scanNamespaceManifest(): any {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: SCAN_NS,
      labels: {
        'app.kubernetes.io/managed-by': 'vks-fleet',
        // kube-bench needs the host's PID namespace and host paths.
        'pod-security.kubernetes.io/enforce': 'privileged',
      },
    },
  };
}

/** The kube-bench Job for one target (control-plane checks or node checks). */
export function jobManifest(target: ScanTarget, image: string): any {
  const cp = target === 'control-plane';
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName(target), namespace: SCAN_NS, labels: { 'app.kubernetes.io/managed-by': 'vks-fleet', 'vks-fleet/scan': target } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      activeDeadlineSeconds: 600,
      template: {
        metadata: { labels: { 'vks-fleet/scan': target } },
        spec: {
          hostPID: true,
          restartPolicy: 'Never',
          ...(cp
            ? {
                nodeSelector: { 'node-role.kubernetes.io/control-plane': '' },
                tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
              }
            : {
                affinity: {
                  nodeAffinity: {
                    requiredDuringSchedulingIgnoredDuringExecution: {
                      nodeSelectorTerms: [{ matchExpressions: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'DoesNotExist' }] }],
                    },
                  },
                },
              }),
          containers: [
            {
              name: 'kube-bench',
              image,
              command: ['kube-bench', 'run', '--targets', cp ? 'master,etcd,controlplane' : 'node', '--json'],
              resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { memory: '256Mi' } },
              volumeMounts: [
                ...HOST_PATHS.map(([name, path]) => ({ name, mountPath: path, readOnly: true })),
                { name: 'usr-bin', mountPath: '/usr/local/mount-from-host/bin', readOnly: true },
              ],
            },
          ],
          volumes: [...HOST_PATHS.map(([name, path]) => ({ name, hostPath: { path } })), { name: 'usr-bin', hostPath: { path: '/usr/bin' } }],
        },
      },
    },
  };
}

/** kube-bench --json output (an object with Controls, or older: an array of controls) → tests. */
export function parseKubeBench(raw: unknown): { benchmark?: string; tests: BenchTest[] } {
  let data: any = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{') >= 0 && (raw.indexOf('[') < 0 || raw.indexOf('{') < raw.indexOf('[')) ? raw.indexOf('{') : raw.indexOf('[');
    data = JSON.parse(raw.slice(start));
  }
  const controls: any[] = Array.isArray(data) ? data : data?.Controls ?? [];
  const tests: BenchTest[] = [];
  for (const c of controls) {
    for (const group of c?.tests ?? []) {
      for (const r of group?.results ?? []) {
        const status = String(r?.status ?? 'INFO').toUpperCase();
        tests.push({
          id: String(r?.test_number ?? ''),
          desc: String(r?.test_desc ?? '').replace(/\s*\((Automated|Manual)\)\s*$/, ''),
          status: (['PASS', 'FAIL', 'WARN', 'INFO'].includes(status) ? status : 'INFO') as BenchTest['status'],
          remediation: r?.remediation ? String(r.remediation).slice(0, 400) : undefined,
          actual: r?.actual_value ? String(r.actual_value).slice(0, 200) : undefined,
        });
      }
    }
  }
  return { benchmark: controls[0]?.version, tests };
}

/** The results ConfigMap's data: the last few runs per target. */
export function addRun(existing: NodeScanRun[], run: NodeScanRun): NodeScanRun[] {
  const others = existing.filter(r => r.target !== run.target);
  const same = [run, ...existing.filter(r => r.target === run.target)].slice(0, HISTORY);
  return [...others, ...same].sort((a, b) => b.at.localeCompare(a.at));
}

export function resultsConfigMap(runs: NodeScanRun[]): any {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: RESULTS_CM, namespace: SCAN_NS, labels: { 'app.kubernetes.io/managed-by': 'vks-fleet' } },
    data: { 'runs.json': JSON.stringify(runs) },
  };
}

export function readRuns(cm: any): NodeScanRun[] {
  try {
    const v = JSON.parse(cm?.data?.['runs.json'] ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export const latest = (runs: NodeScanRun[], target: ScanTarget) => runs.find(r => r.target === target);

/**
 * File-permission controls take their result from the latest node scan:
 * CIS 1.1 (control-plane files) from the control-plane run, 4.1 (kubelet
 * files) from the worker run. Other failures are left to the node-scan table.
 */
export function mergeNodeScan(results: ControlResult[], runs: NodeScanRun[]): ControlResult[] {
  const pick = (target: ScanTarget, prefix: string) => {
    const run = latest(runs, target);
    if (!run) return undefined;
    const tests = run.tests.filter(t => t.id.startsWith(prefix));
    if (!tests.length) return undefined;
    const failed = tests.filter(t => t.status === 'FAIL');
    const when = new Date(run.at).toLocaleString();
    return failed.length
      ? { status: 'fail' as const, evidence: `kube-bench ${when}${run.node ? ` on ${run.node}` : ''}: ${failed.length} of ${tests.length} failing (${failed.slice(0, 5).map(t => t.id).join(', ')})` }
      : { status: 'pass' as const, evidence: `kube-bench ${when}${run.node ? ` on ${run.node}` : ''}: all ${tests.length} checks pass` };
  };
  return results.map(r => {
    const m = r.id === 'CP-FILES' ? pick('control-plane', '1.1.') : r.id === 'NODE-FILES' ? pick('worker', '4.1.') : undefined;
    return m ? { ...r, ...m } : r;
  });
}
