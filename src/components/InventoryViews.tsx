import { SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Typography } from '@mui/material';
import React, { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { formatDuration } from '../capi/v1beta1';
import { namespacePath, SUBNET_CRIT, SUBNET_WARN, vmPath } from '../inventoryIssues';
import { formatBytes } from '../quantity';
import { clusterPath } from '../routes';
import {
  FleetCluster,
  LbInfo,
  NsxObjectInfo,
  ServiceVm,
  StorageQuotaInfo,
  SubnetInfo,
  SupervisorNodes,
  VolumeInfo,
  VpcInfo,
} from '../types';
import { Tone, useTone } from './charts';

const age = (t?: string) => (t ? formatDuration(Date.now() - new Date(t).getTime()) : '—');

export function UsageBar({ used, total, text, warn = SUBNET_WARN, crit = SUBNET_CRIT }: { used: number; total: number; text?: string; warn?: number; crit?: number }) {
  const tone = useTone();
  const ratio = total ? Math.min(used / total, 1) : 0;
  const t: Tone = ratio >= crit ? 'error' : ratio >= warn ? 'warning' : 'success';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 160 }}>
      <Box sx={{ flex: 1, height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
        <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: tone(t) }} />
      </Box>
      <Typography variant="body2" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {text ?? `${used}/${total}`}
      </Typography>
    </Box>
  );
}

export function PowerLabel({ vm }: { vm: ServiceVm }) {
  if (vm.ready === false) return <StatusLabel status="error">Not ready</StatusLabel>;
  if (vm.power === 'PoweredOn') return <StatusLabel status="success">On</StatusLabel>;
  if (vm.power === 'Suspended') return <StatusLabel status="warning">Suspended</StatusLabel>;
  return <StatusLabel status="warning">{vm.power ? 'Off' : 'Unknown'}</StatusLabel>;
}

export function VmTable({ vms, showNamespace = true }: { vms: ServiceVm[]; showNamespace?: boolean }) {
  return (
    <SimpleTable
      columns={[
        { label: 'VM', getter: (v: ServiceVm) => <Link to={vmPath(v.supervisorId, v.namespace, v.name)}>{v.name}</Link> },
        ...(showNamespace
          ? [{ label: 'Namespace', getter: (v: ServiceVm) => <Link to={namespacePath(v.supervisorId, v.namespace)}>{v.namespace}</Link> }]
          : []),
        { label: 'State', getter: (v: ServiceVm) => <PowerLabel vm={v} /> },
        { label: 'Class', getter: (v: ServiceVm) => v.className ?? '—' },
        { label: 'Image', getter: (v: ServiceVm) => v.image ?? '—' },
        { label: 'IP', getter: (v: ServiceVm) => v.ip ?? '—' },
        { label: 'Network', getter: (v: ServiceVm) => v.interfaces.map(i => i.network).filter(Boolean).join(', ') || '—' },
        { label: 'Disks', getter: (v: ServiceVm) => v.volumes.length },
        { label: 'Snapshots', getter: (v: ServiceVm) => v.snapshots.length || '—' },
        { label: 'Age', getter: (v: ServiceVm) => age(v.createdAt) },
      ]}
      data={vms}
    />
  );
}

const LB_KIND: Record<LbInfo['kind'], string> = {
  'cluster-api': 'Cluster API',
  'guest-service': 'Service in a cluster',
  vm: 'VM',
  other: 'Other',
};

export function LbTable({ lbs, clusters, showNamespace = true }: { lbs: LbInfo[]; clusters: FleetCluster[]; showNamespace?: boolean }) {
  const clusterOf = (lb: LbInfo) => clusters.find(c => c.namespace === lb.namespace && c.name === lb.cluster);
  return (
    <SimpleTable
      columns={[
        { label: 'VIP', getter: (l: LbInfo) => (l.vip ? <b>{l.vip}</b> : <StatusLabel status="warning">No IP yet</StatusLabel>) },
        { label: 'Ports', getter: (l: LbInfo) => l.ports.map(p => p.port).join(', ') || '—' },
        { label: 'Serves', getter: (l: LbInfo) => LB_KIND[l.kind] },
        {
          label: 'Target',
          getter: (l: LbInfo) => {
            const c = clusterOf(l);
            const cl = c ? <Link to={clusterPath(c)}>{c.name}</Link> : l.cluster;
            if (l.kind === 'guest-service') return <>{l.guestService} in {cl}</>;
            if (l.kind === 'cluster-api') return <>API of {cl}</>;
            if (l.vms.length)
              return (
                <>
                  {l.vms.map((v, i) => (
                    <React.Fragment key={v}>
                      {i ? ', ' : ''}
                      <Link to={vmPath(l.supervisorId, l.namespace, v)}>{v}</Link>
                    </React.Fragment>
                  ))}
                </>
              );
            return '—';
          },
        },
        ...(showNamespace
          ? [{ label: 'Namespace', getter: (l: LbInfo) => <Link to={namespacePath(l.supervisorId, l.namespace, 'lbs')}>{l.namespace}</Link> }]
          : []),
        { label: 'Service object', getter: (l: LbInfo) => l.name },
      ]}
      data={[...lbs].sort((a, b) => (a.vip ?? '~').localeCompare(b.vip ?? '~', undefined, { numeric: true }))}
    />
  );
}

export function SubnetTable({ subnets, showNamespace = true }: { subnets: SubnetInfo[]; showNamespace?: boolean }) {
  return (
    <SimpleTable
      columns={[
        { label: 'Name', getter: (s: SubnetInfo) => s.name },
        { label: 'Kind', getter: (s: SubnetInfo) => (s.kind === 'SubnetSet' ? 'Subnet set' : 'Subnet') },
        ...(showNamespace
          ? [{ label: 'Namespace', getter: (s: SubnetInfo) => <Link to={namespacePath(s.supervisorId, s.namespace, 'network')}>{s.namespace}</Link> }]
          : []),
        { label: 'Access', getter: (s: SubnetInfo) => s.accessMode ?? '—' },
        { label: 'CIDR', getter: (s: SubnetInfo) => s.cidrs.join(', ') || 'none yet' },
        { label: 'Used', getter: (s: SubnetInfo) => (s.capacity ? <UsageBar used={s.used} total={s.capacity} /> : '—') },
        { label: 'Attached', getter: (s: SubnetInfo) => s.members.join(', ') || '—' },
        {
          label: 'State',
          getter: (s: SubnetInfo) =>
            s.ready === false ? <StatusLabel status="error">{s.message ?? 'Not ready'}</StatusLabel> : s.ready ? <StatusLabel status="success">Ready</StatusLabel> : '—',
        },
      ]}
      data={[...subnets].sort((a, b) => (b.capacity ? b.used / b.capacity : 0) - (a.capacity ? a.used / a.capacity : 0))}
    />
  );
}

export function NsxTable({ objects }: { objects: NsxObjectInfo[] }) {
  return (
    <SimpleTable
      columns={[
        { label: 'Kind', getter: (o: NsxObjectInfo) => o.kind },
        { label: 'Name', getter: (o: NsxObjectInfo) => o.name },
        { label: 'Namespace', getter: (o: NsxObjectInfo) => o.namespace ?? '—' },
        { label: 'Details', getter: (o: NsxObjectInfo) => o.detail || '—' },
        {
          label: 'State',
          getter: (o: NsxObjectInfo) =>
            o.ready === false ? <StatusLabel status="error">{o.message || 'Not ready'}</StatusLabel> : o.ready ? <StatusLabel status="success">Ready</StatusLabel> : '—',
        },
      ]}
      data={objects}
    />
  );
}

export function QuotaBars({ quotas }: { quotas: StorageQuotaInfo[] }) {
  if (!quotas.length) return <Typography color="text.secondary">No storage quotas readable.</Typography>;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {quotas.map(q => (
        <Box key={`${q.namespace}/${q.policy}`}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {q.policy} ({q.namespace})
          </Typography>
          <UsageBar used={q.used} total={q.limit} text={`${formatBytes(q.used)} of ${formatBytes(q.limit)}`} />
          <Typography variant="caption" color="text.secondary">
            {Object.entries(q.bySource)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${k}: ${formatBytes(v)}`)
              .join(' · ') || 'Nothing stored yet'}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

export function VolumeTable({ volumes }: { volumes: VolumeInfo[] }) {
  return (
    <SimpleTable
      columns={[
        { label: 'Volume', getter: (v: VolumeInfo) => v.name },
        { label: 'Size', getter: (v: VolumeInfo) => (v.size ? formatBytes(v.size) : '—') },
        { label: 'Storage class', getter: (v: VolumeInfo) => v.storageClass ?? '—' },
        { label: 'Used by', getter: (v: VolumeInfo) => v.usedBy ?? '—' },
        {
          label: 'State',
          getter: (v: VolumeInfo) => <StatusLabel status={v.phase === 'Bound' ? 'success' : 'warning'}>{v.phase ?? 'Unknown'}</StatusLabel>,
        },
      ]}
      data={volumes}
    />
  );
}

/** One namespace's network at a glance: its VPC, each subnet with what's on it, and the public addresses. */
export function NetworkMap({
  vpcs,
  subnets,
  lbs,
  vms,
}: {
  vpcs: VpcInfo[];
  subnets: SubnetInfo[];
  lbs: LbInfo[];
  vms: ServiceVm[];
}) {
  const tone = useTone();
  const vpc = vpcs[0];
  const box = (children: ReactNode, accent: Tone, key?: string) => (
    <Box key={key} sx={{ border: 1, borderColor: 'divider', borderLeft: '4px solid', borderLeftColor: tone(accent), borderRadius: 1, p: 1.25, minWidth: 0 }}>
      {children}
    </Box>
  );
  const ipOwner = (ip: string) => vms.find(v => v.ip === ip)?.name;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {vpc &&
        box(
          <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            <Typography sx={{ fontWeight: 600 }}>VPC {vpc.name}</Typography>
            {vpc.stack && <Typography variant="body2">{vpc.stack}</Typography>}
            {vpc.privateIPs.length > 0 && <Typography variant="body2">Private {vpc.privateIPs.join(', ')}</Typography>}
            {vpc.snatIP && <Typography variant="body2">Outbound NAT {vpc.snatIP}</Typography>}
          </Box>,
          'primary'
        )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 }}>
        {subnets.map(s =>
          box(
            <>
              <Typography sx={{ fontWeight: 600 }} noWrap title={s.name}>
                {s.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {s.accessMode ?? s.kind} · {s.cidrs.join(', ') || 'no range yet'}
              </Typography>
              {s.capacity > 0 && <UsageBar used={s.used} total={s.capacity} />}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.75 }}>
                {s.members.map(m => (
                  <Box key={m} sx={{ px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.75rem' }}>
                    {m}
                  </Box>
                ))}
              </Box>
            </>,
            s.ready === false ? 'error' : s.accessMode === 'Public' ? 'info' : 'success',
            `${s.kind}/${s.name}`
          )
        )}
      </Box>
      {lbs.length > 0 &&
        box(
          <>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Public addresses</Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {lbs.map(l => (
                <Box key={l.name} sx={{ px: 1, py: 0.5, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.8rem' }}>
                  <b>{l.vip ?? 'pending'}</b> →{' '}
                  {l.kind === 'guest-service'
                    ? `${l.guestService} (${l.cluster})`
                    : l.kind === 'cluster-api'
                    ? `${l.cluster} API`
                    : l.vms.join(', ') || l.name}
                </Box>
              ))}
              {vms
                .filter(v => v.ip && subnets.some(s => s.accessMode === 'Public' && s.cidrs.length && s.members.includes(`VM ${v.name}`)))
                .map(v => (
                  <Box key={v.name} sx={{ px: 1, py: 0.5, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.8rem' }}>
                    <b>{v.ip}</b> → VM {ipOwner(v.ip!)} (public subnet)
                  </Box>
                ))}
            </Box>
          </>,
          'info'
        )}
    </Box>
  );
}

export function SupervisorPanel({ nodes }: { nodes?: SupervisorNodes }) {
  if (!nodes) return null;
  return (
    <SectionBox title="Supervisor">
      <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <Box>
          <Typography variant="body2" color="text.secondary">
            Control plane
          </Typography>
          <Typography>
            <StatusLabel status={nodes.controlPlaneReady < nodes.controlPlane ? 'error' : nodes.controlPlane === 1 ? 'warning' : 'success'}>
              {`${nodes.controlPlaneReady}/${nodes.controlPlane} ready`}
            </StatusLabel>{' '}
            {nodes.controlPlane === 1 ? '(single node, not highly available)' : ''}
          </Typography>
        </Box>
        <Box>
          <Typography variant="body2" color="text.secondary">
            ESXi hosts
          </Typography>
          <StatusLabel status={nodes.hostsReady < nodes.hosts ? 'error' : 'success'}>{`${nodes.hostsReady}/${nodes.hosts} ready`}</StatusLabel>
        </Box>
        <Box>
          <Typography variant="body2" color="text.secondary">
            Versions
          </Typography>
          <Typography variant="body2">
            Kubernetes {nodes.version ?? '?'} · Spherelet {nodes.hostVersion ?? '?'}
          </Typography>
        </Box>
      </Box>
    </SectionBox>
  );
}
