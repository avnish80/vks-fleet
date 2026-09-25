/**
 * Checks: a best-practice scorecard for each cluster. Supervisor-side checks
 * always run; workload checks need the user to be signed in to the cluster
 * and show as "unknown" otherwise, without counting against the score.
 */
import { hoursSinceSuccess } from './backups';
import { ClusterPackages, shortPackage } from './packages';
import { BackupStatus, CheckCategory, CheckResult, CheckStatus, FleetCluster, Scorecard, WorkloadHealth } from './types';

const DAY = 86400000;

function check(
  id: string,
  category: CheckCategory,
  title: string,
  status: CheckStatus,
  detail: string,
  fix: string | undefined,
  weight = 1
): CheckResult {
  return { id, category, title, status, detail, fix: status === 'pass' ? undefined : fix, weight };
}

function list(items: string[], max = 3): string {
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

export function scorecard(
  c: FleetCluster,
  workload: WorkloadHealth | undefined,
  fleetZones: number,
  now: Date = new Date(),
  packages?: ClusterPackages,
  backups?: BackupStatus
): Scorecard {
  const checks: CheckResult[] = [];
  const cp = c.controlPlane?.desired;

  // Resilience
  checks.push(
    check(
      'cp-ha',
      'Resilience',
      'Highly available control plane',
      cp === undefined ? 'unknown' : cp >= 3 ? 'pass' : 'fail',
      cp === undefined ? 'Control plane size not known.' : `${cp} control-plane node${cp === 1 ? '' : 's'}.`,
      'Use 3 control-plane nodes, so the cluster API survives losing one VM.',
      3
    )
  );
  const zones = new Set(c.machines.filter(m => !m.deletingSince).map(m => m.failureDomain).filter(Boolean));
  checks.push(
    check(
      'zones',
      'Resilience',
      'Nodes spread across zones',
      fleetZones <= 1 ? 'unknown' : zones.size > 1 ? 'pass' : 'warn',
      fleetZones <= 1 ? 'The Supervisor uses a single zone, so this doesn\'t apply.' : `Nodes in ${zones.size} zone${zones.size === 1 ? '' : 's'}.`,
      'Spread node pools across the Supervisor\'s zones to survive a zone outage.',
      2
    )
  );
  const smallPools = c.nodePools.filter(p => (p.desired ?? p.ready) < 2 && !p.autoscaler);
  checks.push(
    check(
      'pool-size',
      'Resilience',
      'Worker pools have at least 2 nodes',
      c.nodePools.length === 0 ? 'unknown' : smallPools.length ? 'warn' : 'pass',
      smallPools.length ? `Single-node pools: ${list(smallPools.map(p => p.name))}.` : `${c.nodePools.length} pool${c.nodePools.length === 1 ? '' : 's'}, each with 2 or more nodes.`,
      'Give each pool at least 2 nodes, so draining or losing one node doesn\'t take its workloads down.',
      1
    )
  );
  checks.push(
    check(
      'health-check',
      'Resilience',
      'Automatic node repair configured',
      c.healthCheck ? (c.healthCheck.remediationAllowed ? 'pass' : 'fail') : 'warn',
      c.healthCheck
        ? `${c.healthCheck.healthy} of ${c.healthCheck.expected} nodes healthy; repair ${c.healthCheck.remediationAllowed ? 'active' : 'stopped'}.`
        : 'No MachineHealthCheck found for this cluster.',
      c.healthCheck ? 'Repair has stopped because too many nodes are unhealthy; fix the cause.' : 'Enable machine health checks in the cluster\'s class settings.',
      2
    )
  );

  // Lifecycle
  checks.push(
    check(
      'version',
      'Lifecycle',
      'Kubernetes version current',
      c.minorsBehind === undefined ? 'unknown' : c.minorsBehind >= 2 ? 'fail' : c.minorsBehind === 1 ? 'warn' : 'pass',
      c.minorsBehind === undefined
        ? 'Release list not readable.'
        : c.minorsBehind === 0
        ? `${c.kubernetesVersion} is the newest minor on the Supervisor.`
        : `${c.minorsBehind} minor version${c.minorsBehind === 1 ? '' : 's'} behind.`,
      'Upgrade one minor version at a time with Upgrade on the cluster page.',
      2
    )
  );
  checks.push(
    check(
      'class',
      'Lifecycle',
      'Cluster class current',
      !c.clusterClass ? 'unknown' : c.classUpdate ? 'warn' : 'pass',
      c.classUpdate ? `${c.clusterClass}; ${c.classUpdate} is available.` : c.clusterClass ?? 'Not known.',
      'Move to the newest class together with the next version upgrade.',
      1
    )
  );
  const days = c.certificatesExpiry ? Math.floor((new Date(c.certificatesExpiry).getTime() - now.getTime()) / DAY) : undefined;
  checks.push(
    check(
      'certs',
      'Lifecycle',
      'Certificates rotate automatically',
      c.certificateRotation === undefined && days === undefined
        ? 'unknown'
        : days !== undefined && days < 30
        ? 'fail'
        : c.certificateRotation?.enabled
        ? 'pass'
        : 'warn',
      `${c.certificateRotation?.enabled ? 'Rotation on' : c.certificateRotation ? 'Rotation off' : 'Rotation setting unknown'}${
        days !== undefined ? `; expire in ${days} days` : ''
      }.`,
      'Turn on certificate rotation in the cluster\'s settings.',
      2
    )
  );

  // Operations
  checks.push(
    check(
      'not-paused',
      'Operations',
      'Reconciliation running',
      c.paused ? 'fail' : 'pass',
      c.paused ? 'The cluster is paused.' : 'The Supervisor is reconciling this cluster.',
      'Resume the cluster when maintenance is finished.',
      1
    )
  );
  const leftover = c.nodePools.filter(p => p.nodeVolumeDetachTimeout || p.nodeDrainTimeout);
  const deletingPools = new Set(c.machines.filter(m => m.deletingSince).map(m => m.pool));
  const stale = leftover.filter(p => !deletingPools.has(p.name));
  checks.push(
    check(
      'timeouts',
      'Operations',
      'No leftover drain or volume timeouts',
      stale.length ? 'warn' : 'pass',
      stale.length ? `Timeouts set on ${list(stale.map(p => p.name))}.` : 'Pools wait for drains and volume detach normally.',
      'Clear them with Timeouts on the node pool once nothing is stuck deleting.',
      1
    )
  );
  const wc = workload?.checks;
  const signedIn = !!wc;
  const bh = hoursSinceSuccess(backups, now);
  checks.push(
    backups && !backups.error
      ? check(
          'backup',
          'Operations',
          'Backups running',
          backups.missing ? 'warn' : bh !== undefined && bh <= 7 * 24 ? 'pass' : backups.schedules.length ? 'fail' : 'warn',
          backups.missing
            ? 'Velero is not installed.'
            : bh !== undefined
            ? `Last successful backup ${Math.round(bh)} hours ago.`
            : backups.schedules.length
            ? 'Scheduled, but no backup has completed.'
            : 'Velero is installed but nothing is scheduled.',
          'Install Velero (a VKS standard package) and schedule regular backups.',
          2
        )
      : check(
          'backup',
          'Operations',
          'Backup installed',
          !signedIn || wc?.backup === undefined ? 'unknown' : wc.backup ? 'pass' : 'warn',
          !signedIn ? 'Sign in to the cluster to check.' : wc?.backup ? 'Velero found in the cluster.' : 'No Velero deployment found.',
          'Install Velero (a VKS standard package) and schedule backups.',
          2
        )
  );

  // Security and workload hygiene (inside the cluster)
  const unknownDetail = 'Sign in to the cluster to check.';
  checks.push(
    check(
      'privileged',
      'Security',
      'No privileged workload pods',
      !signedIn ? 'unknown' : wc!.privilegedPods.length ? 'fail' : 'pass',
      !signedIn ? unknownDetail : wc!.privilegedPods.length ? `Privileged: ${list(wc!.privilegedPods)}.` : `${wc!.podsChecked} user pods checked.`,
      'Remove privileged: true unless the workload truly needs host access.',
      2
    )
  );
  checks.push(
    check(
      'limits',
      'Security',
      'Containers set resource limits',
      !signedIn ? 'unknown' : wc!.podsWithoutLimits.length ? 'warn' : 'pass',
      !signedIn ? unknownDetail : wc!.podsWithoutLimits.length ? `${wc!.podsWithoutLimits.length} pod${wc!.podsWithoutLimits.length === 1 ? '' : 's'} without limits, e.g. ${list(wc!.podsWithoutLimits, 2)}.` : 'All user containers set limits.',
      'Set CPU and memory limits, or a LimitRange per namespace.',
      1
    )
  );
  checks.push(
    check(
      'latest',
      'Security',
      'Images pinned to a version',
      !signedIn ? 'unknown' : wc!.latestImages.length ? 'warn' : 'pass',
      !signedIn ? unknownDetail : wc!.latestImages.length ? `:latest or untagged: ${list(wc!.latestImages, 2)}.` : 'All user images use a tag or digest.',
      'Pin images to a version tag or digest, so restarts don\'t pull something new.',
      1
    )
  );
  checks.push(
    check(
      'pdb',
      'Resilience',
      'Replicated workloads have disruption budgets',
      !signedIn ? 'unknown' : wc!.unprotectedDeployments.length ? 'warn' : 'pass',
      !signedIn ? unknownDetail : wc!.unprotectedDeployments.length ? `No PodDisruptionBudget: ${list(wc!.unprotectedDeployments)}.` : 'Replicated deployments are covered.',
      'Add a PodDisruptionBudget (e.g. maxUnavailable: 1) so node drains and upgrades keep them available.',
      1
    )
  );

  // Packages (inside the cluster)
  const pk = packages && !packages.error ? packages.items : undefined;
  const failed = pk?.filter(p => p.state === 'failed') ?? [];
  const updates = pk?.filter(p => p.update) ?? [];
  checks.push(
    check(
      'packages-ok',
      'Operations',
      'Packages reconcile',
      !pk ? 'unknown' : failed.length ? 'fail' : 'pass',
      !pk ? packages?.error ?? 'Sign in to the cluster to check.' : failed.length ? `Failing: ${list(failed.map(p => shortPackage(p.refName)))}.` : `${pk.length} packages reconciled.`,
      "Read kapp-controller's error on the package install and fix its cause.",
      2
    )
  );
  checks.push(
    check(
      'packages-current',
      'Lifecycle',
      'Packages up to date',
      !pk ? 'unknown' : updates.length ? 'warn' : 'pass',
      !pk ? packages?.error ?? 'Sign in to the cluster to check.' : updates.length ? `Updates for ${list(updates.map(p => `${shortPackage(p.refName)} ${p.update}`))}.` : 'No newer versions in the package repositories.',
      'Update the packages, ideally together with the cluster upgrade that brings them.',
      1
    )
  );

  const evaluated = checks.filter(x => x.status !== 'unknown');
  const weightAll = evaluated.reduce((n, x) => n + x.weight, 0);
  const earned = evaluated.reduce((n, x) => n + x.weight * (x.status === 'pass' ? 1 : x.status === 'warn' ? 0.5 : 0), 0);
  return {
    clusterKey: c.key,
    score: weightAll ? Math.round((earned / weightAll) * 100) : 0,
    checks,
    evaluated: evaluated.length,
    total: checks.length,
  };
}
