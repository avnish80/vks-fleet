import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import React, { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { vmPowerPlan, vmRestartPlan, vmSnapshotPlan, ActionPlan } from '../actions';
import { supervisorWriter } from '../api/headlampClient';
import { formatDuration } from '../capi/v1beta1';
import { useFleetData } from '../fleetContext';
import { namespacePath } from '../inventoryIssues';
import { formatBytes } from '../quantity';
import { clusterPath } from '../routes';
import { FleetCluster, Inventory, ServiceVm, SupervisorResult } from '../types';
import { NamespaceAccess } from './AccessPanel';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile } from './charts';
import {
  LbTable,
  NetworkMap,
  NsxTable,
  PowerLabel,
  QuotaBars,
  SubnetTable,
  SupervisorPanel,
  UsageBar,
  VmTable,
  VolumeTable,
} from './InventoryViews';

type NsRow = { r: SupervisorResult; inv?: Inventory; name: string; tenantName: string; clusters: FleetCluster[] };

function useNamespaces(): { rows: NsRow[] | null; loading: boolean } {
  const { results, inventory } = useFleetData();
  if (!results) return { rows: null, loading: true };
  const rows = results.flatMap(r =>
    (r.namespaces ?? []).map(n => ({
      r,
      inv: inventory?.get(r.supervisor.id),
      name: n.name,
      tenantName: n.tenantName,
      clusters: r.clusters.filter(c => c.namespace === n.name),
    }))
  );
  return { rows, loading: inventory === null };
}

const only = <T extends { namespace?: string }>(xs: T[] | undefined, ns: string) => (xs ?? []).filter(x => x.namespace === ns);

export function NamespacesPage() {
  const { rows } = useNamespaces();
  const { inventory } = useFleetData();
  if (!rows) return <Loader title="Loading namespaces" />;
  const nodes = inventory ? Array.from(inventory.values()).find(i => i.supervisorNodes)?.supervisorNodes : undefined;
  const byOrg = new Map<string, NsRow[]>();
  for (const r of rows) byOrg.set(r.tenantName, [...(byOrg.get(r.tenantName) ?? []), r]);
  return (
    <>
      <ChartStyles />
      <Box id="supervisor" />
      <SupervisorPanel nodes={nodes} />
      {rows.length === 0 && (
        <SectionBox title="Namespaces">
          <Typography color="text.secondary">No org namespaces found.</Typography>
        </SectionBox>
      )}
      {Array.from(byOrg.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([org, list]) => (
          <SectionBox key={org} title={`${org}: namespaces`}>
            <SimpleTable
              columns={[
                { label: 'Namespace', getter: (n: NsRow) => <Link to={namespacePath(n.r.supervisor.id, n.name)}>{n.name}</Link> },
                { label: 'Clusters', getter: (n: NsRow) => n.clusters.length },
                { label: 'VMs', getter: (n: NsRow) => (n.inv ? only(n.inv.vms, n.name).filter(v => !v.cluster).length : '…') },
                { label: 'Load balancers', getter: (n: NsRow) => (n.inv ? only(n.inv.lbs, n.name).length : '…') },
                { label: 'Subnets', getter: (n: NsRow) => (n.inv ? only(n.inv.subnets, n.name).length : '…') },
                {
                  label: 'Storage quota',
                  getter: (n: NsRow) => {
                    const q = only(n.inv?.quotas, n.name);
                    const used = q.reduce((a, x) => a + x.used, 0);
                    const limit = q.reduce((a, x) => a + x.limit, 0);
                    return limit ? <UsageBar used={used} total={limit} text={`${formatBytes(used)} of ${formatBytes(limit)}`} /> : '—';
                  },
                },
                { label: 'VPC', getter: (n: NsRow) => only(n.inv?.vpcs, n.name)[0]?.name ?? '—' },
              ]}
              data={list}
            />
          </SectionBox>
        ))}
    </>
  );
}

export function NamespaceDetail() {
  const params = useParams<{ supervisor: string; namespace: string }>();
  const { rows, loading } = useNamespaces();
  if (!rows) return <Loader title="Loading namespace" />;
  const row = rows.find(r => r.r.supervisor.id === params.supervisor && r.name === params.namespace);
  if (!row) {
    return (
      <SectionBox title={params.namespace}>
        <Typography>This namespace isn't visible with the current account or org selection.</Typography>
      </SectionBox>
    );
  }
  const inv = row.inv;
  const ns = row.name;
  const vms = only(inv?.vms, ns).filter(v => !v.cluster);
  const lbs = only(inv?.lbs, ns);
  const subnets = only(inv?.subnets, ns);
  const nsx = only(inv?.nsx, ns);
  const quotas = only(inv?.quotas, ns);
  const volumes = only(inv?.volumes, ns);
  const vpcs = only(inv?.vpcs, ns);
  return (
    <>
      <ChartStyles />
      <SectionBox title={`${row.tenantName}: ${ns}`}>
        {loading && <Loader title="Reading VMs, networks and storage" />}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2 }}>
          <KpiTile label="Clusters" value={row.clusters.length} tone="primary" />
          <KpiTile label="VMs" value={vms.length} sub={`${vms.filter(v => v.power === 'PoweredOn').length} on`} tone="info" />
          <KpiTile label="Load balancers" value={lbs.length} sub={`${lbs.filter(l => !l.vip).length} without IP`} tone={lbs.some(l => !l.vip) ? 'warning' : 'success'} />
          <KpiTile label="Subnets" value={subnets.length} tone="info" />
          <KpiTile label="Volumes" value={volumes.length} sub={formatBytes(volumes.reduce((a, v) => a + (v.size ?? 0), 0))} tone="info" />
        </Box>
        {(inv?.warnings.length ?? 0) > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Some parts couldn't be read: {inv!.warnings.slice(0, 4).join('; ')}
          </Alert>
        )}
      </SectionBox>

      {inv?.networking === 'vpc' && (
        <SectionBox title="Network map">
          <NetworkMap vpcs={vpcs} subnets={subnets} lbs={lbs} vms={vms} />
        </SectionBox>
      )}

      <SectionBox title="Clusters">
        {row.clusters.length ? (
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (c: FleetCluster) => <Link to={clusterPath(c)}>{c.name}</Link> },
              { label: 'Health', getter: (c: FleetCluster) => c.health },
              { label: 'Version', getter: (c: FleetCluster) => c.kubernetesVersion ?? '—' },
              { label: 'Nodes', getter: (c: FleetCluster) => c.machines.filter(m => !m.deletingSince).length },
            ]}
            data={row.clusters}
          />
        ) : (
          <Typography color="text.secondary">No VKS clusters in this namespace.</Typography>
        )}
      </SectionBox>

      <SectionBox title="VMs">{vms.length ? <VmTable vms={vms} showNamespace={false} /> : <Typography color="text.secondary">No VM Service VMs.</Typography>}</SectionBox>

      <Box id="lbs" sx={{ scrollMarginTop: 72 }} />
      <SectionBox title="Load balancers">
        {lbs.length ? <LbTable lbs={lbs} clusters={row.clusters} showNamespace={false} /> : <Typography color="text.secondary">None.</Typography>}
      </SectionBox>

      <Box id="network" sx={{ scrollMarginTop: 72 }} />
      <SectionBox title="Subnets">
        {inv?.networking === 'none' ? (
          <Typography color="text.secondary">This Supervisor doesn't use VPC networking, which is the only kind shown so far.</Typography>
        ) : subnets.length ? (
          <SubnetTable subnets={subnets} showNamespace={false} />
        ) : (
          <Typography color="text.secondary">None readable.</Typography>
        )}
      </SectionBox>
      {nsx.length > 0 && (
        <SectionBox title="Security policies, routes, NAT and IP allocations">
          <NsxTable objects={nsx} />
        </SectionBox>
      )}

      <Box id="storage" sx={{ scrollMarginTop: 72 }} />
      <SectionBox title="Storage">
        <QuotaBars quotas={quotas} />
        {volumes.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <VolumeTable volumes={volumes} />
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Access">
        <NamespaceAccess supervisor={row.r.supervisor} namespace={ns} clusters={row.clusters} />
      </SectionBox>
    </>
  );
}

export function VmsPage() {
  const { inventory, results } = useFleetData();
  const [onlyProblems, setOnlyProblems] = React.useState(false);
  if (!results || !inventory) return <Loader title="Loading VMs" />;
  const vms = Array.from(inventory.values()).flatMap(i => i.vms.filter(v => !v.cluster));
  const problem = (v: ServiceVm) => v.ready === false || (v.power && v.power !== 'PoweredOn');
  return (
    <SectionBox title="VMs">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
        <Typography>
          {vms.length} VM Service VM{vms.length === 1 ? '' : 's'} (cluster nodes are on the Machines page).
        </Typography>
        <FormControlLabel control={<Switch checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} />} label="Only VMs that are off or not ready" />
      </Box>
      {vms.length ? <VmTable vms={onlyProblems ? vms.filter(problem) : vms} /> : <Typography color="text.secondary">No VM Service VMs.</Typography>}
    </SectionBox>
  );
}

export function VmDetail() {
  const params = useParams<{ supervisor: string; namespace: string; name: string }>();
  const { inventory, results, canWrite, refresh } = useFleetData();
  const [plan, setPlan] = React.useState<ActionPlan | null>(null);
  const [snapName, setSnapName] = React.useState('');
  const [notice, setNotice] = React.useState<string | null>(null);
  if (!results || !inventory) return <Loader title="Loading VM" />;
  const inv = inventory.get(params.supervisor);
  const vm = inv?.vms.find(v => v.namespace === params.namespace && v.name === params.name);
  const r = results.find(x => x.supervisor.id === params.supervisor);
  if (!vm || !inv || !r) {
    return (
      <SectionBox title={params.name}>
        <Typography>This VM isn't visible with the current account or org selection.</Typography>
      </SectionBox>
    );
  }
  const writeOk = canWrite(r.supervisor.id) && !vm.cluster;
  const lbs = inv.lbs.filter(l => l.namespace === vm.namespace && l.vms.includes(vm.name));
  const volumes = inv.volumes.filter(v => v.namespace === vm.namespace && vm.volumes.includes(v.name));
  const subnets = inv.subnets.filter(s => s.namespace === vm.namespace && vm.interfaces.some(i => i.network === s.name));
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
  const actions = writeOk
    ? [
        vm.power === 'PoweredOn' ? (
          <Button key="off" size="small" variant="outlined" onClick={() => setPlan(vmPowerPlan(vm, 'PoweredOff'))}>
            Power off
          </Button>
        ) : (
          <Button key="on" size="small" variant="outlined" onClick={() => setPlan(vmPowerPlan(vm, 'PoweredOn'))}>
            Power on
          </Button>
        ),
        <Button key="restart" size="small" variant="outlined" disabled={vm.power !== 'PoweredOn'} onClick={() => setPlan(vmRestartPlan(vm))}>
          Restart
        </Button>,
      ]
    : [];
  return (
    <>
      <SectionBox title={`VM ${vm.name}`} headerProps={{ actions }}>
        {notice && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        {vm.cluster && (
          <Alert severity="info" sx={{ mb: 2 }}>
            This VM is a node of cluster {vm.cluster}; manage it from the cluster's machine page.
          </Alert>
        )}
        <SimpleTable
          columns={[
            { label: 'Field', getter: (x: [string, ReactNode]) => x[0] },
            { label: 'Value', getter: (x: [string, ReactNode]) => x[1] },
          ]}
          data={
            [
              ['State', <PowerLabel key="p" vm={vm} />],
              ['Namespace', <Link key="n" to={namespacePath(vm.supervisorId, vm.namespace)}>{vm.namespace}</Link>],
              ['Class', vm.className ?? '—'],
              ['Image', vm.image ?? '—'],
              ['IP', vm.ip ?? '—'],
              ['Zone', vm.zone ?? '—'],
              ['Storage class', vm.storageClass ?? '—'],
              ['Age', vm.createdAt ? formatDuration(Date.now() - new Date(vm.createdAt).getTime()) : '—'],
              ...(vm.readyMessage ? [['Problem', vm.readyMessage] as [string, ReactNode]] : []),
            ] as Array<[string, ReactNode]>
          }
        />
      </SectionBox>

      <SectionBox title="Network">
        <SimpleTable
          columns={[
            { label: 'Interface', getter: (i: ServiceVm['interfaces'][number]) => i.name },
            { label: 'Network', getter: (i: ServiceVm['interfaces'][number]) => `${i.kind ?? ''} ${i.network ?? ''}`.trim() || '—' },
            {
              label: 'Range',
              getter: (i: ServiceVm['interfaces'][number]) => subnets.find(s => s.name === i.network)?.cidrs.join(', ') ?? '—',
            },
          ]}
          data={vm.interfaces}
        />
        {lbs.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography sx={{ fontWeight: 600, mb: 1 }}>Exposed through</Typography>
            <LbTable lbs={lbs} clusters={[]} showNamespace={false} />
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Disks and snapshots">
        {volumes.length ? <VolumeTable volumes={volumes} /> : <Typography color="text.secondary">No volumes beyond the boot disk.</Typography>}
        <Typography sx={{ fontWeight: 600, mt: 2, mb: 1 }}>Snapshots</Typography>
        {vm.snapshots.length ? (
          <SimpleTable
            columns={[
              { label: 'Snapshot', getter: (s: ServiceVm['snapshots'][number]) => s.name },
              { label: 'Age', getter: (s: ServiceVm['snapshots'][number]) => (s.createdAt ? formatDuration(Date.now() - new Date(s.createdAt).getTime()) : '—') },
              { label: 'State', getter: (s: ServiceVm['snapshots'][number]) => <StatusLabel status={s.ready === false ? 'warning' : 'success'}>{s.ready === false ? 'Not ready' : 'Ready'}</StatusLabel> },
            ]}
            data={vm.snapshots}
          />
        ) : (
          <Typography color="text.secondary">None.</Typography>
        )}
        {writeOk && (
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 1.5 }}>
            <TextField size="small" label="Snapshot name" value={snapName || `${vm.name}-${stamp}`} onChange={e => setSnapName(e.target.value)} />
            <Button size="small" variant="outlined" onClick={() => setPlan(vmSnapshotPlan(vm, snapName || `${vm.name}-${stamp}`))}>
              Take snapshot
            </Button>
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Conditions">
        <SimpleTable
          columns={[
            { label: 'Condition', getter: (c: ServiceVm['conditions'][number]) => c.type },
            { label: 'Status', getter: (c: ServiceVm['conditions'][number]) => <StatusLabel status={c.status === 'True' ? 'success' : 'warning'}>{c.status}</StatusLabel> },
            { label: 'Reason', getter: (c: ServiceVm['conditions'][number]) => c.reason ?? '—' },
            { label: 'Message', getter: (c: ServiceVm['conditions'][number]) => c.message ?? '—' },
          ]}
          data={vm.conditions}
        />
      </SectionBox>

      {plan && (
        <ActionDialog
          plan={plan}
          writer={supervisorWriter(r.supervisor)}
          onClose={() => setPlan(null)}
          onApplied={m => {
            setNotice(m);
            refresh();
          }}
        />
      )}
    </>
  );
}

export function NetworkPage() {
  const { inventory, results } = useFleetData();
  if (!results || !inventory) return <Loader title="Loading networks" />;
  const invs = Array.from(inventory.values());
  const clusters = results.flatMap(r => r.clusters);
  const lbs = invs.flatMap(i => i.lbs);
  const subnets = invs.flatMap(i => i.subnets);
  const nsx = invs.flatMap(i => i.nsx);
  const vpcs = invs.flatMap(i => i.vpcs);
  return (
    <>
      <SectionBox title="Load balancers">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Every VIP on the Supervisor and what it serves: a cluster's API, a Service inside a cluster, or VMs.
        </Typography>
        {lbs.length ? <LbTable lbs={lbs} clusters={clusters} /> : <Typography color="text.secondary">None.</Typography>}
      </SectionBox>
      <SectionBox title="Subnets">
        {invs.every(i => i.networking === 'none') ? (
          <Typography color="text.secondary">This Supervisor doesn't use VPC networking, which is the only kind shown so far.</Typography>
        ) : (
          <SubnetTable subnets={subnets} />
        )}
      </SectionBox>
      {vpcs.length > 0 && (
        <SectionBox title="VPCs">
          <SimpleTable
            columns={[
              { label: 'Namespace', getter: (v: (typeof vpcs)[number]) => v.namespace },
              { label: 'VPC', getter: (v: (typeof vpcs)[number]) => v.name },
              { label: 'Private ranges', getter: (v: (typeof vpcs)[number]) => v.privateIPs.join(', ') || '—' },
              { label: 'Outbound NAT', getter: (v: (typeof vpcs)[number]) => v.snatIP ?? '—' },
              { label: 'Stack', getter: (v: (typeof vpcs)[number]) => v.stack ?? '—' },
            ]}
            data={vpcs}
          />
        </SectionBox>
      )}
      {nsx.length > 0 && (
        <SectionBox title="Security policies, routes, NAT, IP allocations and NSX errors">
          <NsxTable objects={nsx} />
        </SectionBox>
      )}
    </>
  );
}
