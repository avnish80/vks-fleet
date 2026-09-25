import { Loader, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { clusterPath, headlampClusterPath } from '../routes';
import { usePluginConfig } from '../settings/store';
import { fleetTotals, needsAttention, rollupByTenant, TenantRollup, versionSpread } from '../summary';
import { FleetCluster, supervisorLabel } from '../types';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';
import { HealthLabel, IssuesText, nodesText, SupervisorBanners, VersionCell, WorkloadCell } from './common';

const ALL = '__all__';

type VersionCount = { version: string; count: number };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function summarySentence(clusters: FleetCluster[]): string {
  const t = fleetTotals(clusters);
  const first = `${plural(t.clusters, 'cluster', 'clusters')} across ${plural(t.tenants, 'tenant', 'tenants')}.`;
  const parts: string[] = [];
  if (t.attention) parts.push(`${t.attention} ${t.attention === 1 ? 'needs' : 'need'} attention`);
  if (t.upgrading) parts.push(`${t.upgrading} ${t.upgrading === 1 ? 'is' : 'are'} upgrading`);
  if (t.upgradable) parts.push(`${t.upgradable} can be upgraded`);
  if (!parts.length) return `${first} All healthy.`;
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${first} ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function FleetView() {
  const config = usePluginConfig();
  const { results, refreshing, refresh } = useFleet(config.supervisors, config.refreshSeconds);

  const [search, setSearch] = React.useState('');
  const [tenant, setTenant] = React.useState(ALL);
  const [attentionOnly, setAttentionOnly] = React.useState(false);

  const multiSupervisor = config.supervisors.length > 1;
  const supervisorNames = new Map(config.supervisors.map(s => [s.id, supervisorLabel(s)]));

  const allClusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const rollups = React.useMemo(() => rollupByTenant(allClusters), [allClusters]);
  const versions = React.useMemo(() => versionSpread(allClusters), [allClusters]);
  const workload = useWorkloadHealth(allClusters, config.refreshSeconds);

  const visible = allClusters.filter(c => {
    if (tenant !== ALL && c.tenantId !== tenant) return false;
    const wl = workload.byKey.get(c.key);
    const insideProblems = wl?.status === 'issues' || wl?.status === 'unreachable';
    if (attentionOnly && !needsAttention(c) && !c.upgrading && !insideProblems) return false;
    const q = search.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.namespace.toLowerCase().includes(q);
  });

  const byTenant = new Map<string, FleetCluster[]>();
  for (const c of visible) {
    byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
  }

  const actions = [
    <Button key="refresh" variant="contained" size="small" onClick={refresh} disabled={refreshing}>
      {refreshing ? 'Refreshing' : 'Refresh'}
    </Button>,
  ];

  if (config.supervisors.length === 0) {
    return (
      <SectionBox title="VKS fleet">
        <Typography>
          Connect a Supervisor to see its VKS clusters. Open Settings, then Plugins, then vks-fleet,
          and enter the Headlamp cluster name that points at your Supervisor.
        </Typography>
      </SectionBox>
    );
  }

  if (results === null) {
    return <Loader title="Loading VKS clusters" />;
  }

  const columns = [
    {
      label: 'Name',
      getter: (c: FleetCluster) => <Link to={clusterPath(c)}>{c.name}</Link>,
    },
    { label: 'Namespace', getter: (c: FleetCluster) => c.namespace },
    ...(multiSupervisor
      ? [{ label: 'Supervisor', getter: (c: FleetCluster) => supervisorNames.get(c.supervisorId) ?? c.supervisorId }]
      : []),
    {
      label: 'Status',
      getter: (c: FleetCluster) => (
        <Box>
          <HealthLabel cluster={c} />
          <IssuesText cluster={c} />
        </Box>
      ),
    },
    { label: 'Kubernetes', getter: (c: FleetCluster) => <VersionCell cluster={c} /> },
    { label: 'Nodes', getter: (c: FleetCluster) => nodesText(c) },
    { label: 'Inside the cluster', getter: (c: FleetCluster) => <WorkloadCell health={workload.byKey.get(c.key)} /> },
    {
      label: 'Open',
      getter: (c: FleetCluster) => {
        const ctx = workload.byKey.get(c.key)?.contextName;
        return ctx ? <Link to={headlampClusterPath(ctx)}>Open in Headlamp</Link> : '—';
      },
    },
  ];

  const multiTenant = rollups.length > 1;
  const tenantById = new Map(rollups.map(r => [r.tenantId, r]));

  return (
    <>
      <SectionBox title="VKS fleet" headerProps={{ actions }}>
        <SupervisorBanners results={results} />
        <Typography sx={{ mb: 2 }}>{summarySentence(allClusters)}</Typography>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
          <TextField
            size="small"
            label="Search clusters or namespaces"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {multiTenant && (
            <TextField
              select
              size="small"
              label="Tenant"
              value={tenant}
              onChange={e => setTenant(e.target.value)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value={ALL}>All tenants</MenuItem>
              {rollups.map(r => (
                <MenuItem key={r.tenantId} value={r.tenantId}>
                  {r.tenantName}
                </MenuItem>
              ))}
            </TextField>
          )}
          <FormControlLabel
            control={<Switch checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} />}
            label="Only clusters with problems or upgrades in progress"
          />
        </Box>
      </SectionBox>

      {multiTenant && tenant === ALL && (
        <SectionBox title="Tenants">
          <SimpleTable
            columns={[
              {
                label: 'Tenant',
                getter: (r: TenantRollup) => (
                  <Button size="small" onClick={() => setTenant(r.tenantId)} title={r.tenantId}>
                    {r.tenantName}
                  </Button>
                ),
              },
              { label: 'Clusters', getter: (r: TenantRollup) => r.clusters },
              { label: 'Need attention', getter: (r: TenantRollup) => r.attention },
              { label: 'Upgrading', getter: (r: TenantRollup) => r.upgrading },
              { label: 'Upgrades available', getter: (r: TenantRollup) => r.upgradable },
              { label: 'Kubernetes versions', getter: (r: TenantRollup) => r.versions.join(', ') },
              ...(multiSupervisor
                ? [
                    {
                      label: 'Supervisors',
                      getter: (r: TenantRollup) =>
                        r.supervisorIds.map(id => supervisorNames.get(id) ?? id).join(', '),
                    },
                  ]
                : []),
            ]}
            data={rollups}
          />
        </SectionBox>
      )}

      {versions.length > 1 && tenant === ALL && (
        <SectionBox title="Kubernetes versions in use">
          <SimpleTable
            columns={[
              { label: 'Version', getter: (v: VersionCount) => v.version },
              { label: 'Clusters', getter: (v: VersionCount) => v.count },
            ]}
            data={versions}
          />
        </SectionBox>
      )}

      {allClusters.length === 0 && !results.some(r => r.error) && (
        <SectionBox title="Clusters">
          <Typography>
            No VKS clusters found. Create a cluster in one of your Supervisor namespaces, or check the
            namespaces listed in the plugin settings.
          </Typography>
        </SectionBox>
      )}

      {allClusters.length > 0 && visible.length === 0 && (
        <SectionBox title="Clusters">
          <Typography>No clusters match these filters.</Typography>
        </SectionBox>
      )}

      {Array.from(byTenant.entries())
        .sort(([a], [b]) => (tenantById.get(a)?.tenantName ?? a).localeCompare(tenantById.get(b)?.tenantName ?? b))
        .map(([tid, cs]) => {
          const info = tenantById.get(tid);
          const name = info?.tenantName ?? tid;
          return (
            <SectionBox key={tid} title={multiTenant ? name : `Clusters in ${name}`}>
              {info && !info.tenantNamed && (
                <Typography variant="body2" sx={{ mb: 1 }}>
                  This tenant has no name yet. To name it, add a line for ID {tid} under Settings, then
                  Plugins, then vks-fleet, in Tenant names.
                </Typography>
              )}
              {info?.unmapped && (
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Some namespaces here have no tenant label, so they're shown under their namespace name.
                </Typography>
              )}
              <SimpleTable columns={columns} data={cs.sort((a, b) => a.name.localeCompare(b.name))} />
            </SectionBox>
          );
        })}
    </>
  );
}
