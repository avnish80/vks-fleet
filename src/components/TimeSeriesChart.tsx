import { Box, Typography } from '@mui/material';
import React from 'react';
import { Series, Unit } from '../observability';
import { formatBytes } from '../quantity';

export interface Marker {
  time: number;
  text: string;
  tone: 'success' | 'warning' | 'error' | 'info' | 'neutral';
}

const COLOURS = ['#1976d2', '#ef6c00', '#2e7d32', '#8e24aa', '#00897b', '#c62828', '#5d4037', '#546e7a'];
const MARK: Record<Marker['tone'], string> = { success: '#2e7d32', warning: '#ef6c00', error: '#c62828', info: '#1976d2', neutral: '#757575' };

export function formatValue(v: number, unit: Unit): string {
  if (!Number.isFinite(v)) return '—';
  switch (unit) {
    case 'percent':
      return `${v.toFixed(v < 10 ? 1 : 0)}%`;
    case 'bytes':
      return formatBytes(v);
    case 'seconds':
      return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
    case 'rate':
      return v < 10 ? v.toFixed(2) : v.toFixed(0);
    default:
      return String(Math.round(v));
  }
}

/**
 * A line chart for Prometheus series, with the fleet's own changes drawn on
 * it (node replacements, upgrades, actions): a spike and its cause side by side.
 */
export function TimeSeriesChart({ series, legend, unit, start, end, markers = [], warnAbove, height = 150 }: {
  series: Series[];
  legend: (l: Record<string, string>) => string;
  unit: Unit;
  start: number;
  end: number;
  markers?: Marker[];
  warnAbove?: number;
  height?: number;
}) {
  const W = 600;
  const H = height;
  const pad = { l: 44, r: 8, t: 10, b: 18 };
  const all = series.flatMap(s => s.points.map(p => p[1]));
  const top = Math.max(unit === 'percent' ? 100 : 0, ...all, warnAbove ?? 0) * (unit === 'percent' ? 1 : 1.1) || 1;
  const x = (t: number) => pad.l + ((t - start) / Math.max(1, end - start)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / top) * (H - pad.t - pad.b);
  const shown = series.slice(0, COLOURS.length);
  const visibleMarkers = markers.filter(m => m.time >= start && m.time <= end);
  const fmtTime = (t: number) => {
    const d = new Date(t);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (end - start > 2 * 86400e3) return date;
    return end - start > 6 * 3600e3 ? `${date} ${time}` : time;
  };
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block' }}>
        {[0, 0.5, 1].map(f => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(top * f)} y2={y(top * f)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={pad.l - 4} y={y(top * f) + 3} textAnchor="end" fontSize="9" fill="currentColor" opacity={0.6}>
              {f === 0 ? '0' : formatValue(top * f, unit)}
            </text>
          </g>
        ))}
        {warnAbove !== undefined && warnAbove < top && (
          <line x1={pad.l} x2={W - pad.r} y1={y(warnAbove)} y2={y(warnAbove)} stroke="#ef6c00" strokeDasharray="4 3" strokeOpacity={0.7}>
            <title>{`Warning above ${formatValue(warnAbove, unit)}`}</title>
          </line>
        )}
        {visibleMarkers.map((m, i) => (
          <g key={i}>
            <line x1={x(m.time)} x2={x(m.time)} y1={pad.t} y2={H - pad.b} stroke={MARK[m.tone]} strokeDasharray="3 3" strokeWidth={1.5} opacity={0.8} />
            <polygon points={`${x(m.time) - 4},${pad.t - 2} ${x(m.time) + 4},${pad.t - 2} ${x(m.time)},${pad.t + 5}`} fill={MARK[m.tone]}>
              <title>{`${new Date(m.time).toLocaleString()}: ${m.text}`}</title>
            </polygon>
          </g>
        ))}
        {shown.map((s, i) => (
          <polyline
            key={i}
            fill="none"
            stroke={COLOURS[i]}
            strokeWidth={1.6}
            points={s.points.map(p => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')}
          >
            <title>{legend(s.labels)}</title>
          </polyline>
        ))}
        <text x={pad.l} y={H - 4} fontSize="9" fill="currentColor" opacity={0.6}>
          {fmtTime(start)}
        </text>
        <text x={W - pad.r} y={H - 4} fontSize="9" fill="currentColor" opacity={0.6} textAnchor="end">
          {fmtTime(end)}
        </text>
      </svg>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25, mt: 0.5 }}>
        {shown.map((s, i) => (
          <Typography key={i} variant="caption" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
            <Box component="span" sx={{ width: 10, height: 3, bgcolor: COLOURS[i], display: 'inline-block', borderRadius: 1 }} />
            {legend(s.labels)}: <b>{formatValue(s.points[s.points.length - 1]?.[1] ?? NaN, unit)}</b>
          </Typography>
        ))}
        {series.length > shown.length && <Typography variant="caption">+{series.length - shown.length} more</Typography>}
      </Box>
    </Box>
  );
}
