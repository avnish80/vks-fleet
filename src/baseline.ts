/**
 * Fleet baseline: the standard every cluster should meet, and where each
 * cluster drifts from it. Each drift says how to fix it: a safe patch the
 * plugin can apply (with the usual dry run), or the dialog that handles it.
 */
import { clusterDeepLink, DeepLink } from './routes';
import { Baseline, BackupStatus, FleetCluster } from './types';

export const DEFAULT_BASELINE: Baseline = {
  controlPlaneReplicas: 3,
  minPoolNodes: 2,
  certificateRotation: true,
  healthCheck: true,
  latestClass: true,
  maxMinorsBehind: 1,
  multiZone: true,
  vmClasses: [],
  storageClasses: [],
  backupWithinHours: 26,
  allowedRegistries: [],
};

export function normalizeBaseline(raw: Partial<Baseline> | undefined): Baseline {
  const b = { ...DEFAULT_BASELINE, ...(raw ?? {}) };
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);
  return {
    controlPlaneReplicas: num(b.controlPlaneReplicas, 3) >= 3 ? 3 : 1,
    minPoolNodes: num(b.minPoolNodes, 2),
    certificateRotation: !!b.certificateRotation,
    healthCheck: !!b.healthCheck,
    latestClass: !!b.latestClass,
    maxMinorsBehind: num(b.maxMinorsBehind, 1),
    multiZone: !!b.multiZone,
    vmClasses: list(b.vmClasses),
    storageClasses: list(b.storageClasses),
    backupWithinHours: num(b.backupWithinHours, 26),
    allowedRegistries: list(b.allowedRegistries),
  };
}

export type RuleStatus = 'ok' | 'drift' | 'unknown' | 'off';

export type BaselineFix =
  | { kind: 'control-plane' }
  | { kind: 'cert-rotation' }
  | { kind: 'link'; label: string; link: DeepLink };

export interface RuleResult {
  id: string;
  title: string;
  status: RuleStatus;
  current: string;
  expected: string;
  fix?: BaselineFix;
}

export function evaluateBaseline(
  c: FleetCluster,
  b: Baseline,
  fleetZones: number,
  backup?: BackupStatus,
  now: Date = new Date()
): RuleResult[] {
  const out: RuleResult[] = [];
  const cp = c.controlPlane?.desired;
  out.push({
    id: 'cp',
    title: 'Control plane size',
    status: cp === undefined ? 'unknown' : cp >= b.controlPlaneReplicas ? 'ok' : 'drift',
    current: cp === undefined ? 'unknown' : `${cp} node${cp === 1 ? '' : 's'}`,
    expected: `${b.controlPlaneReplicas}`,
    fix: cp !== undefined && cp < b.controlPlaneReplicas ? { kind: 'control-plane' } : undefined,
  });

  const small = c.nodePools.filter(p => !p.autoscaler && (p.desired ?? p.ready) < b.minPoolNodes);
  out.push({
    id: 'pools',
    title: 'Worker pool size',
    status: c.nodePools.length === 0 ? 'unknown' : small.length ? 'drift' : 'ok',
    current: small.length ? small.map(p => `${p.name}: ${p.desired ?? p.ready}`).join(', ') : `${c.nodePools.length} pool${c.nodePools.length === 1 ? '' : 's'} OK`,
    expected: `at least ${b.minPoolNodes} per pool`,
    fix: small.length ? { kind: 'link', label: `Scale ${small[0].name}`, link: { hash: 'node-pools', focus: small[0].name, action: 'scale', pool: small[0].name } } : undefined,
  });

  const rot = c.certificateRotation?.enabled;
  out.push({
    id: 'certs',
    title: 'Certificate rotation',
    status: !b.certificateRotation ? 'off' : rot === undefined ? 'unknown' : rot ? 'ok' : 'drift',
    current: rot === undefined ? 'unknown' : rot ? 'on' : 'off',
    expected: b.certificateRotation ? 'on' : 'not checked',
    fix: b.certificateRotation && rot === false ? { kind: 'cert-rotation' } : undefined,
  });

  out.push({
    id: 'mhc',
    title: 'Node health checks',
    status: !b.healthCheck ? 'off' : c.healthCheck ? 'ok' : 'drift',
    current: c.healthCheck ? 'configured' : 'none',
    expected: b.healthCheck ? 'configured' : 'not checked',
  });

  out.push({
    id: 'class',
    title: 'Cluster class',
    status: !b.latestClass ? 'off' : !c.clusterClass ? 'unknown' : c.classUpdate ? 'drift' : 'ok',
    current: c.clusterClass ?? 'unknown',
    expected: b.latestClass ? c.classUpdate ?? 'newest' : 'not checked',
    fix: b.latestClass && c.classUpdate ? { kind: 'link', label: 'Upgrade with class move', link: { hash: 'summary', action: 'upgrade' } } : undefined,
  });

  out.push({
    id: 'version',
    title: 'Kubernetes version',
    status: c.minorsBehind === undefined ? 'unknown' : c.minorsBehind <= b.maxMinorsBehind ? 'ok' : 'drift',
    current: c.kubernetesVersion ?? 'unknown',
    expected: b.maxMinorsBehind === 0 ? 'newest minor' : `within ${b.maxMinorsBehind} minor of newest`,
    fix: c.minorsBehind !== undefined && c.minorsBehind > b.maxMinorsBehind ? { kind: 'link', label: 'Upgrade', link: { hash: 'summary', action: 'upgrade' } } : undefined,
  });

  const zones = new Set(c.machines.filter(m => !m.deletingSince).map(m => m.failureDomain).filter(Boolean));
  out.push({
    id: 'zones',
    title: 'Zone spread',
    status: !b.multiZone ? 'off' : fleetZones <= 1 ? 'unknown' : zones.size > 1 ? 'ok' : 'drift',
    current: fleetZones <= 1 ? 'single-zone Supervisor' : `${zones.size} zone${zones.size === 1 ? '' : 's'}`,
    expected: b.multiZone ? 'several zones' : 'not checked',
  });

  const classesUsed = Array.from(
    new Set([...c.nodePools.map(p => p.vmClass), c.vmClass, ...c.machines.map(m => m.vm?.className)].filter((x): x is string => !!x))
  );
  const badClasses = b.vmClasses.length ? classesUsed.filter(x => !b.vmClasses.includes(x)) : [];
  out.push({
    id: 'vmclass',
    title: 'VM classes',
    status: !b.vmClasses.length ? 'off' : badClasses.length ? 'drift' : 'ok',
    current: classesUsed.join(', ') || 'unknown',
    expected: b.vmClasses.length ? b.vmClasses.join(', ') : 'any',
  });

  const scUsed = Array.from(new Set([c.storageClass, ...c.nodePools.map(p => p.storageClass)].filter((x): x is string => !!x)));
  const badSc = b.storageClasses.length ? scUsed.filter(x => !b.storageClasses.includes(x)) : [];
  out.push({
    id: 'storage',
    title: 'Storage classes',
    status: !b.storageClasses.length ? 'off' : badSc.length ? 'drift' : 'ok',
    current: scUsed.join(', ') || 'unknown',
    expected: b.storageClasses.length ? b.storageClasses.join(', ') : 'any',
  });

  const hours = backup?.lastSuccess?.completed ? (now.getTime() - new Date(backup.lastSuccess.completed).getTime()) / 3600000 : undefined;
  out.push({
    id: 'backup',
    title: 'Recent backup',
    status: !b.backupWithinHours ? 'off' : !backup || backup.error ? 'unknown' : hours !== undefined && hours <= b.backupWithinHours ? 'ok' : 'drift',
    current: !backup
      ? 'sign in to check'
      : backup.missing
      ? 'Velero not installed'
      : hours === undefined
      ? 'no successful backup'
      : `${Math.round(hours)}h ago`,
    expected: b.backupWithinHours ? `within ${b.backupWithinHours}h` : 'not checked',
    fix: backup && !backup.error && (hours === undefined || hours > b.backupWithinHours) ? { kind: 'link', label: 'Backups', link: { hash: 'backups' } } : undefined,
  });
  return out;
}

export function compliance(results: RuleResult[]): { ok: number; drift: number; checked: number; pct: number } {
  const checked = results.filter(r => r.status === 'ok' || r.status === 'drift');
  const ok = checked.filter(r => r.status === 'ok').length;
  return { ok, drift: checked.length - ok, checked: checked.length, pct: checked.length ? Math.round((ok / checked.length) * 100) : 100 };
}

export function fixLink(c: FleetCluster, fix: BaselineFix): string | undefined {
  return fix.kind === 'link' ? clusterDeepLink(c, fix.link) : undefined;
}
