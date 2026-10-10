import { Loader, SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
  Tab,
  Tabs,
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
import { diskForecast, entitiesFor, matchSupervisor, STALE_MINUTES, supervisorScore, utilisationIssues, vcenterIssues } from '../vcenterStatus';
import { attentionByTenant, fixCounts, fixesByIssue, fleetScore, scoreDrivers, wallTiles } from '../fixes';
import { horizon, needsYouNow } from '../fleetHero';
import { blockNumbers, compactNow, dashboardBlocks, demoBlockValue, FleetTab, headline, scoreLine, tabFromLocation } from '../dashboard';
import { sinceLast, sinceLastText } from '../scoreHistory';
import { formatBytes } from '../quantity';
import { ClusterWall } from './ClusterWall';
import { BlockGrid, ScoreHeader } from './Dashboard';
import { card, HorizonTimeline, NowList, SimulatePanel } from './FleetHero';
import { useScoreHistory } from './scoreHistoryStore';
import { settingsStore } from '../settings/store';
import { FleetDetails } from './FleetDetails';
import { shortener, shortNode } from '../names';
import { useScannerReports } from '../useScannerReports';
import { useComplianceStore } from './complianceStore';
import { OrgCards, OrgSummary } from './OrgCards';
import { Guard } from './Guard';
import { isOwnSilence, removeSilence } from './SilenceDialog';
import { packageDrift } from '../packages';
import { clusterDeepLink, FLEET_PATH, SEARCH_ROUTE } from '../routes';
import { download, fleetReportCsv, fleetReportMarkdown } from '../report';
import { usePackages } from '../usePackages';
import { useBackups } from '../useBackups';
import { useClusterScans } from '../useClusterScans';
import { configuredByNamespace } from '../limits';
import { limitIssues } from '../limitIssues';
import { compliance, evaluateBaseline, profileFor } from '../baseline';
import { fleetTotals, needsAttention, rollupByTenant } from '../summary';
import { FleetCluster, Health, supervisorLabel } from '../types';
import { useWorkloadHealth } from '../useWorkload';
import { SupervisorBanners } from './common';
import { IssuesList } from './IssuesList';

const ALL = '__all__';


export function FleetView() {
  const { config, results, refreshing, refresh, inventory, limits, orgQuotas, all, inventoryAll, org } = useFleetData();

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
  const setSupervisorFilter = (id: string) => setParams({ supervisor: id === ALL ? undefined : id, tenant: undefined });
  const setAttentionOnly = (b: boolean) => setParams({ attention: b ? '1' : undefined });
  // Dashboard, Clusters, Issues: the tab lives in the address, so links and the back button work.
  const tab = tabFromLocation(location.search, location.hash);
  const goTab = (next: FleetTab) => {
    const p = new URLSearchParams(location.search);
    if (next === 'dashboard') p.delete('tab');
    else p.set('tab', next);
    // Cluster filters belong to the Clusters tab; they don't follow to the others.
    if (next !== 'clusters') for (const k of ['health', 'version', 'attention', 'upgradable']) p.delete(k);
    const qs = p.toString();
    history.push(`${FLEET_PATH}${qs ? `?${qs}` : ''}`);
  };
  // A link to a section (the dashboard's "Next 30 days" block) scrolls to it once the tab has drawn.
  React.useEffect(() => {
    if (!location.hash) return undefined;
    const t = window.setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    return () => window.clearTimeout(t);
  }, [location.hash, tab]);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [showInfo, setShowInfo] = React.useState(false);
  // Simulate fixes: recomputes the picture only; nothing is sent anywhere.
  const [simulate, setSimulate] = React.useState(false);
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
  // The Issues tab is where the list lives: open unless it was hidden.
  const findingsOpen = findingsToggled ?? true;
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

  const actions = [
    <Button key="search" size="small" variant="outlined" component={Link} to={SEARCH_ROUTE}>
      Search the fleet
    </Button>,
    <Button key="refresh" variant="contained" size="small" onClick={refresh} disabled={refreshing}>
      {refreshing ? 'Refreshing' : 'Refresh'}
    </Button>,
  ];

  if (config.supervisors.length === 0) {
    return (
      <SectionBox title="Welcome to VKS fleet">
        <Typography sx={{ mb: 2, maxWidth: 820 }}>
          One view of every vSphere Kubernetes Service cluster across your Supervisors: what needs you now, what runs out in the
          next 30 days, the Supervisor itself, and a pre-flight before every change.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, maxWidth: 980 }}>
          <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
            <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Try it with a demo fleet</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Two orgs, a Supervisor and clusters with realistic problems. Nothing is changed anywhere, and dry runs work. Turn it off in
              Settings whenever you like.
            </Typography>
            <Button variant="contained" onClick={() => settingsStore.update({ demo: true })}>
              Try the demo
            </Button>
          </Box>
          <Box sx={{ p: 2, border: 1, borderColor: 'divider', borderRadius: 2 }}>
            <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Connect your Supervisor</Typography>
            <Box component="ol" sx={{ m: 0, pl: 2.5, '& li': { mb: 0.5 } }}>
              <li>
                <Typography variant="body2">
                  Sign in to the Supervisor with <code>kubectl vsphere login</code>, so Headlamp has a cluster (context) for it.
                </Typography>
              </li>
              <li>
                <Typography variant="body2">Open Settings → Plugins → vks-fleet.</Typography>
              </li>
              <li>
                <Typography variant="body2">Add the Supervisor: pick that Headlamp cluster, and give it a short name.</Typography>
              </li>
            </Box>
          </Box>
        </Box>
      </SectionBox>
    );
  }

  if (results === null) {
    return <Loader title="Loading VKS clusters" />;
  }

  const tenantById = new Map(rollups.map(r => [r.tenantId, r]));

  const shortCluster = shortener(tenantClusters.map(c => c.name));
  // One rule for "needs attention" everywhere on the page: the wall's (as things are, not simulated).
  const tilesNow = wallTiles(tenantClusters, tenantIssues, false, shortCluster);
  const visibleKeys = new Set(visible.map(c => c.key));
  const now = Date.now();
  const hostsOf = (supervisorId: string) => (supervisorHealth ?? []).find(x => x.supervisorId === supervisorId)?.nodes.filter(n => n.role === 'host').map(n => n.name);
  const coming = horizon({
    now: new Date(now),
    clusters: tenantClusters,
    forecasts: (observability ?? []).filter(o => tenantClusters.some(c => c.key === o.clusterKey)).map(o => ({ clusterName: o.clusterName, clusterKey: o.clusterKey, forecasts: o.forecasts })),
    supervisorDisks: vcenter?.status
      ? (all ?? []).flatMap(r => {
          const v = matchSupervisor(vcenter.status!, r.supervisor, (all ?? []).length, hostsOf(r.supervisor.id));
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

  const cards = scores.map(x => x.card);
  const score = fleetScore(cards);
  const drivers = scoreDrivers(cards);
  const clusterLinks = new Map(tenantClusters.map(c => [c.key, { name: shortCluster(c.name), path: clusterDeepLink(c, { hash: 'checks' }) }]));
  const fixByIssue = fixesByIssue(tenantIssues, clusterByKey);
  const fixes = fixCounts(tenantIssues, clusterByKey);

  // The dashboard's blocks: each summarises what its own page computes.
  const canSeeSupervisor = !whoAmI || ['operator', 'readonly', 'unknown'].includes(whoAmI.persona);
  // The same score as Supervisor health shows: with vCenter's findings when the collector has data.
  const supervisorScores = (supervisorHealth ?? []).map(h => {
    const r = (all ?? []).find(x => x.supervisor.id === h.supervisorId);
    const v = r && vcenter?.status ? matchSupervisor(vcenter.status, r.supervisor, (all ?? []).length, hostsOf(h.supervisorId)) : undefined;
    return supervisorScore(h.score, v ?? undefined, vcenter?.status?.metrics);
  });
  const busiest = tenantClusters
    .flatMap(c => (workload.byKey.get(c.key)?.utilisation?.nodes ?? []).map(n => ({ cluster: c, node: n.name, pct: Math.max(n.cpuPct, n.memPct), what: n.memPct >= n.cpuPct ? ('memory' as const) : ('CPU' as const) })))
    .sort((x, y) => y.pct - x.pct)[0];
  const totals = fleetTotals(tenantClusters);
  const fullest = (inventory ? Array.from(inventory.values()).flatMap(i => i.subnets) : [])
    .filter(sn => sn.capacity > 0)
    .map(sn => ({ name: sn.name, pct: Math.round((sn.used / sn.capacity) * 100) }))
    .sort((x, y) => y.pct - x.pct)[0];
  const backupList = backups ? tenantClusters.map(c => backups.get(c.key)).filter((x): x is NonNullable<typeof x> => !!x && !x.error) : [];
  const blocks = dashboardBlocks({
    tiles: tilesNow,
    supervisor: { visible: canSeeSupervisor, score: supervisorScores.length ? Math.min(...supervisorScores) : undefined, staleControllers: (supervisorHealth ?? []).reduce((n, h) => n + h.leases.filter(l => l.state === 'stale').length, 0) },
    capacity: {
      busiest: busiest ? { cluster: shortCluster(busiest.cluster.name), node: shortNode(busiest.cluster.name, busiest.node), pct: busiest.pct, what: busiest.what } : undefined,
      cpus: totals.cpus,
      memoryText: formatBytes(totals.memoryBytes),
    },
    horizon: coming,
    now,
    lifecycle: { failing: packageStats?.failing, drift: packageStats?.drift.length, upgrading: totals.upgrading, upgradable: totals.upgradable },
    issues: tenantIssues,
    governance: {
      baselinePct: baselineRows.length ? Math.round(baselineRows.reduce((n, r) => n + r.pct, 0) / baselineRows.length) : undefined,
      backupsKnown: backupList.length,
      backedUp: backupList.filter(x => !x.missing && !!x.lastSuccess).length,
    },
    subnet: fullest,
  });
  // The score depends on packages and scans: the day's point is recorded once they've arrived.
  const ready = inventory !== null && (packageTargets.length === 0 || (packages !== null && scans !== null));
  const openCount = findingCounts.critical + findingCounts.warning;

  return (
    <>
      <SectionBox title="VKS fleet" headerProps={{ actions }}>
        <SupervisorBanners results={results} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 2, rowGap: 1, borderBottom: 1, borderColor: 'divider' }}>
          <Tabs value={tab} onChange={(_e: unknown, v: FleetTab) => goTab(v)} sx={{ flex: '1 1 auto', minWidth: 0 }}>
            <Tab label="Dashboard" value="dashboard" sx={{ textTransform: 'none', fontWeight: 600 }} />
            <Tab label={`Clusters (${tenantClusters.length})`} value="clusters" sx={{ textTransform: 'none', fontWeight: 600 }} />
            <Tab label={`Issues (${openCount})`} value="issues" sx={{ textTransform: 'none', fontWeight: 600 }} />
          </Tabs>
          {multiSupervisor && (
            <TextField select size="small" label="Supervisor" value={supervisorFilter} onChange={e => setSupervisorFilter(e.target.value)} sx={{ minWidth: 200, mb: 0.5 }}>
              <MenuItem value={ALL}>All Supervisors</MenuItem>
              {config.supervisors.map(s => (
                <MenuItem key={s.id} value={s.id}>
                  {supervisorLabel(s)}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Box>
      </SectionBox>

      {allClusters.length === 0 && !results.some(r => r.error) && (
        <SectionBox title="Clusters">
          <Typography>
            No VKS clusters found. Create a cluster in one of your Supervisor namespaces, or check the
            namespaces listed in the plugin settings.
          </Typography>
        </SectionBox>
      )}

      {tab === 'dashboard' && allClusters.length > 0 && (
        <Guard name="Dashboard">
          <DashboardTab
            scope={`${supervisorFilter}|${org}`}
            ready={ready}
            score={score}
            headline={headline(tilesNow)}
            line={since => scoreLine(score, since, drivers)}
            drivers={drivers}
            clusterLinks={clusterLinks}
            blocks={blocks}
            top={compactNow(needsYouNow(tenantIssues, coming, now, 3), shortCluster)}
            fixByIssue={fixByIssue}
            openCount={openCount}
            tiles={tilesNow}
            onIssues={() => goTab('issues')}
          />
        </Guard>
      )}

      {tab === 'clusters' && (
        <>
          {allClusters.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', px: 2, mb: 2 }}>
              <TextField size="small" label="Filter clusters or namespaces" value={search} onChange={e => setSearch(e.target.value)} />
              <FormControlLabel
                control={<Switch checked={attentionOnly} onChange={e => setAttentionOnly(e.target.checked)} />}
                label="Only clusters with problems or upgrades in progress"
              />
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" onClick={() => setExportOpen(true)}>
                Export report
              </Button>
            </Box>
          )}
          {(healthFilter || versionFilter || attentionOnly || upgradableOnly) && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1, px: 2 }}>
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
              <Button size="small" onClick={() => setParams({ health: undefined, version: undefined, attention: undefined, upgradable: undefined })}>
                Clear filters
              </Button>
            </Box>
          )}
          {allClusters.length > 0 && visible.length === 0 && (
            <SectionBox title="Clusters">
              <Typography>No clusters match these filters.</Typography>
            </SectionBox>
          )}
          {allClusters.length > 0 && visible.length > 0 && (
            <Guard name="Clusters">
              <FleetDetails
                rows={tenantClusters
                  .filter(c => visibleKeys.has(c.key))
                  .map(c => ({
                    cluster: c,
                    contextName: workload.byKey.get(c.key)?.contextName,
                    score: scores.find(x => x.cluster.key === c.key)?.card.score,
                    baseline: baselineRows.find(x => x.cluster.key === c.key)?.pct,
                    backup: backups?.get(c.key),
                    issues: tenantIssues.filter(i => i.clusterKey === c.key),
                  }))}
                supervisors={multiSupervisor && supervisorFilter === ALL ? results.map(r => ({ id: r.supervisor.id, name: supervisorLabel(r.supervisor), clusters: r.clusters })) : undefined}
                onSupervisor={multiSupervisor ? setSupervisorFilter : undefined}
              />
            </Guard>
          )}
          <Guard name="Org cards">
            <OrgCards attention={attentionByTenant(tilesNow)} />
            <OrgSummary />
          </Guard>
          {rollups
            .filter(r => !r.tenantNamed || r.unmapped)
            .map(r => (
              <Typography key={r.tenantId} variant="body2" color="text.secondary" sx={{ px: 2, mb: 1 }}>
                {!r.tenantNamed
                  ? `Org ${r.tenantId} has no name yet. Name it under Settings → Plugins → vks-fleet, where each Supervisor lists its org IDs.`
                  : `Some namespaces in ${r.tenantName} have no tenant label, so they're shown under their namespace name.`}
              </Typography>
            ))}
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, mb: 2 }}>
            Capacity per cluster is on <Link to="/vks-fleet/capacity">Capacity &amp; cost</Link>; subnets on <Link to="/vks-fleet/network">Network</Link>; packages on{' '}
            <Link to="/vks-fleet/packages">Lifecycle</Link>.
          </Typography>
        </>
      )}

      {tab === 'issues' && allClusters.length > 0 && (
        <>
          <Box sx={{ px: 2 }}>
            <SinceLastVisit issues={tenantIssues} ready={ready} />
          </Box>
          <Box sx={{ display: 'grid', gap: 2, px: 2, mb: 2 }}>
            <Guard name="Simulate fixes">
              <SimulatePanel fixes={fixes} simulate={simulate} score={score} simulatedScore={fleetScore(cards, true)} onSimulate={setSimulate} />
              {simulate && (
                <Paper variant="outlined" sx={card}>
                  <ClusterWall tiles={wallTiles(tenantClusters, tenantIssues, true, shortCluster)} simulate compact />
                </Paper>
              )}
            </Guard>
            <Box id="next-30-days" sx={{ scrollMarginTop: 72 }}>
              <Guard name="Next 30 days">
                <Paper variant="outlined" sx={card}>
                  <HorizonTimeline horizon={coming} now={now} />
                </Paper>
              </Guard>
            </Box>
          </Box>
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
            simulate={simulate}
          />
        </>
      )}

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
    </>
  );
}

/**
 * The dashboard tab: the score with its trend, what needs you now, the eight
 * blocks and the wall. One screen; every part opens the page behind it.
 */
function DashboardTab({
  scope,
  ready,
  score,
  headline: title,
  line,
  drivers,
  clusterLinks,
  blocks,
  top,
  fixByIssue,
  openCount,
  tiles,
  onIssues,
}: {
  /** Supervisor filter and org: each combination has its own history. */
  scope: string;
  ready: boolean;
  score?: number;
  headline: string;
  /** The line under the headline, given how the score moved since the last visit. */
  line: (since?: string) => string;
  drivers: ReturnType<typeof scoreDrivers>;
  clusterLinks: Map<string, { name: string; path: string }>;
  blocks: ReturnType<typeof dashboardBlocks>;
  top: ReturnType<typeof needsYouNow>;
  fixByIssue: ReturnType<typeof fixesByIssue>;
  /** Open issues that need action. */
  openCount: number;
  tiles: ReturnType<typeof wallTiles>;
  onIssues: () => void;
}) {
  const demoBlocks = (back: number) => Object.fromEntries(blocks.flatMap(b => (b.metric && demoBlockValue(b, back) !== undefined ? [[b.metric, demoBlockValue(b, back) as number]] : [])));
  const { today, points, stored } = useScoreHistory(scope, ready, score, blockNumbers(blocks), demoBlocks);
  const since = score === undefined ? undefined : sinceLastText(sinceLast(stored, today, score));
  return (
    <Box sx={{ display: 'grid', gap: 1.5, px: 2, mb: 2 }}>
      <ScoreHeader score={score} headline={title} line={line(since)} points={points} today={today} drivers={drivers} clusterLinks={clusterLinks} />
      <Paper variant="outlined" sx={{ ...card, py: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
          <Typography sx={{ fontWeight: 800, flex: 1 }}>Needs you now</Typography>
          <Button size="small" onClick={onIssues} sx={{ py: 0 }}>
            {openCount ? `All ${openCount} issue${openCount === 1 ? '' : 's'} ›` : 'Issues ›'}
          </Button>
        </Box>
        <NowList items={top} fixByIssue={fixByIssue} lines={1} />
      </Paper>
      <BlockGrid blocks={blocks} history={stored} today={today} />
      <Paper variant="outlined" sx={{ ...card, py: 1.5 }}>
        <ClusterWall tiles={tiles} simulate={false} compact />
      </Paper>
    </Box>
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
  simulate,
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
  simulate: boolean;
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
          <IssuesList issues={shown} clusters={clusters} supervisorNames={supervisorNames} limit={10} simulate={simulate} />
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
