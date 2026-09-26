/**
 * The Kubernetes Pod Security Standards, evaluated in the browser so the
 * plugin can say which existing pods a namespace level would refuse (and
 * why) before it is applied. Follows the published baseline and restricted
 * profiles; AppArmor and SELinux type checks are left out.
 */

export type PssLevel = 'baseline' | 'restricted';

const BASELINE_CAPS = new Set([
  'AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT',
]);
const SAFE_SYSCTLS = new Set([
  'kernel.shm_rmid_forced', 'net.ipv4.ip_local_port_range', 'net.ipv4.ip_unprivileged_port_start', 'net.ipv4.tcp_syncookies', 'net.ipv4.ping_group_range',
  'net.ipv4.ip_local_reserved_ports', 'net.ipv4.tcp_keepalive_time', 'net.ipv4.tcp_fin_timeout', 'net.ipv4.tcp_keepalive_intvl', 'net.ipv4.tcp_keepalive_probes',
]);
const RESTRICTED_VOLUMES = new Set(['configMap', 'csi', 'downwardAPI', 'emptyDir', 'ephemeral', 'persistentVolumeClaim', 'projected', 'secret']);

function containers(spec: any): any[] {
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? []), ...(spec?.ephemeralContainers ?? [])];
}

/** Why a pod spec breaks a level (empty = allowed). */
export function pssViolations(spec: any, level: PssLevel): string[] {
  const out = new Set<string>();
  const cs = containers(spec);
  const psc = spec?.securityContext ?? {};

  // Baseline
  if (spec?.hostNetwork) out.add('host network');
  if (spec?.hostPID) out.add('host PID');
  if (spec?.hostIPC) out.add('host IPC');
  for (const v of spec?.volumes ?? []) if (v?.hostPath) out.add(`hostPath volume ${v.name}`);
  for (const c of cs) {
    const sc = c?.securityContext ?? {};
    if (sc.privileged) out.add(`privileged container ${c.name}`);
    for (const cap of sc.capabilities?.add ?? []) if (!BASELINE_CAPS.has(String(cap).replace(/^CAP_/, ''))) out.add(`capability ${cap} (${c.name})`);
    for (const p of c?.ports ?? []) if (p?.hostPort) out.add(`host port ${p.hostPort} (${c.name})`);
    if (sc.procMount && sc.procMount !== 'Default') out.add(`procMount ${sc.procMount} (${c.name})`);
    if (sc.seccompProfile?.type === 'Unconfined') out.add(`seccomp Unconfined (${c.name})`);
  }
  if (psc.seccompProfile?.type === 'Unconfined') out.add('seccomp Unconfined (pod)');
  for (const s of psc.sysctls ?? []) if (!SAFE_SYSCTLS.has(s?.name)) out.add(`sysctl ${s?.name}`);
  if (level === 'baseline') return Array.from(out);

  // Restricted
  for (const v of spec?.volumes ?? []) {
    const type = Object.keys(v ?? {}).find(k => k !== 'name');
    if (type && !RESTRICTED_VOLUMES.has(type) && type !== 'hostPath') out.add(`${type} volume ${v.name}`);
  }
  const podNonRoot = psc.runAsNonRoot === true;
  if (psc.runAsUser === 0) out.add('runs as UID 0 (pod)');
  const podSeccomp = ['RuntimeDefault', 'Localhost'].includes(psc.seccompProfile?.type);
  for (const c of cs) {
    const sc = c?.securityContext ?? {};
    if (sc.allowPrivilegeEscalation !== false) out.add(`allowPrivilegeEscalation not false (${c.name})`);
    if (!(sc.runAsNonRoot === true || (podNonRoot && sc.runAsNonRoot !== false))) out.add(`runAsNonRoot not set (${c.name})`);
    if (sc.runAsUser === 0) out.add(`runs as UID 0 (${c.name})`);
    if (!(podSeccomp || ['RuntimeDefault', 'Localhost'].includes(sc.seccompProfile?.type))) out.add(`no seccomp profile (${c.name})`);
    const drop = (sc.capabilities?.drop ?? []).map((x: string) => String(x).toUpperCase());
    if (!drop.includes('ALL')) out.add(`capabilities not dropping ALL (${c.name})`);
    for (const cap of sc.capabilities?.add ?? []) if (String(cap).replace(/^CAP_/, '') !== 'NET_BIND_SERVICE') out.add(`capability ${cap} (${c.name})`);
  }
  return Array.from(out);
}

export interface PodRef {
  name: string;
  spec: any;
}

/** Pods (by name) a level would refuse, with the reasons. */
export function refusedPods(pods: PodRef[], level: PssLevel): Array<{ pod: string; reasons: string[] }> {
  return pods.map(p => ({ pod: p.name, reasons: pssViolations(p.spec, level) })).filter(x => x.reasons.length);
}
