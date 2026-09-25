import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, MenuItem, TextField, Typography } from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link } from 'react-router-dom';
import { classSize, fits, NamespaceHeadroom, namespaceHeadroom, QuotaLine, upgradeSurge } from '../headroom';
import { formatBytes } from '../quantity';
import { clusterPath } from '../routes';
import { FleetCluster, VmClassInfo } from '../types';
import { useWorkloadHealth } from '../useWorkload';
import { BarList, ChartStyles, Tone } from './charts';

function amount(kind: QuotaLine['kind'], v: number): string {
  return kind === 'cpu' ? `${Math.round(v * 10) / 10} vCPU` : formatBytes(v);
}

function usageTone(ratio: number): Tone {
  if (ratio >= 0.95) return 'error';
  if (ratio >= 0.8) return 'warning';
  return 'success';
}

function WhatIf({ ns }: { ns: NamespaceHeadroom }) {
  const [clusterKey, setClusterKey] = React.useState(ns.clusters[0]?.key ?? '');
  const cluster = ns.clusters.find(c => c.key === clusterKey) ?? ns.clusters[0];
  const [pool, setPool] = React.useState(cluster?.nodePools[0]?.name ?? '');
  const poolInfo = cluster?.nodePools.find(p => p.name === pool);
  const [cls, setCls] = React.useState<string>('');
  const className = cls || poolInfo?.vmClass || ns.classes[0]?.name || '';
  const [count, setCount] = React.useState('1');
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const size = classSize(ns.classes, ns.namespace, className);
  const delta = { cpus: (size?.cpus ?? 0) * n, memoryBytes: (size?.memoryBytes ?? 0) * n };
  const lines = fits(ns.quota, delta);
  if (!cluster) return null;
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
      <Typography sx={{ fontWeight: 600, mb: 1.5 }}>What if I add nodes?</Typography>
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <TextField select size="small" label="Cluster" value={cluster.key} onChange={e => setClusterKey(e.target.value)} sx={{ minWidth: 200 }}>
          {ns.clusters.map(c => (
            <MenuItem key={c.key} value={c.key}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="Node pool" value={pool} onChange={e => setPool(e.target.value)} sx={{ minWidth: 180 }}>
          {cluster.nodePools.map(p => (
            <MenuItem key={p.name} value={p.name}>
              {p.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label="VM class" value={className} onChange={e => setCls(e.target.value)} sx={{ minWidth: 220 }}>
          {ns.classes.map(c => (
            <MenuItem key={c.name} value={c.name}>
              {c.name} ({c.cpus ?? '?'} vCPU, {c.memoryBytes ? formatBytes(c.memoryBytes) : '?'})
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" type="number" label="Nodes to add" value={count} onChange={e => setCount(e.target.value)} sx={{ width: 130 }} inputProps={{ min: 0 }} />
      </Box>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {n} × {className || 'VM class'} = <b>{delta.cpus} vCPU</b> and <b>{formatBytes(delta.memoryBytes)}</b> more.
        {poolInfo?.vmClass && className !== poolInfo.vmClass ? ` Note: pool ${pool} uses ${poolInfo.vmClass}; changing its class replaces every node in it.` : ''}
      </Typography>
      {!size ? (
        <Typography variant="body2" color="text.secondary">This VM class's size isn't known.</Typography>
      ) : lines.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No CPU or memory quota on {ns.namespace}, so only the vSphere cluster's own capacity limits this (the Supervisor API
          doesn't show that).
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {lines.map(l => (
            <Box key={l.resource} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <StatusLabel status={l.fits ? 'success' : 'error'}>{l.fits ? 'Fits' : "Doesn't fit"}</StatusLabel>
              <Typography variant="body2">
                {l.resource}: needs {amount(l.kind, l.needed)}, {amount(l.kind, l.free)} free
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function NamespaceCard({ ns, usage }: { ns: NamespaceHeadroom; usage: Map<string, { cpuPct: number; memPct: number }> }) {
  return (
    <SectionBox title={`${ns.tenantName}: ${ns.namespace}`}>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 2, mb: 2 }}>
        <Box>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>Quota</Typography>
          {ns.quota.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No quota set on this namespace. Clusters here use {ns.used.cpus} vCPU and {formatBytes(ns.used.memoryBytes)}.
            </Typography>
          ) : (
            <BarList
              max={1}
              rows={ns.quota.map(q => ({
                key: q.resource,
                label: q.resource,
                parts: [{ label: 'Used', value: q.hard ? q.used / q.hard : 0, tone: usageTone(q.hard ? q.used / q.hard : 0) }],
                valueText: `${amount(q.kind, q.used)} of ${amount(q.kind, q.hard)}`,
              }))}
            />
          )}
        </Box>
        <Box>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>VM classes available</Typography>
          {ns.classes.length === 0 ? (
            <Typography variant="body2" color="text.secondary">None readable.</Typography>
          ) : (
            <SimpleTable
              columns={[
                { label: 'Class', getter: (c: VmClassInfo) => c.name },
                { label: 'vCPU', getter: (c: VmClassInfo) => c.cpus ?? '—' },
                { label: 'Memory', getter: (c: VmClassInfo) => (c.memoryBytes ? formatBytes(c.memoryBytes) : '—') },
                { label: 'Type', getter: (c: VmClassInfo) => (c.reserved ? 'Guaranteed' : 'Best effort') },
              ]}
              data={ns.classes}
            />
          )}
        </Box>
      </Box>
      <Typography sx={{ fontWeight: 600, mb: 1 }}>Clusters</Typography>
      <SimpleTable
        columns={[
          { label: 'Cluster', getter: (c: FleetCluster) => <Link to={clusterPath(c)}>{c.name}</Link> },
          { label: 'Nodes', getter: (c: FleetCluster) => c.machines.filter(m => !m.deletingSince).length },
          { label: 'Allocated', getter: (c: FleetCluster) => (c.capacity ? `${c.capacity.cpus} vCPU, ${formatBytes(c.capacity.memoryBytes)}` : '—') },
          {
            label: 'In use (metrics)',
            getter: (c: FleetCluster) => {
              const u = usage.get(c.key);
              return u ? `CPU ${u.cpuPct}%, memory ${u.memPct}%` : '—';
            },
          },
          {
            label: 'Extra during an upgrade',
            getter: (c: FleetCluster) => {
              const s = upgradeSurge(c, ns.classes);
              if (!s.cpus && !s.memoryBytes) return '—';
              const tight = fits(ns.quota, s).filter(f => !f.fits);
              return (
                <Box>
                  <Typography variant="body2">
                    {s.cpus} vCPU, {formatBytes(s.memoryBytes)}
                  </Typography>
                  {ns.quota.length > 0 && (
                    <StatusLabel status={tight.length ? 'error' : 'success'}>{tight.length ? 'Not enough quota' : 'Fits quota'}</StatusLabel>
                  )}
                </Box>
              );
            },
          },
        ]}
        data={ns.clusters}
      />
      <Box sx={{ mt: 2 }}>
        <WhatIf ns={ns} />
      </Box>
    </SectionBox>
  );
}

export function CapacityPage() {
  const { config, results } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  if (results === null) return <Loader title="Loading capacity" />;
  const usage = new Map(
    clusters
      .map(c => [c.key, workload.byKey.get(c.key)?.utilisation] as const)
      .filter((x): x is readonly [string, NonNullable<(typeof x)[1]>] => !!x[1])
      .map(([k, u]) => [k, { cpuPct: u.cpuPct, memPct: u.memPct }])
  );
  const spaces = namespaceHeadroom(results);
  return (
    <>
      <ChartStyles />
      <SectionBox title="Capacity">
        <Alert severity="info">
          Per Supervisor namespace: quota against what's used, the VM classes it can use, what each cluster holds, the extra
          a rolling upgrade takes while it runs (one new node per pool plus one control-plane node), and a what-if for
          adding nodes. The vSphere cluster's own free capacity isn't visible through the Supervisor API.
        </Alert>
      </SectionBox>
      {spaces.map(ns => (
        <NamespaceCard key={`${ns.supervisorId}/${ns.namespace}`} ns={ns} usage={usage} />
      ))}
    </>
  );
}
