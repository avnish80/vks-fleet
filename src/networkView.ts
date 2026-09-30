/**
 * How subnets are shown: attachments grouped per cluster (a cluster's nodes are
 * one chip, not one line each), secondary networks recognised, and a useful order.
 */
import { shortener, shortNode } from './names';
import { ServiceVm, SubnetInfo } from './types';

export interface Attachment {
  label: string;
  /** Full names, for the tooltip. */
  title: string;
  kind: 'cluster' | 'vm';
  /** A cluster's nodes on a network that isn't the cluster's own (a second NIC, as with Multus). */
  secondary?: boolean;
}

export function groupAttachments(s: SubnetInfo, vms: ServiceVm[], allClusters: string[] = []): Attachment[] {
  const own = new Set<string>();
  const nodes = new Map<string, string[]>();
  const standalone: string[] = [];
  for (const m of s.members) {
    if (m.startsWith('cluster ')) {
      own.add(m.slice(8));
      continue;
    }
    const name = m.startsWith('VM ') ? m.slice(3) : m;
    const cluster = vms.find(v => v.name === name && v.namespace === s.namespace)?.cluster;
    if (cluster) nodes.set(cluster, [...(nodes.get(cluster) ?? []), name]);
    else standalone.push(name);
  }
  const clusters = Array.from(new Set([...own, ...nodes.keys()])).sort();
  // Shorten against every cluster these VMs belong to, not only this subnet's (one cluster alone has no shared prefix).
  const known = vms.map(v => v.cluster).filter((c): c is string => !!c);
  const short = shortener(Array.from(new Set([...allClusters, ...known, ...clusters])));
  const plural = (n: number) => `${n} node${n === 1 ? '' : 's'}`;
  return [
    ...clusters.map(c => {
      const n = nodes.get(c) ?? [];
      const isOwn = own.has(c);
      return {
        kind: 'cluster' as const,
        secondary: !isOwn,
        label: isOwn ? `${short(c)} · cluster${n.length ? ` + ${plural(n.length)}` : ''}` : `${short(c)} · ${plural(n.length)} · secondary`,
        title: `${c}${n.length ? `: ${n.map(x => shortNode(c, x)).join(', ')}` : ''}${isOwn ? '' : '\nA second network for these nodes (for example through Multus).'}`,
      };
    }),
    ...standalone.sort().map(v => ({ kind: 'vm' as const, label: v, title: `VM ${v}` })),
  ];
}

export type SubnetGroup = 'cluster' | 'used' | 'public' | 'unused';

export function subnetGroup(s: SubnetInfo): SubnetGroup {
  if (s.members.some(m => m.startsWith('cluster '))) return 'cluster';
  if (!s.members.length && !s.used) return 'unused';
  if (s.accessMode === 'Public') return 'public';
  return 'used';
}

const ORDER: Record<SubnetGroup, number> = { cluster: 0, used: 1, public: 2, unused: 3 };
const fill = (s: SubnetInfo) => (s.capacity ? s.used / s.capacity : 0);

/** Cluster networks, then subnets in use (fullest first), then public, then unused. */
export function orderSubnets(subnets: SubnetInfo[]): SubnetInfo[] {
  return [...subnets].sort((a, b) => ORDER[subnetGroup(a)] - ORDER[subnetGroup(b)] || fill(b) - fill(a) || a.name.localeCompare(b.name));
}
