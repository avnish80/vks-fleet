import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, MenuItem, TextField, Typography } from '@mui/material';
import { useFleetData } from '../fleetContext';
import { Configured, configuredByNamespace, Consumed, NamespaceLimits, OrgQuota, overcommit, resourceRows, ResourceRow, storageByClass } from '../limits';
import { UsageBar } from './InventoryViews';
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

function WhatIf({ ns, limits, configured }: { ns: NamespaceHeadroom; limits?: NamespaceLimits; configured?: Configured }) {
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
      {size && limits && configured && (limits.memoryLimitBytes || limits.cpuLimitMHz) && (
        <LimitWhatIf limits={limits} configured={configured} delta={delta} reserved={size.reserved ? delta.memoryBytes : 0} className={className} />
      )}
      {!size ? (
        <Typography variant="body2" color="text.secondary">This VM class's size isn't known.</Typography>
      ) : limits && limits.vmClasses.length > 0 && !limits.vmClasses.includes(className) ? (
        <StatusLabel status="error">{`${className} isn't allowed in ${ns.namespace}`}</StatusLabel>
      ) : lines.length === 0 ? (
        limits ? null : (
          <Typography variant="body2" color="text.secondary">
            No limits found for {ns.namespace}. With VCF Automation, quotas are read through the org's VCFA context (vcf
            context create); namespaces managed in vCenter show their limits here.
          </Typography>
        )
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

function ratioTone(r?: number): Tone {
  if (r === undefined || r <= 1) return 'success';
  if (r <= 2) return 'info';
  if (r <= 4) return 'warning';
  return 'error';
}

const x = (r?: number) => (r === undefined ? '—' : `${r < 10 ? r.toFixed(1) : Math.round(r)}×`);

/** What adding nodes does to the namespace's limits. */
function LimitWhatIf({
  limits,
  configured,
  delta,
  reserved,
  className,
}: {
  limits: NamespaceLimits;
  configured: Configured;
  delta: { cpus: number; memoryBytes: number };
  reserved: number;
  className: string;
}) {
  const before = overcommit(configured.memoryBytes, limits.memoryLimitBytes);
  const after = overcommit(configured.memoryBytes + delta.memoryBytes, limits.memoryLimitBytes);
  const reservedAfter = configured.reservedBytes + reserved;
  const reservationFits = !limits.memoryLimitBytes || reservedAfter <= limits.memoryLimitBytes;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mb: 1 }}>
      {limits.memoryLimitBytes && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <StatusLabel status={ratioTone(after) === 'error' ? 'error' : ratioTone(after) === 'warning' ? 'warning' : 'success'}>{`Memory ${x(before)} → ${x(after)}`}</StatusLabel>
          <Typography variant="body2">
            Configured memory against the {formatBytes(limits.memoryLimitBytes)} limit. Best-effort VMs can go over it; under load
            they then share the limit.
          </Typography>
        </Box>
      )}
      {reserved > 0 && (
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <StatusLabel status={reservationFits ? 'success' : 'error'}>{reservationFits ? 'Reservation fits' : "Reservation doesn't fit"}</StatusLabel>
          <Typography variant="body2">
            {className} reserves its memory: {formatBytes(reservedAfter)} reserved in total against the {formatBytes(limits.memoryLimitBytes ?? 0)} limit.
          </Typography>
        </Box>
      )}
      {limits.cpuLimitMHz && (
        <Typography variant="body2" color="text.secondary">
          CPU: {configured.vcpu + delta.cpus} vCPU would share the {(limits.cpuLimitMHz / 1000).toFixed(1)} GHz limit (a limit in MHz,
          so it can't be compared to vCPUs exactly).
        </Typography>
      )}
    </Box>
  );
}

/** A namespace's limits against what its VMs are configured with. */
function LimitsView({ limits, configured, storageUsed }: { limits: NamespaceLimits; configured?: Configured; storageUsed: Map<string, number> }) {
  const mem = overcommit(configured?.memoryBytes ?? 0, limits.memoryLimitBytes);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Typography variant="body2" color="text.secondary">
        {limits.source === 'vcfa'
          ? `From VCF Automation: namespace class ${limits.className ?? '?'}${limits.zones.length ? `, zone ${limits.zones.join(', ')}` : ''}.`
          : 'From the Supervisor (resource-pool limits set in vCenter).'}
      </Typography>
      {limits.memoryLimitBytes !== undefined && (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Memory: {formatBytes(configured?.memoryBytes ?? 0)} configured, {formatBytes(limits.memoryLimitBytes)} limit
            {mem !== undefined && mem > 1 ? ` (${x(mem)} overcommitted)` : ''}
          </Typography>
          <UsageBar
            used={configured?.memoryBytes ?? 0}
            total={limits.memoryLimitBytes}
            text={x(mem)}
            warn={0.99}
            crit={2}
          />
          {mem !== undefined && mem > 1 && (
            <Typography variant="caption" color="text.secondary">
              Best-effort VMs reserve nothing, so this is allowed, but under load they share {formatBytes(limits.memoryLimitBytes)} of real
              memory: expect ballooning and swapping.
            </Typography>
          )}
        </Box>
      )}
      {limits.cpuLimitMHz !== undefined && (
        <Typography variant="body2">
          <b>CPU:</b> {configured?.vcpu ?? 0} vCPU configured, sharing a {(limits.cpuLimitMHz / 1000).toFixed(1)} GHz limit
          {limits.cpuReservationMHz ? ` (${(limits.cpuReservationMHz / 1000).toFixed(1)} GHz reserved)` : ''}.
        </Typography>
      )}
      {limits.storage.map(st => {
        const used = storageUsed.get(st.storageClass) ?? 0;
        return (
          <Box key={st.storageClass}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Storage ({st.storageClass})
            </Typography>
            <UsageBar used={used} total={st.limitBytes} text={`${formatBytes(used)} of ${formatBytes(st.limitBytes)}`} />
          </Box>
        );
      })}
    </Box>
  );
}

const cores = (v: number) => (v >= 10 ? `${Math.round(v)}` : v.toFixed(1));

/** Limit, allocated, consumed and free, side by side. */
function ResourceTable({ rows }: { rows: ResourceRow[] }) {
  const fmt = (r: ResourceRow, v: number | undefined, col: 'limit' | 'allocated' | 'consumed') => {
    if (col === 'limit' && r.limitText) return r.limitText;
    if (v === undefined) return '—';
    if (r.unit === 'cpu') return col === 'limit' ? '—' : `${cores(v)} ${col === 'consumed' ? 'cores' : 'vCPU'}`;
    return formatBytes(v);
  };
  return (
    <SimpleTable
      columns={[
        { label: 'Resource', getter: (r: ResourceRow) => <b>{r.resource}</b> },
        { label: 'Limit', getter: (r: ResourceRow) => fmt(r, r.limit, 'limit') },
        { label: 'Allocated', getter: (r: ResourceRow) => fmt(r, r.allocated, 'allocated') },
        { label: 'Consumed', getter: (r: ResourceRow) => fmt(r, r.consumed, 'consumed') },
        { label: 'Free', getter: (r: ResourceRow) => (r.free === undefined ? '—' : formatBytes(r.free)) },
        {
          label: 'Against limit',
          getter: (r: ResourceRow) =>
            r.ratio === undefined ? (
              '—'
            ) : r.resource === 'Memory' ? (
              <StatusLabel status={r.ratio > 4 ? 'error' : r.ratio > 2 ? 'warning' : 'success'}>{`${x(r.ratio)} allocated`}</StatusLabel>
            ) : (
              <UsageBar used={r.consumed ?? 0} total={r.limit ?? 0} text={`${Math.round(r.ratio * 100)}% used`} />
            ),
        },
        { label: 'Note', getter: (r: ResourceRow) => r.note ?? '' },
      ]}
      data={rows}
    />
  );
}

function NamespaceCard({
  ns,
  usage,
  limits,
  configured,
  storageUsed,
  consumed,
  storage,
}: {
  ns: NamespaceHeadroom;
  usage: Map<string, { cpuPct: number; memPct: number }>;
  limits?: NamespaceLimits;
  configured?: Configured;
  storageUsed: Map<string, number>;
  consumed?: Consumed;
  storage: ReturnType<typeof storageByClass>;
}) {
  return (
    <SectionBox title={`${ns.tenantName}: ${ns.namespace}`}>
      <Box sx={{ mb: 2 }}>
        <ResourceTable rows={resourceRows(limits, configured, consumed, storage)} />
        <Typography variant="caption" color="text.secondary">
          Limit: what the namespace may use{limits ? (limits.source === 'vcfa' ? ` (VCF Automation, class ${limits.className ?? '?'})` : ' (vCenter)') : ''}.
          Allocated: what nodes and VMs are configured with (for storage, what volumes request). Consumed: what's in use now
          (metrics-server for CPU and memory; the storage quota for storage).
        </Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 2, mb: 2 }}>
        <Box>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>Limits</Typography>
          {limits ? (
            <LimitsView limits={limits} configured={configured} storageUsed={storageUsed} />
          ) : ns.quota.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No limits found. Namespaces created through VCF Automation keep their quota there: the plugin reads it through
              the org's VCFA context (vcf context create), when this Headlamp has one. Clusters here are configured with{' '}
              {configured?.vcpu ?? ns.used.cpus} vCPU and {formatBytes(configured?.memoryBytes ?? ns.used.memoryBytes)}.
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
                ...(limits?.vmClasses.length
                  ? [{ label: 'Allowed', getter: (c: VmClassInfo) => (limits.vmClasses.includes(c.name) ? 'Yes' : 'No') }]
                  : []),
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
        <WhatIf ns={ns} limits={limits} configured={configured} />
      </Box>
    </SectionBox>
  );
}

function OrgQuotaCard({ q, consumedByClass }: { q: OrgQuota; consumedByClass: Map<string, number> }) {
  return (
    <SectionBox title={`${q.org}: org quota${q.region ? ` in ${q.region}` : ''}`}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        From VCF Automation. "Allocated" is what this org has handed to its namespaces as their storage limits.
      </Typography>
      {q.storage.map(st => (
        <Box key={st.storageClass} sx={{ mb: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {st.storageClass}
          </Typography>
          <UsageBar used={st.allocatedBytes} total={st.capacityBytes} text={`${formatBytes(st.allocatedBytes)} of ${formatBytes(st.capacityBytes)} allocated`} />
          <Typography variant="caption" color="text.secondary">
            Consumed across the org's namespaces: {formatBytes(consumedByClass.get(st.storageClass) ?? 0)} · unallocated:{' '}
            {formatBytes(Math.max(0, st.capacityBytes - st.allocatedBytes))}
          </Typography>
        </Box>
      ))}
      {q.vmClasses.length > 0 && (
        <Typography variant="body2">
          VM class quotas: {q.vmClasses.map(v => `${v.vmClass}${v.limit !== undefined ? ` ${v.used ?? 0}/${v.limit}` : ''}`).join(', ')}
        </Typography>
      )}
    </SectionBox>
  );
}

export function CapacityPage() {
  const { config, results, inventory, limits, orgQuotas, limitProblems, quotaSources } = useFleetData();
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
  const configured = configuredByNamespace(results, inventory);
  const allQuotas = Array.from(inventory?.values() ?? []).flatMap(i => i.quotas);
  const allVolumes = Array.from(inventory?.values() ?? []).flatMap(i => i.volumes);
  const consumedFor = (ns: string): Consumed => {
    const cs = clusters.filter(c => c.namespace === ns);
    const us = cs.map(c => workload.byKey.get(c.key)?.utilisation).filter((u): u is NonNullable<typeof u> => !!u);
    return {
      cpuCores: us.reduce((n, u) => n + u.nodes.reduce((m, x) => m + x.cpuUsed, 0), 0),
      memoryBytes: us.reduce((n, u) => n + u.nodes.reduce((m, x) => m + x.memUsed, 0), 0),
      reporting: us.length,
      of: cs.length,
    };
  };
  const storageUsedFor = (ns: string) =>
    new Map(
      Array.from(inventory?.values() ?? [])
        .flatMap(i => i.quotas)
        .filter(q => q.namespace === ns)
        .map(q => [q.policy, q.used] as [string, number])
    );
  return (
    <>
      <ChartStyles />
      <SectionBox title="Capacity">
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Quota sources:
          </Typography>
          {quotaSources.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              no VCF Automation org context in Headlamp's kubeconfig (create one with vcf context create); vCenter-managed limits
              are read from the Supervisor.
            </Typography>
          ) : (
            quotaSources.map(q => (
              <StatusLabel
                key={q.org}
                status={q.status === 'ok' ? 'success' : q.status === 'reading' ? '' : q.status === 'no-context' ? 'warning' : 'error'}
              >
                {`${q.org}: ${
                  q.status === 'ok'
                    ? `read through "${q.context}" (${q.detail})`
                    : q.status === 'reading'
                    ? 'reading…'
                    : q.status === 'no-context'
                    ? `no org-level context named "${q.org}" in the kubeconfig`
                    : q.status === 'expired'
                    ? `sign-in expired (vcf context refresh ${q.org})`
                    : `failed: ${q.detail}`
                }`}
              </StatusLabel>
            ))
          )}
        </Box>
        <Alert severity="info">
          Per Supervisor namespace: quota against what's used, the VM classes it can use, what each cluster holds, the extra
          a rolling upgrade takes while it runs (one new node per pool plus one control-plane node), and a what-if for
          adding nodes. The vSphere cluster's own free capacity isn't visible through the Supervisor API.
        </Alert>
        {limitProblems.map(p => (
          <Alert key={p.org} severity={p.expired ? 'error' : 'warning'} sx={{ mt: 1 }}>
            {p.expired
              ? `The VCF Automation sign-in for ${p.org} has expired, so its quotas aren't shown. Run: vcf context refresh ${p.org}`
              : `Couldn't read ${p.org}'s quotas from VCF Automation: ${p.error}`}
          </Alert>
        ))}
      </SectionBox>
      {orgQuotas.map(q => (
        <OrgQuotaCard
          key={q.org}
          q={q}
          consumedByClass={
            new Map(
              q.storage.map(st => [
                st.storageClass,
                allQuotas
                  .filter(x => x.policy === st.storageClass && (results.flatMap(r => r.namespaces ?? []).find(n => n.name === x.namespace)?.tenantName === q.org || limits.get(x.namespace)?.source === 'vcfa'))
                  .reduce((n, x) => n + x.used, 0),
              ])
            )
          }
        />
      ))}
      {spaces.map(ns => (
        <NamespaceCard
          key={`${ns.supervisorId}/${ns.namespace}`}
          ns={ns}
          usage={usage}
          limits={limits.get(ns.namespace)}
          configured={configured.get(ns.namespace)}
          storageUsed={storageUsedFor(ns.namespace)}
          consumed={consumedFor(ns.namespace)}
          storage={storageByClass(
            limits.get(ns.namespace),
            allQuotas.filter(q => q.namespace === ns.namespace),
            allVolumes.filter(v => v.namespace === ns.namespace)
          )}
        />
      ))}
    </>
  );
}
