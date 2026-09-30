import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React from 'react';
import { headlampClient } from '../api/headlampClient';
import { firstWith, mergeByNode, NEEDS_HELP, ObservabilitySummary, Panel, range, Range, RANGES, Series, seriesStats } from '../observability';
import { usePolling } from '../usePolling';
import { formatValue, Marker, TimeSeriesChart } from './TimeSeriesChart';

/** A chart, large, with more ranges, per-series statistics, the changes in the window, what it means, and the query. */
export function PanelDetailDialog({ panel, summary, markers, initialRange, onClose, resolve }: { panel: Panel; summary: ObservabilitySummary; markers: Marker[]; initialRange: Range; onClose: () => void; resolve?: (l: Record<string, string>) => string }) {
  const [rng, setRng] = React.useState<Range>(initialRange);
  const [copied, setCopied] = React.useState(false);
  const end = Math.floor(Date.now() / 60000) * 60000;
  const start = end - RANGES[rng] * 1000;
  const prom = summary.stack.prometheus!;
  const data = usePolling<{ series: Series[]; query?: string; error?: string }>(
    `detail|${summary.contextName}|${panel.id}|${rng}`,
    async () => {
      try {
        const r = await firstWith(panel.queries, q => range(headlampClient(summary.contextName), prom, q, rng));
        const raw = r.data as Series[];
        return { series: panel.perNode && resolve ? mergeByNode(raw, resolve) : raw, query: r.query };
      } catch (err) {
        return { series: [], error: String((err as Error)?.message ?? err) };
      }
    },
    120
  );
  const inWindow = markers.filter(m => m.time >= start && m.time <= end).sort((a, b) => b.time - a.time);
  const rows = (data?.series ?? []).map(s => ({ name: (panel.perNode && resolve ? (l: Record<string, string>) => l.name : panel.legend)(s.labels), st: seriesStats(s.points) })).filter(r => r.st).sort((a, b) => b.st!.max - a.st!.max);
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <span>
          {panel.title} <Typography component="span" variant="body2" color="text.secondary">{summary.clusterName}</Typography>
        </span>
        <Box sx={{ flex: 1 }} />
        {(Object.keys(RANGES) as Range[]).map(r => (
          <Button key={r} size="small" variant={r === rng ? 'contained' : 'text'} onClick={() => setRng(r)}>
            {r}
          </Button>
        ))}
      </DialogTitle>
      <DialogContent>
        {!data ? (
          <Typography color="text.secondary">Loading…</Typography>
        ) : data.error ? (
          <Typography color="error">{data.error}</Typography>
        ) : !data.series.length ? (
          <Typography color="text.secondary">Not collected here (needs {panel.needs}). {NEEDS_HELP[panel.needs] ?? ''}</Typography>
        ) : (
          <TimeSeriesChart series={data.series} legend={panel.perNode && resolve ? (l: Record<string, string>) => l.name : panel.legend} unit={panel.unit} start={start} end={end} markers={markers} warnAbove={panel.warnAbove} height={320} />
        )}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 3, mt: 2 }}>
          <Box>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Over this window</Typography>
            {rows.length ? (
              <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums' }}>
                <thead>
                  <tr>
                    {['Series', 'Min', 'Average', 'p95', 'Max', 'Latest'].map(h => (
                      <Box component="th" key={h} sx={{ textAlign: h === 'Series' ? 'left' : 'right', p: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                        {h}
                      </Box>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 12).map(r => (
                    <tr key={r.name}>
                      <Box component="td" sx={{ p: 0.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</Box>
                      {[r.st!.min, r.st!.avg, r.st!.p95, r.st!.max].map((v, i) => (
                        <Box component="td" key={i} sx={{ p: 0.5, textAlign: 'right', color: panel.warnAbove !== undefined && v > panel.warnAbove && i >= 2 ? 'warning.main' : undefined }}>
                          {formatValue(v, panel.unit)}
                        </Box>
                      ))}
                      <Box component="td" sx={{ p: 0.5, textAlign: 'right', fontWeight: 700 }}>{formatValue(r.st!.latest, panel.unit)}</Box>
                    </tr>
                  ))}
                </tbody>
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">—</Typography>
            )}
            {panel.warnAbove !== undefined && rows.some(r => r.st!.max > panel.warnAbove!) && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                <StatusLabel status="warning">{`above ${formatValue(panel.warnAbove, panel.unit)}`}</StatusLabel> {rows.filter(r => r.st!.max > panel.warnAbove!).length} series went over the warning level in this window.
              </Typography>
            )}
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>What it means</Typography>
            <Typography variant="body2" sx={{ mb: 1.5 }}>{panel.meaning}</Typography>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Changes in this window</Typography>
            {inWindow.length ? (
              inWindow.slice(0, 8).map((m, i) => (
                <Typography key={i} variant="body2">
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums', mr: 1 }}>
                    {new Date(m.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Typography>
                  {m.text}
                </Typography>
              ))
            ) : (
              <Typography variant="body2" color="text.secondary">None recorded by the fleet.</Typography>
            )}
          </Box>
        </Box>
        {data?.query && (
          <Box sx={{ mt: 2, display: 'flex', gap: 1, alignItems: 'center' }}>
            <Box component="code" sx={{ flex: 1, fontSize: '0.75rem', p: 1, bgcolor: 'action.hover', borderRadius: 1, overflowX: 'auto', whiteSpace: 'nowrap' }}>
              {data.query}
            </Box>
            <Button
              size="small"
              onClick={() => {
                navigator.clipboard?.writeText(data.query!);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy PromQL'}
            </Button>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
