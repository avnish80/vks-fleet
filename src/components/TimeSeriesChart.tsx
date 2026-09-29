import { Box, Paper, Typography, useTheme } from '@mui/material';
import React from 'react';
import { Series, Unit } from '../observability';
import { formatBytes } from '../quantity';

export interface Marker {
  time: number;
  text: string;
  tone: 'success' | 'warning' | 'error' | 'info' | 'neutral';
}

const COLOURS = ['#3b82f6', '#f59e0b', '#10b981', '#a855f7', '#06b6d4', '#ef4444', '#84cc16', '#ec4899'];
const MARK: Record<Marker['tone'], string> = { success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6', neutral: '#94a3b8' };

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
      return Number.isInteger(v) ? String(v) : v < 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v));
  }
}

/** A smooth path through the points that never overshoots them (monotone cubic, like d3's curveMonotoneX). */
export function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n < 3) return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const dx = (i: number) => pts[i + 1][0] - pts[i][0];
  const slope = (i: number) => (pts[i + 1][1] - pts[i][1]) / (dx(i) || 1);
  const m: number[] = new Array(n);
  m[0] = slope(0);
  m[n - 1] = slope(n - 2);
  for (let i = 1; i < n - 1; i++) {
    const a = slope(i - 1);
    const b = slope(i);
    m[i] = a * b <= 0 ? 0 : (3 * (dx(i - 1) + dx(i))) / ((2 * dx(i) + dx(i - 1)) / a + (dx(i) + 2 * dx(i - 1)) / b);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx(i) / 3;
    d += `C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + m[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - m[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/** "Nice" axis maximum: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find(f => f * p >= v) ?? 10) * p;
}

/**
 * A modern line chart for Prometheus series: smooth curves with soft fills,
 * a hover crosshair with every series' value, a labelled threshold, and the
 * fleet's own changes as markers you can hover.
 */
export function TimeSeriesChart({
  series,
  legend,
  unit,
  start,
  end,
  markers = [],
  warnAbove,
  height = 170,
  hoverAt,
}: {
  series: Series[];
  legend: (l: Record<string, string>) => string;
  unit: Unit;
  start: number;
  end: number;
  markers?: Marker[];
  warnAbove?: number;
  height?: number;
  /** For previews: show the crosshair at this time. */
  hoverAt?: number;
}) {
  const uid = React.useMemo(() => `ts${Math.random().toString(36).slice(2, 8)}`, []);
  const theme = useTheme();
  const paper: string = theme?.palette?.background?.paper ?? '#ffffff';
  const dark = theme?.palette?.mode === 'dark';
  const [hover, setHover] = React.useState<number | undefined>(hoverAt);
  const [markHover, setMarkHover] = React.useState<number | undefined>(undefined);
  const W = 640;
  const H = height;
  const pad = { l: 8, r: 46, t: 14, b: 22 };
  const shown = series.slice(0, COLOURS.length);
  const all = shown.flatMap(s => s.points.map(p => p[1]));
  const top = unit === 'percent' ? 100 : niceMax(Math.max(...all, warnAbove ?? 0, 0) * 1.08);
  const x = (t: number) => pad.l + ((t - start) / Math.max(1, end - start)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (Math.max(0, v) / top) * (H - pad.t - pad.b);
  const fills = shown.length <= 3;
  const ticks = [0.25, 0.5, 0.75, 1].map(f => top * f);
  const timeTicks = [0, 0.25, 0.5, 0.75, 1].map(f => start + f * (end - start));
  const long = end - start > 2 * 86400e3;
  const fmtTime = (t: number) => {
    const d = new Date(t);
    return long ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  const nearest = (s: Series, t: number) => s.points.reduce((best, p) => (Math.abs(p[0] - t) < Math.abs(best[0] - t) ? p : best), s.points[0]);
  const onMove = (e: { currentTarget: SVGSVGElement; clientX: number }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < pad.l || px > W - pad.r) return setHover(undefined);
    setHover(start + ((px - pad.l) / (W - pad.l - pad.r)) * (end - start));
  };
  const visibleMarkers = markers.filter(m => m.time >= start && m.time <= end);
  const hoverRows = hover !== undefined ? shown.map((s, i) => ({ i, name: legend(s.labels), p: s.points.length ? nearest(s, hover) : undefined })).filter(r => r.p) : [];
  const tipLeft = hover !== undefined && x(hover) > W * 0.6;

  return (
    <Box sx={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block', overflow: 'visible' }} onMouseMove={onMove} onMouseLeave={() => setHover(hoverAt)}>
        <defs>
          {shown.map((_, i) => (
            <linearGradient key={i} id={`${uid}-g${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLOURS[i]} stopOpacity={0.28} />
              <stop offset="100%" stopColor={COLOURS[i]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map(v => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="currentColor" strokeOpacity={0.07} />
            <text x={W - pad.r + 6} y={y(v) + 3} fontSize="10" fill="currentColor" opacity={0.5}>
              {formatValue(v, unit)}
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity={0.15} />
        {timeTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 6} fontSize="10" fill="currentColor" opacity={0.5} textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}>
            {fmtTime(t)}
          </text>
        ))}
        {warnAbove !== undefined && warnAbove < top && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(warnAbove)} y2={y(warnAbove)} stroke="#f59e0b" strokeDasharray="5 4" strokeOpacity={0.8} />
            <rect x={pad.l + 4} y={y(warnAbove) - 15} width={formatValue(warnAbove, unit).length * 6 + 34} height={13} rx={6.5} fill="#f59e0b" fillOpacity={0.15} />
            <text x={pad.l + 10} y={y(warnAbove) - 5.5} fontSize="9.5" fill={dark ? '#fbbf24' : '#b45309'} fontWeight={600}>
              {`warn ${formatValue(warnAbove, unit)}`}
            </text>
          </g>
        )}
        {shown.map((s, i) => {
          const pts = s.points.map(p => [x(p[0]), y(p[1])] as [number, number]);
          const line = smoothPath(pts);
          return (
            <g key={i}>
              {fills && pts.length > 1 && <path d={`${line}L${pts[pts.length - 1][0].toFixed(1)},${y(0)}L${pts[0][0].toFixed(1)},${y(0)}Z`} fill={`url(#${uid}-g${i})`} />}
              <path d={line} fill="none" stroke={COLOURS[i]} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              {pts.length === 1 && <circle cx={pts[0][0]} cy={pts[0][1]} r={4} fill={COLOURS[i]} stroke={paper} strokeWidth={1.5} />}
            </g>
          );
        })}
        {visibleMarkers.map((m, i) => (
          <g key={i} onMouseEnter={() => setMarkHover(i)} onMouseLeave={() => setMarkHover(undefined)} style={{ cursor: 'default' }}>
            <line x1={x(m.time)} x2={x(m.time)} y1={pad.t} y2={y(0)} stroke={MARK[m.tone]} strokeDasharray="2 3" strokeWidth={1.5} opacity={markHover === i ? 1 : 0.55} />
            <circle cx={x(m.time)} cy={pad.t - 2} r={markHover === i ? 6 : 4.5} fill={MARK[m.tone]} stroke={paper} strokeWidth={1.5} />
          </g>
        ))}
        {hover !== undefined && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={y(0)} stroke="currentColor" strokeOpacity={0.35} />
            {hoverRows.map(r => (
              <circle key={r.i} cx={x(r.p![0])} cy={y(r.p![1])} r={4} fill={COLOURS[r.i]} stroke={paper} strokeWidth={1.5} />
            ))}
          </g>
        )}
      </svg>
      {hover !== undefined && hoverRows.length > 0 && (
        <Paper
          elevation={6}
          sx={{
            bgcolor: 'background.paper',
            position: 'absolute',
            top: 8,
            [tipLeft ? 'right' : 'left']: `${tipLeft ? 100 - (x(hover) / W) * 100 + 2 : (x(hover) / W) * 100 + 2}%`,
            borderRadius: 1.5,
            px: 1.25,
            py: 0.75,
            pointerEvents: 'none',
            minWidth: 160,
            zIndex: 2,
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, fontSize: '0.72rem' }}>
            {new Date(hoverRows[0].p![0]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
          </Typography>
          {hoverRows
            .sort((a, b) => b.p![1] - a.p![1])
            .map(r => (
              <Box key={r.i} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, fontSize: '0.78rem', lineHeight: 1.6 }}>
                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLOURS[r.i], flexShrink: 0 }} />
                <Box sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{r.name}</Box>
                <Box sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatValue(r.p![1], unit)}</Box>
              </Box>
            ))}
        </Paper>
      )}
      {markHover !== undefined && visibleMarkers[markHover] && (
        <Box
          sx={{
            position: 'absolute',
            top: -6,
            left: `${Math.min(70, (x(visibleMarkers[markHover].time) / W) * 100)}%`,
            transform: 'translateY(-100%)',
            bgcolor: dark ? 'grey.100' : 'grey.900',
            color: dark ? 'grey.900' : 'common.white',
            borderRadius: 1,
            px: 1,
            py: 0.5,
            fontSize: '0.75rem',
            maxWidth: 320,
            pointerEvents: 'none',
            zIndex: 3,
          }}
        >
          <b>{new Date(visibleMarkers[markHover].time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b> · {visibleMarkers[markHover].text}
        </Box>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
        {shown.map((s, i) => (
          <Box
            key={i}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.6, px: 1, py: 0.25, borderRadius: 5, bgcolor: 'action.hover', fontSize: '0.75rem', maxWidth: '100%' }}
          >
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: COLOURS[i], flexShrink: 0 }} />
            <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{legend(s.labels)}</Box>
            <Box sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatValue(s.points[s.points.length - 1]?.[1] ?? NaN, unit)}</Box>
          </Box>
        ))}
        {series.length > shown.length && (
          <Typography variant="caption" color="text.secondary">
            +{series.length - shown.length} more
          </Typography>
        )}
      </Box>
    </Box>
  );
}
