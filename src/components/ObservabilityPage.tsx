import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';
import { headlampClient } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { Alert as FiringAlert, apiName, DeprecatedApi, firstWith, Forecast, humanDuration, ObservabilitySummary, Panel, PANELS, range, Range, RANGES, removedBy, Series, serverSetupCommands, Unusual } from '../observability';
import { AppComparison, compareApps, fetchAppUsage, fetchRightSizing, RightSizing, WorkloadSizing } from '../compare';
import { configuredByNamespace } from '../limits';
import { compareVersions } from '../packages';
import { formatBytes } from '../quantity';
import { fleetTimeline } from '../timeline';
import { FleetCluster } from '../types';
import { useObservability } from '../useObservability';
import { usePackages } from '../usePackages';
import { usePolling } from '../usePolling';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';
import { NoClusters } from './EmptyState';
import { PackageInstallDialog } from './PackageInstallDialog';
import { SignInHelper } from './SignInHelper';
import { formatValue, Marker, TimeSeriesChart } from './TimeSeriesChart';

export function ObservabilityPage() {
  const { config, results, canWrite, refresh } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const summaries = useObservability(targets);
  const location = useLocation();
  const history = useHistory();
  const selected = new URLSearchParams(location.search).get('cluster');
  const [rng, setRng] = React.useState<Range>('24h');
  const [enabling, setEnabling] = React.useState<string | null>(null);
  const packages = usePackages(enabling ? targets.filter(t => t.key === enabling) : [], 120);
  const [serverFor, setServerFor] = React.useState<ObservabilitySummary | null>(null);
  const [compareOn, setCompareOn] = React.useState(false);
  const comparisons = usePolling<AppComparison[]>(
    compareOn && summaries ? `compare|${summaries.filter(s => s.reachable).map(s => s.clusterKey).join(',')}` : null,
    async () =>
      compareApps(
        (await Promise.all((summaries ?? []).filter(s => s.reachable).map(s => fetchAppUsage(headlampClient(s.contextName), s.stack.prometheus!, s.clusterName).catch(() => [])))).flat()
      ),
    600
  );

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Observability" what="monitoring information" />;
  if (targets.length > 0 && summaries === null) return <Loader title="Looking for Prometheus in the clusters" />;
  const list = summaries ?? [];
  const byKey = new Map(clusters.map(c => [c.key, c]));
  const select = (key: string | null) => history.replace(`${location.pathname}${key ? `?cluster=${encodeURIComponent(key)}` : ''}`);
  const monitored = list.filter(s => s.reachable);
  const forecasts = list.flatMap(s => s.forecasts.map(f => ({ ...f, s })));
  const alerts = list.flatMap(s => s.alerts.map(a => ({ ...a, s })));
  const worstP99 = Math.max(0, ...monitored.map(s => s.kpis.apiP99 ?? 0));
  const sel = list.find(s => s.clusterKey === selected);
  const enableTarget = enabling && packages?.get(enabling);

  return (
    <>
      <ChartStyles />
      <SectionBox title="Observability">
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          From each cluster's own Prometheus and Alertmanager, queried through the Kubernetes API (no extra endpoints or
          credentials). Forecasts project the last six hours forward; the fleet's changes are drawn on every chart.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 2 }}>
          <KpiTile label="Monitored" value={`${monitored.length}/${clusters.length}`} sub="clusters with Prometheus" tone={monitored.length === clusters.length ? 'success' : 'warning'} meter={{ value: monitored.length, max: clusters.length }} />
          <KpiTile label="Alerts firing" value={alerts.length} sub={`${alerts.filter(a => a.severity === 'critical').length} critical`} tone={alerts.some(a => a.severity === 'critical') ? 'error' : alerts.length ? 'warning' : 'success'} />
          <KpiTile label="Running out soon" value={forecasts.filter(f => f.seconds < 7 * 86400).length} sub="within 7 days" tone={forecasts.some(f => f.seconds < 2 * 86400) ? 'error' : forecasts.some(f => f.seconds < 7 * 86400) ? 'warning' : 'success'} />
          <KpiTile label="Slowest API (p99)" value={monitored.length ? formatValue(worstP99, 'seconds') : '—'} tone={worstP99 > 1 ? 'error' : worstP99 > 0.5 ? 'warning' : 'success'} />
        </Box>
      </SectionBox>

      {forecasts.length > 0 && (
        <SectionBox title="Running out (forecasts)">
          <SimpleTable
            columns={[
              { label: 'Runs out in', getter: (f: Forecast & { s: ObservabilitySummary }) => <StatusLabel status={f.seconds < 2 * 86400 ? 'error' : f.seconds < 7 * 86400 ? 'warning' : ''}>{humanDuration(f.seconds)}</StatusLabel> },
              { label: 'What', getter: (f: Forecast & { s: ObservabilitySummary }) => f.what },
              { label: 'Where', getter: (f: Forecast & { s: ObservabilitySummary }) => <b>{f.subject}</b> },
              { label: 'Cluster', getter: (f: Forecast & { s: ObservabilitySummary }) => <Button size="small" onClick={() => select(f.s.clusterKey)}>{f.s.clusterName}</Button> },
            ]}
            data={forecasts.sort((a, b) => a.seconds - b.seconds)}
          />
          <Typography variant="caption" color="text.secondary">At the rate of the last six hours; a straight line, so check the chart before acting on a long forecast.</Typography>
        </SectionBox>
      )}

      {alerts.length > 0 && (
        <SectionBox title="Alerts firing">
          <SimpleTable
            columns={[
              { label: 'Severity', getter: (a: FiringAlert & { s: ObservabilitySummary }) => <StatusLabel status={a.severity === 'critical' ? 'error' : a.severity === 'warning' ? 'warning' : ''}>{a.severity}</StatusLabel> },
              { label: 'Alert', getter: (a: FiringAlert & { s: ObservabilitySummary }) => <b>{a.name}</b> },
              { label: 'Summary', getter: (a: FiringAlert & { s: ObservabilitySummary }) => a.summary ?? '—' },
              { label: 'Cluster', getter: (a: FiringAlert & { s: ObservabilitySummary }) => a.s.clusterName },
              { label: 'Since', getter: (a: FiringAlert & { s: ObservabilitySummary }) => (a.since ? new Date(a.since).toLocaleString() : '—') },
            ]}
            data={alerts}
          />
        </SectionBox>
      )}

      {list.some(s => s.deprecatedApis.length) && (
        <SectionBox title="Upgrade safety: deprecated APIs in use">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            From each API server's own count of requests to deprecated APIs, since it last started. Anything removed by a release
            you plan to move to breaks its callers; the Upgrade Planner checks this for each cluster's target.
          </Typography>
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (d: DeprecatedApi & { s: ObservabilitySummary; newest?: string }) => d.s.clusterName },
              { label: 'API', getter: (d: DeprecatedApi & { s: ObservabilitySummary; newest?: string }) => <b>{apiName(d)}</b> },
              { label: 'Removed in', getter: (d: DeprecatedApi & { s: ObservabilitySummary; newest?: string }) => d.removedRelease ?? '—' },
              {
                label: 'Newest release here',
                getter: (d: DeprecatedApi & { s: ObservabilitySummary; newest?: string }) =>
                  d.newest ? <StatusLabel status={removedBy(d, d.newest) ? 'error' : 'success'}>{`${d.newest}${removedBy(d, d.newest) ? ': breaks' : ': fine'}`}</StatusLabel> : '—',
              },
            ]}
            data={list.flatMap(s => {
              const r = (results ?? []).find(x => x.clusters.some(c => c.key === s.clusterKey));
              const newest = [...(r?.releases ?? [])].sort((a, b) => compareVersions(b, a))[0];
              return s.deprecatedApis.map(d => ({ ...d, s, newest }));
            })}
          />
        </SectionBox>
      )}

      {monitored.length > 1 && (
        <SectionBox
          title="The same app across clusters"
          headerProps={{ actions: [<Button key="c" size="small" variant="outlined" onClick={() => setCompareOn(true)} disabled={compareOn}>{compareOn ? (comparisons ? 'Compared' : 'Comparing…') : 'Compare'}</Button>] }}
        >
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Workloads with the same name and image in more than one cluster: CPU and memory per replica over the last hour,
            restarts over the last day. Big differences point at the environment, not the code.
          </Typography>
          {compareOn && comparisons && (comparisons.length ? comparisons.map(a => <AppCompareCard key={`${a.app}|${a.repo}`} a={a} />) : <Typography color="text.secondary">No app runs in more than one monitored cluster.</Typography>)}
        </SectionBox>
      )}

      <SectionBox title="Clusters">
        <SimpleTable
          columns={[
            { label: 'Cluster', getter: (s: ObservabilitySummary) => <Button size="small" onClick={() => select(s.clusterKey)} disabled={!s.reachable}>{s.clusterName}</Button> },
            {
              label: 'Monitoring',
              getter: (s: ObservabilitySummary) =>
                s.reachable ? (
                  <StatusLabel status="success">{`Prometheus ${s.version ?? ''}`.trim()}</StatusLabel>
                ) : s.exportersOnly ? (
                  <Button size="small" variant="outlined" onClick={() => setServerFor(s)} title="Exporters run here, but no Prometheus server stores or queries their metrics">
                    Add a Prometheus server…
                  </Button>
                ) : s.stack.prometheus ? (
                  <span title={s.error}>
                    <StatusLabel status="warning">Found, not reachable</StatusLabel>
                  </span>
                ) : canWrite(byKey.get(s.clusterKey)?.supervisorId ?? '') ? (
                  <Button size="small" variant="outlined" onClick={() => setEnabling(s.clusterKey)}>
                    Enable monitoring…
                  </Button>
                ) : (
                  'None'
                ),
            },
            { label: 'Node CPU (max)', getter: (s: ObservabilitySummary) => kpi(s.kpis.nodeCpu, 'percent', 85, s.unusual.find(u => u.kpi === 'nodeCpu')) },
            { label: 'Node memory (max)', getter: (s: ObservabilitySummary) => kpi(s.kpis.nodeMem, 'percent', 90, s.unusual.find(u => u.kpi === 'nodeMem')) },
            { label: 'API p99', getter: (s: ObservabilitySummary) => kpi(s.kpis.apiP99, 'seconds', 1, s.unusual.find(u => u.kpi === 'apiP99')) },
            { label: 'API 5xx/s', getter: (s: ObservabilitySummary) => kpi(s.kpis.api5xx, 'rate', 0.5, s.unusual.find(u => u.kpi === 'api5xx')) },
            { label: 'Restarts (1 h)', getter: (s: ObservabilitySummary) => kpi(s.kpis.restarts, 'count', 3) },
            { label: 'Alerts', getter: (s: ObservabilitySummary) => (s.stack.alertmanager ? (s.alertsReadable ? s.alerts.length : 'not reachable') : 'no Alertmanager') },
          ]}
          data={list}
        />
        {list.some(s => !s.stack.prometheus) && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Enable monitoring installs the VKS Prometheus package (with Alertmanager, node-exporter and kube-state-metrics) from the
            cluster's own repository. It needs a default StorageClass, or set prometheus.pvc.storageClassName in its values.
          </Typography>
        )}
      </SectionBox>

      {sel?.reachable && byKey.get(sel.clusterKey) && (
        <ClusterPanels summary={sel} cluster={byKey.get(sel.clusterKey)!} clusters={clusters} rng={rng} setRng={setRng} onClose={() => select(null)} />
      )}

      {serverFor && <ServerSetupDialog s={serverFor} onClose={() => setServerFor(null)} />}
      {enabling && !enableTarget && <Loader title="Reading the cluster's package catalog" />}
      {enableTarget &&
        (() => {
          const prom = (enableTarget.definitions ?? []).find(d => /^prometheus\./.test(d.refName));
          if (!prom) {
            return (
              <Alert severity="info" onClose={() => setEnabling(null)} sx={{ m: 2 }}>
                This cluster's package repositories don't offer Prometheus. Add the VKS standard packages repository first.
              </Alert>
            );
          }
          return (
            <PackageInstallDialog
              refName={prom.refName}
              displayName="Prometheus"
              targets={[{ cluster: byKey.get(enabling!)!, cp: enableTarget, writable: true }]}
              onClose={() => setEnabling(null)}
              onDone={() => refresh()}
            />
          );
        })()}
    </>
  );
}

function kpi(v: number | undefined, unit: Parameters<typeof formatValue>[1], warn: number, unusual?: Unusual) {
  if (v === undefined) return '—';
  return (
    <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
      <StatusLabel status={v > warn ? 'warning' : ''}>{formatValue(v, unit)}</StatusLabel>
      {unusual && (
        <span title={`A week ago at this time: ${formatValue(unusual.weekAgo, unit)}`}>
          <StatusLabel status="warning">unusual for this time</StatusLabel>
        </span>
      )}
    </Box>
  );
}

function ServerSetupDialog({ s, onClose }: { s: ObservabilitySummary; onClose: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const text = serverSetupCommands(s.contextName, s.stack.exporterNamespace);
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Add a Prometheus server to {s.clusterName}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {s.clusterName} runs metric exporters ({[s.stack.nodeExporter && 'node-exporter', s.stack.kubeStateMetrics && 'kube-state-metrics'].filter(Boolean).join(', ')} in{' '}
          {s.stack.exporterNamespace ?? 'the cluster'}), typically VKS's managed add-on, but no Prometheus server to store and query
          them. These commands add one (with Alertmanager) in its own namespace, scraping the existing exporters without touching
          them. Run them where Helm and the cluster's sign-in are available; it needs a default StorageClass.
        </Typography>
        <Box component="pre" sx={{ p: 1.5, bgcolor: 'action.hover', borderRadius: 1, fontSize: '0.78rem', overflowX: 'auto', maxHeight: 380 }}>
          {text}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy commands'}
        </Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function AppCompareCard({ a }: { a: AppComparison }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 2 }}>
      <Typography sx={{ fontWeight: 600 }}>
        {a.app} <Typography component="span" variant="caption" color="text.secondary">{a.repo}</Typography>
      </Typography>
      {a.notes.map((n, i) => (
        <Typography key={i} variant="body2" color="warning.main">
          {n}
        </Typography>
      ))}
      <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem', mt: 0.5 }}>
        <thead>
          <tr>
            {['Cluster', 'Version', 'Replicas', 'CPU / replica', 'Memory / replica', 'Restarts (24 h)'].map(h => (
              <Box component="th" key={h} sx={{ textAlign: 'left', p: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                {h}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {a.rows.map(r => (
            <tr key={`${r.cluster}/${r.namespace}`}>
              <Box component="td" sx={{ p: 0.5 }}>{r.cluster} <Typography component="span" variant="caption" color="text.secondary">{r.namespace}</Typography></Box>
              <Box component="td" sx={{ p: 0.5 }}>{r.tag}</Box>
              <Box component="td" sx={{ p: 0.5 }}>{r.replicas}</Box>
              <Box component="td" sx={{ p: 0.5 }}>{r.cpuPerReplica.toFixed(2)} cores</Box>
              <Box component="td" sx={{ p: 0.5 }}>{formatBytes(r.memPerReplica)}</Box>
              <Box component="td" sx={{ p: 0.5, color: r.restarts24h ? 'error.main' : undefined }}>{r.restarts24h}</Box>
            </tr>
          ))}
        </tbody>
      </Box>
    </Paper>
  );
}

function ClusterPanels({ summary, cluster, clusters, rng, setRng, onClose }: { summary: ObservabilitySummary; cluster: FleetCluster; clusters: FleetCluster[]; rng: Range; setRng: (r: Range) => void; onClose: () => void }) {
  const end = Math.floor(Date.now() / 60000) * 60000;
  const start = end - RANGES[rng] * 1000;
  const markers: Marker[] = (fleetTimeline(clusters, new Date(end), 8).get(cluster.key) ?? []).map(e => ({ time: new Date(e.time).getTime(), text: e.text, tone: e.tone }));
  return (
    <SectionBox
      title={`${cluster.name}: metrics`}
      headerProps={{
        actions: [
          ...(Object.keys(RANGES) as Range[]).map(r => (
            <Button key={r} size="small" variant={r === rng ? 'contained' : 'text'} onClick={() => setRng(r)}>
              {r}
            </Button>
          )),
          <Button key="inc" size="small" variant="outlined" component={Link} to={`/vks-fleet/incident?cluster=${encodeURIComponent(cluster.key)}`}>
            Incident timeline
          </Button>,
          <Button key="x" size="small" onClick={onClose}>
            Close
          </Button>,
        ],
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Dashed lines mark the fleet's changes in this cluster (node replacements, upgrades, actions); hover the triangle for what
        happened. {markers.filter(m => m.time >= start).length ? '' : 'No changes in this window.'}
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 2 }}>
        {PANELS.map(p => (
          <PanelCard key={p.id} panel={p} summary={summary} rng={rng} start={start} end={end} markers={markers} />
        ))}
      </Box>
      <RightSizingSection summary={summary} cluster={cluster} />
    </SectionBox>
  );
}

function RightSizingSection({ summary, cluster }: { summary: ObservabilitySummary; cluster: FleetCluster }) {
  const { all, inventoryAll, limitsAll } = useFleetData();
  const r = (all ?? []).find(x => x.clusters.some(c => c.key === cluster.key));
  const data = usePolling<RightSizing>(
    `sizing|${summary.contextName}`,
    () => fetchRightSizing(headlampClient(summary.contextName), summary.stack.prometheus!, cluster, r?.vmClasses ?? [], limitsAll.get(cluster.namespace), configuredByNamespace(all ?? [], inventoryAll).get(cluster.namespace)),
    900
  );
  if (!data) return <Typography sx={{ mt: 2 }} color="text.secondary">Working out right-sizing (a week of usage)…</Typography>;
  const c = data.cluster;
  const flagged = data.workloads.filter(w => w.verdict !== 'ok');
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 600 }}>Right-sizing</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        What workloads ask for against what they use (95th percentile over the last week), with requests suggested at p95 plus 30%.
        {data.historyHours !== undefined && data.historyHours < 72 ? ` Only ${data.historyHours} hours of history so far: treat these as rough.` : ''}
      </Typography>
      {c && (
        <Alert severity={c.pool && c.pool.suggestedNodes < c.pool.nodes ? 'info' : 'success'} sx={{ mb: 1.5 }}>
          Memory requested {formatBytes(c.requestedMem)}, used at p95 {formatBytes(c.p95Mem)}; CPU requested {c.requestedCpu.toFixed(1)} cores, used {c.p95Cpu.toFixed(1)}.
          {c.pool && c.pool.suggestedNodes < c.pool.nodes
            ? ` With right-sized requests, pool ${c.pool.name} needs about ${c.pool.suggestedNodes} ${c.pool.vmClass ?? ''} node${c.pool.suggestedNodes === 1 ? '' : 's'} instead of ${c.pool.nodes}, freeing ${formatBytes(c.freedMem ?? 0)} in ${cluster.namespace}${
                c.overcommitBefore && c.overcommitAfter ? `: memory overcommit goes from ${c.overcommitBefore.toFixed(1)}× to ${c.overcommitAfter.toFixed(1)}×` : ''
              }.`
            : c.pool
            ? ` Pool ${c.pool.name} is sized about right for what it runs.`
            : ''}
        </Alert>
      )}
      {flagged.length ? (
        <SimpleTable
          columns={[
            { label: '', getter: (w: WorkloadSizing) => <StatusLabel status={w.verdict === 'under' ? 'error' : 'warning'}>{w.verdict === 'under' ? 'uses more than it asks' : 'asks for much more'}</StatusLabel> },
            { label: 'Workload', getter: (w: WorkloadSizing) => <b>{`${w.namespace}/${w.workload}`}</b> },
            { label: 'Pods', getter: (w: WorkloadSizing) => w.pods },
            { label: 'CPU: asks → uses → suggest', getter: (w: WorkloadSizing) => `${w.cpuRequest.toFixed(2)} → ${w.cpuP95.toFixed(2)} → ${w.cpuSuggest.toFixed(2)}` },
            { label: 'Memory: asks → uses → suggest', getter: (w: WorkloadSizing) => `${formatBytes(w.memRequest)} → ${formatBytes(w.memP95)} → ${formatBytes(w.memSuggest)}` },
          ]}
          data={flagged.slice(0, 15)}
        />
      ) : (
        <Typography color="text.secondary">No workload is far off what it uses{data.workloads.length ? '' : ' (no requests recorded: needs kube-state-metrics)'}.</Typography>
      )}
    </Box>
  );
}

function PanelCard({ panel, summary, rng, start, end, markers }: { panel: Panel; summary: ObservabilitySummary; rng: Range; start: number; end: number; markers: Marker[] }) {
  const prom = summary.stack.prometheus!;
  const data = usePolling<{ series: Series[]; error?: string }>(
    `${summary.contextName}|${panel.id}|${rng}`,
    async () => {
      try {
        const r = await firstWith(panel.queries, q => range(headlampClient(summary.contextName), prom, q, rng));
        return { series: r.data as Series[] };
      } catch (err) {
        return { series: [], error: String((err as Error)?.message ?? err) };
      }
    },
    120
  );
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2 }}>
      <Typography sx={{ fontWeight: 600, mb: 0.5 }}>{panel.title}</Typography>
      {!data ? (
        <Typography variant="body2" color="text.secondary">Loading…</Typography>
      ) : data.error ? (
        <Typography variant="body2" color="error">{data.error}</Typography>
      ) : !data.series.length ? (
        <Typography variant="body2" color="text.secondary">Not collected here (needs {panel.needs}).</Typography>
      ) : (
        <TimeSeriesChart series={data.series} legend={panel.legend} unit={panel.unit} start={start} end={end} markers={markers} warnAbove={panel.warnAbove} />
      )}
    </Paper>
  );
}
