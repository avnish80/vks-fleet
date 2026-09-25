/**
 * Issues from the namespace inventory: VMs, subnets running out of
 * addresses, load balancers without an IP, NSX objects that failed to apply,
 * storage quotas nearly used up, and the Supervisor's own nodes.
 */
import { formatDuration } from './capi/v1beta1';
import { formatBytes } from './quantity';
import { NAMESPACE_BASE, VM_BASE } from './routes';
import { Inventory, Issue, Severity } from './types';

export const SUBNET_WARN = 0.85;
export const SUBNET_CRIT = 0.95;
export const QUOTA_WARN = 0.85;
const LB_GRACE_MS = 5 * 60 * 1000;
const OLD_SNAPSHOT_MS = 7 * 86400000;

export const namespacePath = (supervisorId: string, ns: string, hash?: string) =>
  `${NAMESPACE_BASE}/${encodeURIComponent(supervisorId)}/${encodeURIComponent(ns)}${hash ? `#${hash}` : ''}`;
export const vmPath = (supervisorId: string, ns: string, name: string) =>
  `${VM_BASE}/${encodeURIComponent(supervisorId)}/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`;

function issue(
  inv: Inventory,
  id: string,
  severity: Severity,
  namespace: string | undefined,
  title: string,
  cause: string,
  fix: string,
  primary: { label: string; path: string },
  now: Date,
  extra: Partial<Issue> = {}
): Issue {
  return {
    id: `${inv.supervisorId}#inv#${id}`,
    severity,
    supervisorId: inv.supervisorId,
    namespace,
    title,
    cause,
    evidence: [],
    affected: { clusters: [], tenants: [], nodes: [], pods: [] },
    fix,
    primary,
    links: [],
    findingIds: [],
    detectedAt: now.toISOString(),
    ...extra,
  };
}

export function inventoryIssues(inv: Inventory, sup: string, now: Date = new Date()): Issue[] {
  const out: Issue[] = [];
  const s = `kubectl --context ${sup}`;

  for (const vm of inv.vms.filter(v => !v.cluster)) {
    const where = vmPath(inv.supervisorId, vm.namespace, vm.name);
    if (vm.ready === false) {
      out.push(
        issue(inv, `vm-${vm.namespace}/${vm.name}`, 'warning', vm.namespace, `VM ${vm.name} is not ready`, vm.readyMessage ?? 'VM Operator reports a condition that is not met.',
          "Read the VM's conditions and events; common causes are the image, the VM class or the network.", { label: `VM ${vm.name}`, path: where }, now, {
            runbook: [
              { title: 'Conditions and recent events', commands: [`${s} describe vm -n ${vm.namespace} ${vm.name} | sed -n '/Conditions/,$p' | head -40`] },
              { title: 'Warnings in the namespace', commands: [`${s} get events -n ${vm.namespace} --field-selector involvedObject.name=${vm.name},type=Warning`] },
            ],
          })
      );
    } else if (vm.power && vm.power !== 'PoweredOn') {
      out.push(
        issue(inv, `vm-off-${vm.namespace}/${vm.name}`, 'info', vm.namespace, `VM ${vm.name} is ${vm.power === 'Suspended' ? 'suspended' : 'powered off'}`,
          'Nothing it serves is reachable while it is off.', 'If that is unexpected, power it on from its page.', { label: `VM ${vm.name}`, path: where }, now)
      );
    }
    for (const snap of vm.snapshots) {
      if (snap.createdAt && now.getTime() - new Date(snap.createdAt).getTime() > OLD_SNAPSHOT_MS) {
        out.push(
          issue(inv, `snap-${vm.namespace}/${snap.name}`, 'info', vm.namespace, `Snapshot ${snap.name} of ${vm.name} is ${formatDuration(now.getTime() - new Date(snap.createdAt).getTime())} old`,
            'Old snapshots grow, slow the VM down and use storage quota.', "Delete it once it's no longer needed.", { label: `VM ${vm.name}`, path: where }, now, {
              runbook: [{ title: 'Delete the snapshot', commands: [`${s} delete virtualmachinesnapshot -n ${vm.namespace} ${snap.name}`] }],
            })
        );
      }
    }
  }

  for (const sn of inv.subnets) {
    const where = namespacePath(inv.supervisorId, sn.namespace, 'network');
    if (sn.ready === false) {
      out.push(issue(inv, `subnet-${sn.namespace}/${sn.name}`, 'warning', sn.namespace, `${sn.kind} ${sn.name} is not ready`, sn.message ?? 'NSX has not realised it.',
        'Check the NSX operator events for it; workloads on it cannot get addresses.', { label: 'Networking', path: where }, now, {
          runbook: [{ title: 'Status and events', commands: [`${s} describe ${sn.kind.toLowerCase()} -n ${sn.namespace} ${sn.name} | tail -25`] }],
        }));
    }
    const ratio = sn.capacity ? sn.used / sn.capacity : 0;
    if (sn.capacity && ratio >= SUBNET_WARN) {
      out.push(issue(inv, `subnet-full-${sn.namespace}/${sn.name}`, ratio >= SUBNET_CRIT ? 'critical' : 'warning', sn.namespace,
        `${sn.kind} ${sn.name} is ${Math.round(ratio * 100)}% used (${sn.used} of ${sn.capacity} addresses)`,
        `Addresses in ${sn.cidrs.join(', ')} are running out; new VMs, nodes or pods on it will fail to get one.`,
        'Remove what is no longer needed, or add a larger subnet (and move workloads to it).', { label: 'Networking', path: where }, now, {
          evidence: sn.members.slice(0, 6),
          runbook: [{ title: 'Ports on the subnet', commands: [`${s} get subnetports -n ${sn.namespace} -o wide | head -40`] }],
        }));
    }
  }

  for (const lb of inv.lbs) {
    if (lb.vip || !lb.createdAt || now.getTime() - new Date(lb.createdAt).getTime() < LB_GRACE_MS) continue;
    out.push(issue(inv, `lb-${lb.namespace}/${lb.name}`, 'warning', lb.namespace, `Load balancer ${lb.name} has no IP`,
      `Created ${formatDuration(now.getTime() - new Date(lb.createdAt).getTime())} ago and still without an external address${lb.guestService ? ` (serves ${lb.guestService} in ${lb.cluster})` : ''}.`,
      "Usually the VPC's external IP block is exhausted; check the Supervisor's events for the service.", { label: 'Load balancers', path: namespacePath(inv.supervisorId, lb.namespace, 'lbs') }, now, {
        runbook: [
          { title: 'Service status and events', commands: [`${s} describe virtualmachineservice -n ${lb.namespace} ${lb.name} | tail -20`] },
          { title: 'IP allocations in the namespace', commands: [`${s} get ipaddressallocations.crd.nsx.vmware.com -n ${lb.namespace}`] },
        ],
      }));
  }

  for (const o of inv.nsx) {
    if (o.ready !== false) continue;
    const isError = o.kind === 'NSXError';
    out.push(issue(inv, `nsx-${o.kind}-${o.namespace ?? ''}/${o.name}`, 'warning', o.namespace,
      isError ? `NSX error: ${o.name}` : `${o.kind} ${o.name} did not apply`, o.message || 'NSX reports it as not ready.',
      isError ? 'Look at the NSX error and the object it names.' : 'Check its status message and fix the spec (rules, CIDRs or names it refers to).',
      o.namespace ? { label: 'Networking', path: namespacePath(inv.supervisorId, o.namespace, 'network') } : { label: 'Network', path: '/vks-fleet/network' }, now, {
        runbook: [{ title: 'Details', commands: [isError ? `${s} get nsxerrors ${o.name} -o yaml` : `${s} describe ${o.kind.toLowerCase()} -n ${o.namespace} ${o.name} | tail -25`] }],
      }));
  }

  for (const q of inv.quotas) {
    const ratio = q.limit ? q.used / q.limit : 0;
    if (!q.limit || ratio < QUOTA_WARN) continue;
    out.push(issue(inv, `quota-${q.namespace}/${q.policy}`, ratio >= SUBNET_CRIT ? 'critical' : 'warning', q.namespace,
      `Storage quota for ${q.policy} in ${q.namespace} is ${Math.round(ratio * 100)}% used`,
      `${formatBytes(q.used)} of ${formatBytes(q.limit)}: ${Object.entries(q.bySource).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${formatBytes(v)}`).join(', ')}.`,
      'New volumes, VM disks and snapshots will be refused when it is full. Clean up, or raise the quota in VCF Automation or vCenter.',
      { label: 'Storage', path: namespacePath(inv.supervisorId, q.namespace, 'storage') }, now));
  }

  const n = inv.supervisorNodes;
  if (n) {
    if (n.controlPlaneReady < n.controlPlane || n.hostsReady < n.hosts) {
      out.push(issue(inv, 'sv-nodes', n.controlPlaneReady < n.controlPlane ? 'critical' : 'warning', undefined, 'Supervisor nodes are not all ready',
        `${n.controlPlaneReady} of ${n.controlPlane} control-plane nodes and ${n.hostsReady} of ${n.hosts} ESXi hosts are ready.`,
        'Check the Supervisor in vCenter (Workload Management) and the hosts that are not ready.', { label: 'Supervisor', path: `${NAMESPACE_BASE}#supervisor` }, now, {
          runbook: [{ title: 'Node status', commands: [`${s} get nodes -o wide`] }],
        }));
    } else if (n.controlPlane === 1) {
      out.push(issue(inv, 'sv-single-cp', 'info', undefined, 'The Supervisor has a single control-plane node',
        "Fine for a lab; elsewhere, losing that VM takes the Supervisor API (and cluster management) down until it's back.",
        'Consider the three-node Supervisor control plane for production.', { label: 'Supervisor', path: `${NAMESPACE_BASE}#supervisor` }, now));
    }
  }
  return out;
}
