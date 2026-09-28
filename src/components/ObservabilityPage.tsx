import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { headlampClient } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { Alert as FiringAlert, firstWith, Forecast, humanDuration, ObservabilitySummary, Panel, PANELS, range, Range, RANGES, Series } from '../observability';
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

      <SectionBox title="Clusters">
        <SimpleTable
          columns={[
            { label: 'Cluster', getter: (s: ObservabilitySummary) => <Button size="small" onClick={() => select(s.clusterKey)} disabled={!s.reachable}>{s.clusterName}</Button> },
            {
              label: 'Monitoring',
              getter: (s: ObservabilitySummary) =>
                s.reachable ? (
                  <StatusLabel status="success">{`Prometheus ${s.version ?? ''}`.trim()}</StatusLabel>
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
            { label: 'Node CPU (max)', getter: (s: ObservabilitySummary) => kpi(s.kpis.nodeCpu, 'percent', 85) },
            { label: 'Node memory (max)', getter: (s: ObservabilitySummary) => kpi(s.kpis.nodeMem, 'percent', 90) },
            { label: 'API p99', getter: (s: ObservabilitySummary) => kpi(s.kpis.apiP99, 'seconds', 1) },
            { label: 'API 5xx/s', getter: (s: ObservabilitySummary) => kpi(s.kpis.api5xx, 'rate', 0.5) },
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

function kpi(v: number | undefined, unit: Parameters<typeof formatValue>[1], warn: number) {
  if (v === undefined) return '—';
  return <StatusLabel status={v > warn ? 'warning' : ''}>{formatValue(v, unit)}</StatusLabel>;
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
    </SectionBox>
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
