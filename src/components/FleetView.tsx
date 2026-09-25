import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { scorecard } from '../checks';
import { buildIssues, countIssues } from '../issues';
import { packageDrift } from '../packages';
import { clusterPath, headlampClusterPath, headlampPodsPath, PACKAGES_PATH, SEARCH_ROUTE } from '../routes';
import { usePackages } from '../usePackages';
import { usePluginConfig } from '../settings/store';
import { fleetTotals, needsAttention, rollupByTenant, TenantRollup } from '../summary';
import { FleetCluster, ServiceHealth, SupervisorConfig, supervisorLabel } from '../types';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';
import {
  capacityText,
  FindingsTable,
  HealthLabel,
  IssuesText,
  nodesText,
  SupervisorBanners,
  VersionCell,
  WorkloadCell,
} from './common';
import { IssuesList } from './IssuesList';
import { Overview } from './Overview';

const ALL = '__all__';

type ServiceRow = ServiceHealth & { supervisor: SupervisorConfig };

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
  const capacity = t.cpus ? ` Nodes use ${capacityText(t)} of memory.`.replace(' vCPU, ', ' vCPU and ') : '';
  if (!parts.length) return `${first} All healthy.${capacity}`;
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${first} ${text.charAt(0).toUpperCase()}${text.slice(1)}.${capacity}`;
}

export function FleetView() {
  const config = usePluginConfig();
  const { results, refreshing, refresh } = useFleet(config.supervisors, config.refreshSeconds);

  const [search, setSearch] = React.useState('');
  const [tenant, setTenant] = React.useState(ALL);
  const [supervisorFilter, setSupervisorFilter] = React.useState(ALL);
  const [attentionOnly, setAttentionOnly] = React.useState(false);
  const [showInfo, setShowInfo] = React.useState(false);
  const [findingsToggled, setFindingsOpen] = React.useState<boolean | null>(null);

  const multiSupervisor = config.supervisors.length > 1;
  const supervisorNames = new Map(config.supervisors.map(s => [s.id, supervisorLabel(s)]));

  const allClusters = React.useMemo(
    () =>
      (results ?? [])
        .filter(r => supervisorFilter === ALL || r.supervisor.id === supervisorFilter)
        .flatMap(r => r.clusters),
    [results, supervisorFilter]
  );
  const rollups = React.useMemo(() => rollupByTenant(allClusters), [allClusters]);
  const workload = useWorkloadHealth(allClusters, config.refreshSeconds);
  const scopedResults = React.useMemo(
    () => (results ?? []).filter(r => supervisorFilter === ALL || r.supervisor.id === supervisorFilter),
    [results, supervisorFilter]
  );
  const packageTargets = allClusters
    .map(c => ({ key: c.key, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; contextName: string } => !!t.contextName);
  const packages = usePackages(packageTargets);
  const issues = React.useMemo(
    () => buildIssues(scopedResults, workload.byKey, new Date(), packages ?? undefined),
    [scopedResults, workload.byKey, packages]
  );
  const tenantClusters = tenant === ALL ? allClusters : allClusters.filter(c => c.tenantId === tenant);
  const tenantKeys = new Set(tenantClusters.map(c => c.key));
  const tenantNamespaces = new Set(tenantClusters.map(c => `${c.supervisorId}/${c.namespace}`));
  const tenantIssues =
    tenant === ALL
      ? issues
      : issues.filter(i =>
          i.clusterKey
            ? tenantKeys.has(i.clusterKey)
            : i.namespace && !i.namespace.startsWith('svc-')
            ? tenantNamespaces.has(`${i.supervisorId}/${i.namespace}`)
            : false
        );
  const findingCounts = countIssues(tenantIssues);
  // Collapsed by default; open by default only when something is critical.
  const findingsOpen = findingsToggled ?? findingCounts.critical > 0;
  const fleetZones = new Set(allClusters.flatMap(c => c.machines.map(m => m.failureDomain)).filter(Boolean)).size;
  const scores = tenantClusters.map(c => ({
    cluster: c,
    card: scorecard(c, workload.byKey.get(c.key), fleetZones, new Date(), packages?.get(c.key)),
  }));
  const tenantPackages = packages ? tenantClusters.map(c => packages.get(c.key)).filter((p): p is NonNullable<typeof p> => !!p) : [];
  const packageStats = tenantPackages.length
    ? {
        failing: tenantPackages.reduce((n, cp) => n + cp.items.filter(p => p.state === 'failed').length, 0),
        updates: tenantPackages.reduce((n, cp) => n + cp.items.filter(p => p.update).length, 0),
        drift: packageDrift(tenantPackages).filter(d => d.distinct > 1),
      }
    : undefined;
  const clusterByKey = new Map(allClusters.map(c => [c.key, c]));
  const services: ServiceRow[] = (results ?? []).flatMap(r =>
    (r.services ?? []).map(s => ({ ...s, supervisor: r.supervisor }))
  );

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
    <Button key="search" size="small" variant="outlined" component={Link} to={SEARCH_ROUTE}>
      Search the fleet
    </Button>,
    <Button key="packages" size="small" variant="outlined" component={Link} to={PACKAGES_PATH}>
      Packages
    </Button>,
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
        <Typography sx={{ mb: 2 }}>
          {summarySentence(allClusters)}
          {findingCounts.critical + findingCounts.warning > 0
            ? ` Issues below: ${findingCounts.critical} critical, ${findingCounts.warning} ${
                findingCounts.warning === 1 ? 'warning' : 'warnings'
              }.`
            : ''}
        </Typography>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
          <TextField
            size="small"
            label="Search clusters or namespaces"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {multiSupervisor && (
            <TextField
              select
              size="small"
              label="Supervisor"
              value={supervisorFilter}
              onChange={e => {
                setSupervisorFilter(e.target.value);
                setTenant(ALL);
              }}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value={ALL}>All Supervisors</MenuItem>
              {config.supervisors.map(s => (
                <MenuItem key={s.id} value={s.id}>
                  {supervisorLabel(s)}
                </MenuItem>
              ))}
            </TextField>
          )}
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

      {allClusters.length > 0 && (
        <Overview
          clusters={tenantClusters}
          findings={tenantIssues}
          scores={scores}
          packageStats={packageStats}
          title={tenant === ALL ? 'Overview' : `Overview: ${tenantById.get(tenant)?.tenantName ?? tenant}`}
          onTenant={multiTenant ? setTenant : undefined}
          supervisors={
            multiSupervisor && supervisorFilter === ALL
              ? results.map(r => ({
                  id: r.supervisor.id,
                  name: supervisorLabel(r.supervisor),
                  error: r.error,
                  clusters: r.clusters,
                }))
              : undefined
          }
          onSupervisor={multiSupervisor ? setSupervisorFilter : undefined}
        />
      )}

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
              { label: 'Node capacity', getter: (r: TenantRollup) => capacityText(r) },
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

      <IssuesSection
        issues={tenantIssues}
        clusters={clusterByKey}
        supervisorNames={supervisorNames}
        showInfo={showInfo}
        setShowInfo={setShowInfo}
        open={findingsOpen}
        setOpen={setFindingsOpen}
      />

      {services.length > 0 && tenant === ALL && (
        <SectionBox title="Supervisor services">
          <SimpleTable
            columns={[
              { label: 'Service', getter: (s: ServiceRow) => s.name },
              ...(multiSupervisor ? [{ label: 'Supervisor', getter: (s: ServiceRow) => supervisorLabel(s.supervisor) }] : []),
              { label: 'Namespace', getter: (s: ServiceRow) => s.namespace },
              {
                label: 'Pods',
                getter: (s: ServiceRow) =>
                  <Box>
                    {s.problems.length ? (
                      <StatusLabel status="warning">{`${s.problems.length} with problems`}</StatusLabel>
                    ) : (
                      <StatusLabel status="success">OK</StatusLabel>
                    )}
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {`${s.pods - s.leftovers} running`}
                      {s.leftovers ? `, ${s.leftovers} old failed ${s.leftovers === 1 ? 'pod' : 'pods'} to clean up` : ''}
                    </Typography>
                  </Box>,
              },
              {
                label: 'Logs',
                getter: (s: ServiceRow) => (
                  <Link to={headlampPodsPath(s.supervisor.headlampCluster, s.namespace)}>Open pods</Link>
                ),
              },
            ]}
            data={services}
          />
        </SectionBox>
      )}
    </>
  );
}

function IssuesSection({
  issues,
  clusters,
  supervisorNames,
  showInfo,
  setShowInfo,
  open,
  setOpen,
}: {
  issues: ReturnType<typeof buildIssues>;
  clusters: Map<string, FleetCluster>;
  supervisorNames: Map<string, string>;
  showInfo: boolean;
  setShowInfo: (v: boolean) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  const counts = countIssues(issues);
  const shown = showInfo ? issues : issues.filter(x => x.severity !== 'info');
  const summary =
    counts.critical + counts.warning === 0
      ? 'Nothing needs action.'
      : `${counts.critical} critical, ${counts.warning} ${counts.warning === 1 ? 'warning' : 'warnings'}.`;
  const toggle = [
    <Button key="toggle" size="small" variant="outlined" onClick={() => setOpen(!open)}>
      {open ? 'Hide issues' : 'Show issues'}
    </Button>,
  ];
  return (
    <SectionBox title="Issues" headerProps={{ actions: toggle }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', mb: open ? 1.5 : 0 }}>
        <Typography>
          {summary} {counts.info ? `${counts.info} for information.` : ''}
        </Typography>
        {open && counts.info > 0 && (
          <FormControlLabel
            control={<Switch checked={showInfo} onChange={e => setShowInfo(e.target.checked)} />}
            label="Show information issues"
          />
        )}
      </Box>
      {open && shown.length > 0 && <IssuesList issues={shown} clusters={clusters} supervisorNames={supervisorNames} />}
    </SectionBox>
  );
}
