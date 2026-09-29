import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import React from 'react';
import { Series, seriesStats, Unit } from '../observability';
import { formatValue, Marker, TimeSeriesChart } from './TimeSeriesChart';

const WINDOWS: Array<{ label: string; hours: number }> = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
];

/** A large view of series the plugin already has (no query): statistics, a meaning, the changes in the window. */
export function SeriesDetailDialog({ title, subtitle, series, legend, unit, warnAbove, meaning, markers = [], onClose }: {
  title: string;
  subtitle?: string;
  series: Series[];
  legend: (l: Record<string, string>) => string;
  unit: Unit;
  warnAbove?: number;
  meaning: string;
  markers?: Marker[];
  onClose: () => void;
}) {
  const [hours, setHours] = React.useState(24);
  const end = Math.floor(Date.now() / 60000) * 60000;
  const start = end - hours * 3600e3;
  const shown = series.map(s => ({ ...s, points: s.points.filter(p => p[0] >= start) })).filter(s => s.points.length);
  const rows = shown.map(s => ({ name: legend(s.labels), st: seriesStats(s.points) })).filter(r => r.st).sort((a, b) => b.st!.max - a.st!.max);
  const inWindow = markers.filter(m => m.time >= start && m.time <= end).sort((a, b) => b.time - a.time);
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
        <span>
          {title} {subtitle && <Typography component="span" variant="body2" color="text.secondary">{subtitle}</Typography>}
        </span>
        <Box sx={{ flex: 1 }} />
        {WINDOWS.map(w => (
          <Button key={w.label} size="small" variant={w.hours === hours ? 'contained' : 'text'} onClick={() => setHours(w.hours)}>
            {w.label}
          </Button>
        ))}
      </DialogTitle>
      <DialogContent>
        {shown.length ? (
          <TimeSeriesChart series={shown} legend={legend} unit={unit} start={start} end={end} markers={markers} warnAbove={warnAbove} height={320} />
        ) : (
          <Typography color="text.secondary">No samples in this window yet.</Typography>
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
                  {rows.map(r => (
                    <tr key={r.name}>
                      <Box component="td" sx={{ p: 0.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</Box>
                      {[r.st!.min, r.st!.avg, r.st!.p95, r.st!.max].map((v, i) => (
                        <Box component="td" key={i} sx={{ p: 0.5, textAlign: 'right', color: warnAbove !== undefined && v > warnAbove && i >= 2 ? 'warning.main' : undefined }}>
                          {formatValue(v, unit)}
                        </Box>
                      ))}
                      <Box component="td" sx={{ p: 0.5, textAlign: 'right', fontWeight: 700 }}>{formatValue(r.st!.latest, unit)}</Box>
                    </tr>
                  ))}
                </tbody>
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">—</Typography>
            )}
            {warnAbove !== undefined && rows.some(r => r.st!.max > warnAbove) && (
              <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
                <StatusLabel status="warning">{`above ${formatValue(warnAbove, unit)}`}</StatusLabel> {rows.filter(r => r.st!.max > warnAbove).length} went over the warning level in this window.
              </Typography>
            )}
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 600, mb: 0.5 }}>What it means</Typography>
            <Typography variant="body2" sx={{ mb: 1.5 }}>{meaning}</Typography>
            {markers.length > 0 && (
              <>
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
              </>
            )}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
