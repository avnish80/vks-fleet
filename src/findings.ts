/**
 * Findings: what an operator should know or do, with the fix in plain
 * language. Pure rules over the fleet model, so the same engine can run in a
 * future server-side aggregator.
 */
import { clusterDeepLink, DeepLink, headlampPodsPath, machinePath } from './routes';
import { FleetCluster, Finding, ServiceHealth, Severity, SupervisorResult } from './types';

/** "10s", "5m0s", "1h" → seconds. */
function parseDurationSeconds(text: string): number | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text.trim());
  if (!m || !text.trim()) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

const DAY = 24 * 60 * 60 * 1000;
export const CERT_CRITICAL_DAYS = 7;
export const CERT_WARNING_DAYS = 30;
export const QUOTA_WARNING = 0.8;
export const QUOTA_CRITICAL = 0.95;

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

/** Where each kind of cluster finding points on the cluster page. */
function targetFor(c: FleetCluster, id: string): string | undefined {
  const at = (link: DeepLink) => clusterDeepLink(c, link);
  const machineLabel = (label: string) => c.machines.find(m => m.nodeName === label || m.name === label);
  if (id.startsWith('vm-off-')) return machinePath(c, id.slice('vm-off-'.length));
  if (id.startsWith('timeouts-')) return at({ hash: 'node-pools', focus: id.slice('timeouts-'.length), action: 'timeouts', pool: id.slice('timeouts-'.length) });
  if (id.startsWith('issue-')) {
    const text = c.issues[Number(id.slice('issue-'.length))] ?? '';
    const m = /Machine (\S+)/.exec(text);
    const machine = m ? machineLabel(m[1]) : undefined;
    return machine ? machinePath(c, machine.name) : at({ hash: 'machines' });
  }
  switch (id) {
    case 'mhc-blocked':
    case 'mhc-repairing':
    case 'single-cp':
    case 'one-zone':
      return at({ hash: 'machines' });
    case 'certs':
      return at({ hash: 'summary', focus: 'certificates' });
    case 'paused':
      return at({ hash: 'summary', action: 'resume' });
    case 'behind':
    case 'upgrade':
    case 'class':
      return at({ hash: 'summary', action: 'upgrade' });
    case 'unhealthy':
      return at({ hash: 'conditions' });
  }
  return at({});
}

function f(c: FleetCluster, id: string, severity: Severity, title: string, fix: string, detail?: string): Finding {
  return {
    target: targetFor(c, id),
    id: `${c.key}#${id}`,
    severity,
    scope: 'cluster',
    supervisorId: c.supervisorId,
    clusterKey: c.key,
    clusterName: c.name,
    namespace: c.namespace,
    tenantName: c.tenantName,
    title,
    detail,
    fix,
  };
}

export function clusterFindings(c: FleetCluster, now: Date, fleetZones: number): Finding[] {
  const out: Finding[] = [];

  // Machines stuck or failed (already phrased by the translator).
  c.issues.forEach((issue, i) => {
    const stuckDelete = /deleting for/.test(issue);
    out.push(
      f(
        c,
        `issue-${i}`,
        'warning',
        issue,
        stuckDelete
          ? 'Usually a node drain blocked by a PodDisruptionBudget, or a VM deletion stuck in vSphere. Check the machine\'s events on the cluster page, and sign in to the cluster to see pods that can\'t be evicted. If the blocker can\'t be fixed, use Unblock deletion on the machine.'
          : 'Check the machine\'s conditions and the Supervisor events for this cluster.'
      )
    );
  });

  // Node VMs powered off while their machine should be running.
  for (const m of c.machines) {
    const ps = m.vm?.powerState;
    if (ps && !/^poweredon$/i.test(ps) && !m.deletingSince) {
      out.push(
        f(
          c,
          `vm-off-${m.name}`,
          'critical',
          `Node VM ${m.nodeName ?? m.name} is ${ps}`,
          'Power it on in vCenter, or replace the node (delete its machine and let the cluster rebuild it).'
        )
      );
    }
  }

  // Automatic repair.
  if (c.healthCheck) {
    const unhealthy = c.healthCheck.expected - c.healthCheck.healthy;
    if (!c.healthCheck.remediationAllowed) {
      out.push(
        f(
          c,
          'mhc-blocked',
          'critical',
          'Automatic node repair has stopped',
          'Too many nodes are unhealthy at once, so the health check stopped replacing them. Fix the underlying cause (network, storage, capacity), then repair resumes.',
          `${c.healthCheck.healthy} of ${c.healthCheck.expected} nodes healthy`
        )
      );
    } else if (unhealthy - c.machines.filter(m => m.deletingSince).length > 0) {
      // Machines already being deleted are covered by their own finding.
      const repairing = unhealthy - c.machines.filter(m => m.deletingSince).length;
      out.push(
        f(
          c,
          'mhc-repairing',
          'warning',
          `${repairing} node${repairing === 1 ? ' is' : 's are'} unhealthy and being repaired`,
          'No action needed unless it persists. The health check replaces unhealthy nodes automatically.'
        )
      );
    }
  }

  // Control-plane certificates.
  if (c.certificatesExpiry) {
    const days = Math.floor((new Date(c.certificatesExpiry).getTime() - now.getTime()) / DAY);
    const rotating = c.certificateRotation?.enabled === true;
    const window = c.certificateRotation?.renewalDaysBeforeExpiry ?? 90;
    const when = new Date(c.certificatesExpiry).toLocaleDateString();
    if (days < CERT_CRITICAL_DAYS) {
      out.push(
        f(
          c,
          'certs',
          'critical',
          `Control-plane certificates expire in ${Math.max(days, 0)} day${days === 1 ? '' : 's'} (${when})`,
          rotating
            ? 'Automatic rotation is on but hasn\'t renewed them. Check the control plane\'s conditions; roll out the control plane to renew now.'
            : 'Roll out the control plane to renew them, and turn on certificate rotation for the cluster.'
        )
      );
    } else if (days < CERT_WARNING_DAYS) {
      out.push(
        f(
          c,
          'certs',
          'warning',
          `Control-plane certificates expire in ${days} days (${when})`,
          rotating
            ? 'Automatic rotation should renew them; if the date doesn\'t move soon, roll out the control plane.'
            : 'Turn on certificate rotation, or roll out the control plane before they expire.'
        )
      );
    } else if (!rotating && days < window) {
      out.push(
        f(
          c,
          'certs',
          'warning',
          `Certificate rotation is off; certificates expire ${when}`,
          'Turn on certificate rotation in the cluster\'s settings so renewal happens automatically.'
        )
      );
    }
  }

  if (c.paused) {
    out.push(
      f(
        c,
        'paused',
        'warning',
        'Cluster is paused',
        'Changes and repairs are not being applied. Resume it when maintenance is finished.'
      )
    );
  }

  // Versions.
  if (c.minorsBehind !== undefined && c.minorsBehind >= 2) {
    out.push(
      f(
        c,
        'behind',
        'warning',
        `${c.minorsBehind} minor versions behind the newest release`,
        `Plan upgrades one minor version at a time, starting with ${c.availableUpgrade?.version ?? 'the next minor'}.`
      )
    );
  } else if (c.availableUpgrade && !c.upgrading) {
    out.push(
      f(
        c,
        'upgrade',
        'info',
        `Upgrade available: ${c.availableUpgrade.version}`,
        `A ${c.availableUpgrade.kind} upgrade is available on the Supervisor.`
      )
    );
  }
  if (c.classUpdate) {
    out.push(
      f(
        c,
        'class',
        'info',
        `Newer cluster class available: ${c.classUpdate}`,
        `The cluster uses ${c.clusterClass}. Moving to the newer class brings the latest VKS defaults and fixes; plan it together with a version upgrade.`
      )
    );
  }

  // Timeouts left on node pools (e.g. after unblocking a deletion).
  for (const p of c.nodePools) {
    const deleting = c.machines.some(m => m.pool === p.name && m.deletingSince);
    if (deleting) continue;
    const short = p.nodeDrainTimeout && (parseDurationSeconds(p.nodeDrainTimeout) ?? Infinity) < 300;
    if (p.nodeVolumeDetachTimeout || short) {
      const what = [
        p.nodeDrainTimeout ? `drain timeout ${p.nodeDrainTimeout}` : '',
        p.nodeVolumeDetachTimeout ? `volume-detach timeout ${p.nodeVolumeDetachTimeout}` : '',
      ]
        .filter(Boolean)
        .join(' and ');
      out.push(
        f(
          c,
          `timeouts-${p.name}`,
          'warning',
          `Node pool ${p.name} still has a ${what}`,
          'Nothing is stuck deleting in this pool now. Clear it with Timeouts on the node pool, unless it is meant to stay: short timeouts stop pods without eviction during scale-downs and upgrades.'
        )
      );
    }
  }

  // Resilience.
  if (c.controlPlane && c.controlPlane.desired === 1) {
    out.push(
      f(
        c,
        'single-cp',
        'info',
        'Single control-plane node',
        'The cluster API goes down if that one VM does. Use 3 control-plane nodes for production clusters.'
      )
    );
  }
  const zones = new Set(c.machines.filter(m => !m.deletingSince).map(m => m.failureDomain).filter(Boolean));
  if (fleetZones > 1 && zones.size === 1 && c.machines.length > 1) {
    out.push(
      f(
        c,
        'one-zone',
        'info',
        `All nodes are in one zone (${Array.from(zones)[0]})`,
        'Other clusters on this Supervisor use several zones. Spread node pools across zones if this cluster needs to survive a zone outage.'
      )
    );
  }

  // Unhealthy with nothing more specific to say.
  if ((c.health === 'failed' || c.health === 'degraded') && out.every(x => x.severity === 'info')) {
    const ready = c.conditions.find(x => x.type === 'Ready');
    out.push(
      f(
        c,
        'unhealthy',
        c.health === 'failed' ? 'critical' : 'warning',
        `Cluster is ${c.health}`,
        'Check the conditions and Supervisor events for this cluster, and the VKS controller logs.',
        ready?.message
      )
    );
  }
  return out;
}

/** Quota findings for the cluster's namespace. Shared by every cluster in it, so reported once per namespace. */
export function namespaceFindings(c: FleetCluster): Finding[] {
  const out: Finding[] = [];
  for (const q of c.quota ?? []) {
    if (q.ratio === undefined || q.ratio < QUOTA_WARNING) continue;
    out.push({
      id: `${c.supervisorId}/${c.namespace}#quota-${q.resource}`,
      target: clusterDeepLink(c, { hash: 'quota' }),
      severity: q.ratio >= QUOTA_CRITICAL ? 'critical' : 'warning',
      scope: 'namespace',
      supervisorId: c.supervisorId,
      namespace: c.namespace,
      tenantName: c.tenantName,
      title: `Quota for ${q.resource} in namespace ${c.namespace} is ${Math.round(q.ratio * 100)}% used (${q.used} of ${q.hard})`,
      fix: 'Scaling up or adding nodes may fail. Raise the quota in VCFA, or free capacity in the namespace.',
    });
  }
  return out;
}

export function serviceFindings(supervisorId: string, services: ServiceHealth[], headlampCluster?: string): Finding[] {
  const leftovers = services.filter(s => s.leftovers > 0);
  const cleanup: Finding[] = leftovers.length
    ? [
        {
          id: `${supervisorId}#svc-leftovers`,
          severity: 'info',
          scope: 'supervisor',
          supervisorId,
          title: `${leftovers.reduce((n, s) => n + s.leftovers, 0)} old failed pods left behind in Supervisor services`,
          detail: leftovers.map(s => `${s.name}: ${s.leftovers}`).join('; '),
          target: headlampCluster ? headlampPodsPath(headlampCluster, leftovers[0].namespace) : undefined,
          fix: 'They were already replaced by running pods, so they are safe to delete, e.g. kubectl delete pod -n <namespace> --field-selector=status.phase=Failed.',
        },
      ]
    : [];
  const problems: Finding[] = services
    .filter(s => s.problems.length > 0)
    .map(s => ({
      id: `${supervisorId}#svc-${s.namespace}`,
      severity: 'warning' as Severity,
      scope: 'supervisor' as const,
      supervisorId,
      namespace: s.namespace,
      target: headlampCluster ? headlampPodsPath(headlampCluster, s.namespace) : undefined,
      title: `Supervisor service ${s.name} has ${s.problems.length} pod${s.problems.length === 1 ? '' : 's'} with problems`,
      detail: s.problems
        .slice(0, 3)
        .map(p => `${p.name}: ${p.reason}`)
        .join('; '),
      fix: 'Open the service\'s pods in Headlamp and check their logs and events. Problems here can affect every cluster on the Supervisor.',
    }));
  return [...problems, ...cleanup];
}

export function fleetFindings(results: SupervisorResult[], now: Date = new Date()): Finding[] {
  const clusters = results.flatMap(r => r.clusters);
  const fleetZones = new Set(clusters.flatMap(c => c.machines.map(m => m.failureDomain)).filter(Boolean)).size;
  const seenNamespaces = new Set<string>();
  const all = [
    ...clusters.flatMap(c => clusterFindings(c, now, fleetZones)),
    ...clusters.flatMap(c => {
      const k = `${c.supervisorId}/${c.namespace}`;
      if (seenNamespaces.has(k)) return [];
      seenNamespaces.add(k);
      return namespaceFindings(c);
    }),
    ...results.flatMap(r => serviceFindings(r.supervisor.id, r.services ?? [], r.supervisor.headlampCluster)),
  ];
  return all.sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || (a.clusterName ?? '').localeCompare(b.clusterName ?? '')
  );
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  return findings.reduce(
    (acc, x) => ({ ...acc, [x.severity]: acc[x.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 } as Record<Severity, number>
  );
}

