import { Loader, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { clusterPath } from '../routes';
import { usePluginConfig } from '../settings/store';
import { fleetTotals, needsAttention, rollupByTenant, TenantRollup, versionSpread } from '../summary';
import { FleetCluster, supervisorLabel } from '../types';
import { useFleet } from '../useFleet';
import { HealthLabel, replicas, SupervisorBanners } from './common';

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
  return parts.length ? `${first} ${parts.join(' and ')}.` : `${first} All healthy.`;
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

  const visible = allClusters.filter(c => {
    if (tenant !== ALL && c.tenant !== tenant) return false;
    if (attentionOnly && !needsAttention(c) && !c.upgrading) return false;
    const q = search.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.namespace.toLowerCase().includes(q);
  });

  const byTenant = new Map<string, FleetCluster[]>();
  for (const c of visible) {
    byTenant.set(c.tenant, [...(byTenant.get(c.tenant) ?? []), c]);
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
    { label: 'Status', getter: (c: FleetCluster) => <HealthLabel cluster={c} /> },
    { label: 'Kubernetes', getter: (c: FleetCluster) => c.kubernetesVersion ?? '—' },
    { label: 'Control plane ready', getter: (c: FleetCluster) => replicas(c.controlPlane) },
    { label: 'Workers ready', getter: (c: FleetCluster) => replicas(c.workers) },
    { label: 'Class', getter: (c: FleetCluster) => c.clusterClass ?? '—' },
  ];

  const multiTenant = rollups.length > 1;

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
                <MenuItem key={r.tenant} value={r.tenant}>
                  {r.tenant}
                </MenuItem>
              ))}
            </TextField>
          )}
          <FormControlLabel
            control={<Switch checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} />}
            label="Only clusters that need attention or are upgrading"
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
                  <Button size="small" onClick={() => setTenant(r.tenant)}>
                    {r.tenant}
                  </Button>
                ),
              },
              { label: 'Clusters', getter: (r: TenantRollup) => r.clusters },
              { label: 'Need attention', getter: (r: TenantRollup) => r.attention },
              { label: 'Upgrading', getter: (r: TenantRollup) => r.upgrading },
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
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, cs]) => (
          <SectionBox key={t} title={multiTenant ? t : `Clusters in ${t}`}>
            {cs.some(c => !c.tenantMapped) && (
              <Typography variant="body2" sx={{ mb: 1 }}>
                This group has no tenant label, so it's shown under its namespace name.
              </Typography>
            )}
            <SimpleTable columns={columns} data={cs.sort((a, b) => a.name.localeCompare(b.name))} />
          </SectionBox>
        ))}
    </>
  );
}
