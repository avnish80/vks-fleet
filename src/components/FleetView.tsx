import { Loader, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';
import { scorecard } from '../checks';
import { buildIssues, countIssues } from '../issues';
import { activeSilences, partitionIssues } from '../silences';
import { Silence } from '../types';
import { SinceLastVisit } from './Awareness';
import { complianceIssues } from '../complianceReport';
import { isolationIssues, isolationReport } from '../isolation';
import { scannerIssues } from '../scannerIssues';
import { observabilityIssues } from '../observability';
import { compareVersions } from '../packages';
import { useObservability } from '../useObservability';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { supervisorHealthIssues } from '../supervisorHealth';
import { useVcenterStatus } from '../useVcenterStatus';
import { diskForecast, entitiesFor, matchSupervisor, STALE_MINUTES, utilisationIssues, vcenterIssues } from '../vcenterStatus';
import { glance, horizon, needsYouNow } from '../fleetHero';
import { FleetHero } from './FleetHero';
import { FleetDetails } from './FleetDetails';
import { shortener } from '../names';
import { useScannerReports } from '../useScannerReports';
import { useComplianceStore } from './complianceStore';
import { OrgCards, OrgSummary } from './OrgCards';
import { Guard } from './Guard';
import { ALL_ORGS } from '../scope';
import { isOwnSilence, removeSilence } from './SilenceDialog';
import { packageDrift } from '../packages';
import { clusterPath, FLEET_PATH, headlampClusterPath, SEARCH_ROUTE } from '../routes';
import { download, fleetReportCsv, fleetReportMarkdown } from '../report';
import { usePackages } from '../usePackages';
import { useBackups } from '../useBackups';
import { useClusterScans } from '../useClusterScans';
import { configuredByNamespace } from '../limits';
import { limitIssues } from '../limitIssues';
import { compliance, evaluateBaseline, profileFor } from '../baseline';
import { fleetTotals, needsAttention, rollupByTenant, TenantRollup } from '../summary';
import { FleetCluster, Health, supervisorLabel } from '../types';
import { useWorkloadHealth } from '../useWorkload';
import {
  capacityText,
  HealthLabel,
  IssuesText,
  nodesText,
  SupervisorBanners,
  VersionCell,
  WorkloadCell,
} from './common';
import { IssuesList } from './IssuesList';

const ALL = '__all__';


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
  const { config, results, refreshing, refresh, inventory, limits, orgQuotas, setOrg, all, inventoryAll, org } = useFleetData();

  const [search, setSearch] = React.useState('');
  // Filters live in the URL, so overview clicks and shared links land on the same view.
  const location = useLocation();
  const history = useHistory();
  const params = new URLSearchParams(location.search);
  // Orgs are chosen once, for every page (the cards below, or the bar at the top).
  const tenant = ALL;
  const supervisorFilter = params.get('supervisor') ?? ALL;
  const healthFilter = (params.get('health') ?? undefined) as Health | undefined;
  const versionFilter = params.get('version') ?? undefined;
  const attentionOnly = params.get('attention') === '1';
  const upgradableOnly = params.get('upgradable') === '1';
  const setParams = (patch: Record<string, string | undefined>, hash?: string) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    history.replace(`${FLEET_PATH}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`);
  };
  const setTenant = (t: string) => setOrg(t === ALL ? ALL_ORGS : t);
  const setSupervisorFilter = (id: string) => setParams({ supervisor: id === ALL ? undefined : id, tenant: undefined });
  const setAttentionOnly = (b: boolean) => setParams({ attention: b ? '1' : undefined });
  const jump = (id: string) =>
    window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  const [exportOpen, setExportOpen] = React.useState(false);
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
  const backups = useBackups(packageTargets);
  const complianceBaselines = useComplianceStore()?.baselines ?? {};
  const observability = useObservability(
    allClusters
      .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
      .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName)
  );
  const { persona: whoAmI } = useFleetData();
  const supervisorHealth = useSupervisorHealth(all, inventoryAll, !!whoAmI && ['operator', 'readonly', 'unknown'].includes(whoAmI.persona));
  const vcenter = useVcenterStatus(config);
  const scannerReports = useScannerReports(
    allClusters
      .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
      .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName)
  );
  const scans = useClusterScans(
    allClusters
      .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
      .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName),
    config.baseline?.allowedRegistries ?? []
  );
  const issues = React.useMemo(
    () =>
      buildIssues(
        scopedResults,
        workload.byKey,
        new Date(),
        packages ?? undefined,
        backups ?? undefined,
        config.baseline?.backupWithinHours,
        inventory ?? undefined,
        scans ?? undefined,
        [
          ...limitIssues(scopedResults, limits, configuredByNamespace(scopedResults, inventory), orgQuotas),
          ...complianceIssues(scans ?? [], scopedResults.flatMap(r => r.clusters), activeSilences(config.silences), complianceBaselines),
          ...scannerIssues(scannerReports ?? [], scopedResults.flatMap(r => r.clusters)),
          ...(vcenter?.status
            ? (all ?? []).flatMap(r => {
                const v = matchSupervisor(
                  vcenter.status!,
                  r.supervisor,
                  (all ?? []).length,
                  (supervisorHealth ?? []).find(x => x.supervisorId === r.supervisor.id)?.nodes.filter(n => n.role === 'host').map(n => n.name)
                );
                return v
                  ? [
                      ...vcenterIssues(v, r.supervisor.id, r.supervisor.displayName ?? r.supervisor.id),
                      ...utilisationIssues(entitiesFor(vcenter.status!.metrics, v.id), vcenter.status!.metrics, r.supervisor.id, r.supervisor.displayName ?? r.supervisor.id),
                    ]
                  : [];
              })
            : []),
          ...(vcenter && (vcenter.error || (vcenter.ageMinutes ?? 0) > STALE_MINUTES) && (all ?? [])[0]
            ? [
                {
                  id: 'vcenter-collector',
                  severity: 'info' as const,
                  supervisorId: all![0].supervisor.id,
                  title: vcenter.error ? "The vCenter collector's data can't be read" : `The vCenter collector last wrote ${vcenter.ageMinutes} minutes ago`,
                  cause: vcenter.error ?? 'It normally writes every 5 minutes.',
                  evidence: [],
                  affected: { clusters: [], tenants: [], nodes: [], pods: [] },
                  fix: 'Check the collector CronJob (kubectl -n vks-fleet get cronjob,jobs,pods -l app.kubernetes.io/name=vks-fleet-collector) or its timer on the jump server.',
                  primary: { label: 'Supervisor health', path: '/vks-fleet/supervisor-health' },
                  links: [],
                  findingIds: [],
                  detectedAt: new Date().toISOString(),
                },
              ]
            : []),
          ...(supervisorHealth ?? []).flatMap(h => supervisorHealthIssues(h, all?.find(r => r.supervisor.id === h.supervisorId)?.supervisor.headlampCluster ?? '')),
          ...observabilityIssues(observability ?? [], scopedResults.flatMap(r => r.clusters), new Date(), key => {
            const r = scopedResults.find(x => x.clusters.some(c => c.key === key));
            return [...(r?.releases ?? [])].sort((a, b) => compareVersions(b, a))[0];
          }),
          ...(all && inventoryAll
            ? isolationIssues(
                isolationReport(all, inventoryAll, null).filter(r => org === '__all__' || r.orgId === org),
                all[0]?.supervisor.id ?? ''
              )
            : []),
        ]
      ),
    [scopedResults, workload.byKey, packages, backups, config.baseline?.backupWithinHours, inventory, scans, limits, orgQuotas, config.silences, complianceBaselines, all, inventoryAll, org, scannerReports, observability, supervisorHealth, vcenter]
  );
  const tenantClusters = tenant === ALL ? allClusters : allClusters.filter(c => c.tenantId === tenant);
  const tenantKeys = new Set(tenantClusters.map(c => c.key));
  const tenantNamespaces = new Set(tenantClusters.map(c => `${c.supervisorId}/${c.namespace}`));
  const tenantIssuesAll =
    tenant === ALL
      ? issues
      : issues.filter(i =>
          i.clusterKey
            ? tenantKeys.has(i.clusterKey)
            : i.namespace && !i.namespace.startsWith('svc-')
            ? tenantNamespaces.has(`${i.supervisorId}/${i.namespace}`)
            : false
        );
  const silences = activeSilences(config.silences);
  const { active: tenantIssues, silenced } = partitionIssues(tenantIssuesAll, silences);
  const findingCounts = countIssues(tenantIssues);
  // Collapsed by default; open by default only when something is critical.
  const findingsOpen = findingsToggled ?? findingCounts.critical + findingCounts.warning > 0;
  const fleetZones = new Set(allClusters.flatMap(c => c.machines.map(m => m.failureDomain)).filter(Boolean)).size;
  const scores = tenantClusters.map(c => ({
    cluster: c,
    card: scorecard(c, workload.byKey.get(c.key), fleetZones, new Date(), packages?.get(c.key), backups?.get(c.key)),
  }));
  const baselineRows = config.baseline
    ? tenantClusters.map(c => ({
        cluster: c,
        pct: compliance(
          evaluateBaseline(c, profileFor(c, config.baselineProfiles, config.baseline!).baseline, fleetZones, backups?.get(c.key), new Date(), {
            packages: packages?.get(c.key)?.items,
            psaDefault: (scans ?? []).find(s => s.clusterKey === c.key)?.psaDefault,
          })
        ).pct,
      }))
    : [];
  const tenantPackages = packages ? tenantClusters.map(c => packages.get(c.key)).filter((p): p is NonNullable<typeof p> => !!p) : [];
  const packageStats = tenantPackages.length
    ? {
        failing: tenantPackages.reduce((n, cp) => n + cp.items.filter(p => p.state === 'failed').length, 0),
        updates: tenantPackages.reduce((n, cp) => n + cp.items.filter(p => p.update).length, 0),
        drift: packageDrift(tenantPackages).filter(d => d.distinct > 1),
      }
    : undefined;
  const clusterByKey = new Map(allClusters.map(c => [c.key, c]));

  const visible = allClusters.filter(c => {
    if (tenant !== ALL && c.tenantId !== tenant) return false;
    const wl = workload.byKey.get(c.key);
    const insideProblems = wl?.status === 'issues' || wl?.status === 'unreachable';
    if (attentionOnly && !needsAttention(c) && !c.upgrading && !insideProblems) return false;
    if (healthFilter && c.health !== healthFilter) return false;
    if (versionFilter && c.kubernetesVersion !== versionFilter) return false;
    if (upgradableOnly && (!c.availableUpgrade || c.upgrading)) return false;
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
    <Button key="export" size="small" variant="outlined" onClick={() => setExportOpen(true)}>
      Export report
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

  const shortCluster = shortener(tenantClusters.map(c => c.name));
  const coming = horizon({
              now: new Date(),
              clusters: tenantClusters,
              forecasts: (observability ?? []).filter(o => tenantClusters.some(c => c.key === o.clusterKey)).map(o => ({ clusterName: o.clusterName, clusterKey: o.clusterKey, forecasts: o.forecasts })),
              supervisorDisks: vcenter?.status
                ? (all ?? []).flatMap(r => {
                    const v = matchSupervisor(vcenter.status!, r.supervisor, (all ?? []).length, (supervisorHealth ?? []).find(x => x.supervisorId === r.supervisor.id)?.nodes.filter(n => n.role === 'host').map(n => n.name));
                    return v
                      ? entitiesFor(vcenter.status!.metrics, v.id)
                          .filter(e => e.kind === 'vm')
                          .map(e => ({ supervisor: r.supervisor.displayName ?? r.supervisor.id, vm: e.name, seconds: diskForecast(vcenter.status!.metrics, e.name) ?? Infinity }))
                          .filter(d => Number.isFinite(d.seconds))
                      : [];
                  })
                : [],
              silences,
              short: shortCluster,
              certificates: (scans ?? []).flatMap(sc =>
                sc.security.filter(f => f.kind === 'cert' && f.expires).map(f => ({ clusterName: sc.clusterName, clusterKey: sc.clusterKey, name: f.objects[0], expires: f.expires! }))
              ),
            });

  return (
    <>
      <SectionBox title="VKS fleet" headerProps={{ actions }}>
        <SupervisorBanners results={results} />
        <Typography sx={{ mb: 2 }}>
          {summarySentence(allClusters)}
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
              onChange={e => setSupervisorFilter(e.target.value)}
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
          <FormControlLabel
            control={<Switch checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} />}
            label="Only clusters with problems or upgrades in progress"
          />
        </Box>
      </SectionBox>

      {allClusters.length > 0 && (
        <Guard name="Fleet at a glance">
          <FleetHero
            glance={glance(tenantClusters, scores.map(x => x.card.score), tenantIssues, (supervisorHealth ?? []).map(h => h.score))}
            top={needsYouNow(tenantIssues, coming)}
            horizon={coming}
            onScore={() => jump('scorecard')}
          />
        </Guard>
      )}

      <Guard name="Org cards">
        <OrgCards />
        <OrgSummary />
      </Guard>
      {allClusters.length > 0 && (
        <Box sx={{ px: 2 }}>
          <SinceLastVisit
          issues={tenantIssues}
            ready={results !== null && inventory !== null && (packageTargets.length === 0 || (packages !== null && scans !== null))}
          />
        </Box>
      )}
      {allClusters.length > 0 && (
        <Guard name="Overview">
        <FleetDetails
          rows={tenantClusters.map(c => ({
            cluster: c,
            score: scores.find(x => x.cluster.key === c.key)?.card.score,
            baseline: baselineRows.find(x => x.cluster.key === c.key)?.pct,
            backup: backups?.get(c.key),
            issues: tenantIssues.filter(i => i.clusterKey === c.key),
          }))}
          busiest={tenantClusters
            .flatMap(c => (workload.byKey.get(c.key)?.utilisation?.nodes ?? []).map(n => ({ cluster: c, node: n.name, cpuPct: n.cpuPct, memPct: n.memPct })))
            .sort((a, b) => Math.max(b.cpuPct, b.memPct) - Math.max(a.cpuPct, a.memPct))}
          subnets={inventory ? Array.from(inventory.values()).flatMap(i => i.subnets).filter(s => s.capacity > 0) : undefined}
          packageDrift={packageStats?.drift}
          supervisors={multiSupervisor && supervisorFilter === ALL ? results.map(r => ({ id: r.supervisor.id, name: supervisorLabel(r.supervisor), clusters: r.clusters })) : undefined}
          onSupervisor={multiSupervisor ? setSupervisorFilter : undefined}
        />
        </Guard>
      )}

      <Box id="tenants" sx={{ scrollMarginTop: 72 }} />
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

      <Box id="clusters" sx={{ scrollMarginTop: 72 }} />
      {(healthFilter || versionFilter || attentionOnly || upgradableOnly) && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1, px: 1 }}>
          <Typography variant="body2">
            Showing{' '}
            {[
              healthFilter && `${healthFilter} clusters`,
              versionFilter && `clusters on ${versionFilter}`,
              attentionOnly && 'clusters with problems or upgrades in progress',
              upgradableOnly && 'clusters with an upgrade available',
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            ({visible.length}).
          </Typography>
          <Button
            size="small"
            onClick={() => setParams({ health: undefined, version: undefined, attention: undefined, upgradable: undefined })}
          >
            Clear filters
          </Button>
        </Box>
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

      <Box id="issues" sx={{ scrollMarginTop: 72 }} />
      <IssuesSection
        silenced={silenced}
        silences={silences}
        issues={tenantIssues}
        clusters={clusterByKey}
        supervisorNames={supervisorNames}
        showInfo={showInfo}
        setShowInfo={setShowInfo}
        open={findingsOpen}
        setOpen={setFindingsOpen}
      />

      {exportOpen && (
        <ExportDialog
          onClose={() => setExportOpen(false)}
          make={() => ({
            clusters: tenantClusters,
            issues: tenantIssues,
            scores: new Map(scores.map(x => [x.cluster.key, x.card])),
            now: new Date(),
            title: tenant === ALL ? 'VKS fleet report' : `VKS fleet report: ${tenantById.get(tenant)?.tenantName ?? tenant}`,
          })}
        />
      )}

      <Typography variant="body2" color="text.secondary" sx={{ px: 2, mb: 2 }}>
        Capacity per cluster is on <Link to="/vks-fleet/capacity">Capacity &amp; cost</Link>; Supervisor services on{' '}
        <Link to="/vks-fleet/supervisor-health">Supervisor health</Link>.
      </Typography>
    </>
  );
}

function IssuesSection({
  silenced,
  silences,
  issues,
  clusters,
  supervisorNames,
  showInfo,
  setShowInfo,
  open,
  setOpen,
}: {
  silenced: Array<{ issue: ReturnType<typeof buildIssues>[number]; by: Silence }>;
  silences: Silence[];
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
  const [showSilenced, setShowSilenced] = React.useState(false);
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
      {open && shown.length > 0 && (
        <Guard name="Issues">
          <IssuesList issues={shown} clusters={clusters} supervisorNames={supervisorNames} limit={5} />
        </Guard>
      )}
      {silences.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" onClick={() => setShowSilenced(!showSilenced)}>
            {showSilenced ? 'Hide silences' : `Silences: ${silences.length} active, muting ${silenced.length} issue${silenced.length === 1 ? '' : 's'}`}
          </Button>
          {showSilenced && (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {silences.map(sl => (
                <li key={sl.id}>
                  <Typography variant="body2" component="span">
                    <b>{sl.match.clusterKey ? `Maintenance: ${sl.label}` : sl.label}</b> until {new Date(sl.until).toLocaleString()} — {sl.reason} (
                    {silenced.filter(x => x.by.id === sl.id).length} muted)
                  </Typography>{' '}
                  {isOwnSilence(sl.id) && (
                    <Button size="small" onClick={() => removeSilence(sl.id)}>
                      End now
                    </Button>
                  )}
                </li>
              ))}
            </Box>
          )}
        </Box>
      )}
    </SectionBox>
  );
}

function ExportDialog({ onClose, make }: { onClose: () => void; make: () => Parameters<typeof fleetReportMarkdown>[0] }) {
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Export fleet report</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          The clusters shown (respecting the Supervisor and tenant filters): health, versions, upgrades, capacity,
          scores and the issues that need action.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          <Button variant="contained" onClick={() => download(`vks-fleet-report-${stamp}.md`, fleetReportMarkdown(make()), 'text/markdown')}>
            Markdown
          </Button>
          <Button variant="outlined" onClick={() => download(`vks-fleet-clusters-${stamp}.csv`, fleetReportCsv(make()), 'text/csv')}>
            CSV (one row per cluster)
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
