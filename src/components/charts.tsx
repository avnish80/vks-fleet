/**
 * Small chart primitives drawn with SVG and CSS, coloured from the host
 * Headlamp theme so they follow light and dark mode. No chart library, so
 * nothing extra to load or break between Headlamp releases.
 */
import { Box, Paper, Typography, useTheme } from '@mui/material';
import React, { ReactNode } from 'react';

/** One-time keyframes for the grow-in animations; honours reduced motion. */
export function ChartStyles() {
  return (
    <style>{`
      @keyframes vksfleet-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
      @keyframes vksfleet-fade { from { opacity: 0; } to { opacity: 1; } }
      .vksfleet-bar { transform-origin: left center; animation: vksfleet-grow 700ms cubic-bezier(.2,.8,.2,1) both; }
      .vksfleet-fade { animation: vksfleet-fade 600ms ease-out both; }
      @keyframes vksfleet-flash { 0%, 45% { box-shadow: 0 0 0 3px rgba(255, 167, 38, 0.95); } 100% { box-shadow: 0 0 0 3px rgba(255, 167, 38, 0); } }
      .vksfleet-flash { animation: vksfleet-flash 2.4s ease-out; border-radius: 8px; }
      @media (prefers-reduced-motion: reduce) { .vksfleet-bar, .vksfleet-fade, .vksfleet-flash { animation: none; } }
    `}</style>
  );
}

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'primary' | 'neutral';

export function useTone(): (t: Tone) => string {
  const theme: any = useTheme();
  return (t: Tone) => {
    if (t === 'neutral') return theme.palette?.text?.disabled ?? '#9e9e9e';
    return theme.palette?.[t]?.main ?? '#607d8b';
  };
}

export function ChartCard({
  title,
  caption,
  children,
  minHeight = 220,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
  minHeight?: number;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, minHeight, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
          {title}
        </Typography>
        {caption && (
          <Typography variant="body2" color="text.secondary">
            {caption}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>{children}</Box>
    </Paper>
  );
}

export function EmptyChart({ text }: { text: string }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
      {text}
    </Typography>
  );
}

/** Headline number with an accent edge and an optional thin meter. */
export function KpiTile({
  label,
  value,
  sub,
  tone = 'primary',
  meter,
  onClick,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  meter?: { value: number; max: number; tone?: Tone };
  /** Makes the tile a button that leads to the data behind it. */
  onClick?: () => void;
  /** Tooltip saying where a click goes. */
  hint?: string;
}) {
  const color = useTone();
  const ratio = meter && meter.max > 0 ? Math.min(1, meter.value / meter.max) : 0;
  return (
    <Paper
      variant="outlined"
      onClick={onClick}
      title={hint}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e: any) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      sx={{
        p: 2,
        pl: 2.5,
        borderRadius: 2,
        position: 'relative',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 150ms, transform 150ms',
        '&:hover': onClick ? { boxShadow: 3, transform: 'translateY(-1px)' } : undefined,
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          backgroundColor: color(tone),
        },
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontSize: '2rem', fontWeight: 600, lineHeight: 1.15, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          {sub}
        </Typography>
      )}
      {meter && (
        <Box sx={{ mt: 1.25, height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
          <Box
            className="vksfleet-bar"
            sx={{ height: '100%', width: `${ratio * 100}%`, borderRadius: 3, bgcolor: color(meter.tone ?? tone) }}
          />
        </Box>
      )}
    </Paper>
  );
}

export interface Slice {
  label: string;
  value: number;
  tone: Tone;
}

/** Donut with a centre total and a legend. */
export function Donut({
  slices,
  centre,
  centreSub,
  onSelect,
}: {
  slices: Slice[];
  centre: ReactNode;
  centreSub: string;
  /** Called with the slice clicked (arc or legend). */
  onSelect?: (slice: Slice) => void;
}) {
  const color = useTone();
  const size = 156;
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = slices.reduce((n, s) => n + s.value, 0);
  const gap = slices.length > 1 ? 3 : 0;
  let offset = 0;
  const summary = slices.map(s => `${s.value} ${s.label}`).join(', ');
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', justifyContent: 'center' }}>
      <Box sx={{ position: 'relative', width: size, height: size }} className="vksfleet-fade">
        <svg width={size} height={size} role="img" aria-label={summary}>
          <title>{summary}</title>
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.08} strokeWidth={stroke} />
            {total > 0 &&
              slices.map(s => {
                const len = (s.value / total) * c;
                const dash = Math.max(len - gap, 0.5);
                const el = (
                  <circle
                    key={s.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={color(s.tone)}
                    strokeWidth={stroke}
                    strokeDasharray={`${dash} ${c - dash}`}
                    strokeDashoffset={-offset}
                    style={{ cursor: onSelect ? 'pointer' : 'default' }}
                    onClick={onSelect ? () => onSelect(s) : undefined}
                  >
                    <title>{`${s.label}: ${s.value}`}</title>
                  </circle>
                );
                offset += len;
                return el;
              })}
          </g>
        </svg>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Typography sx={{ fontSize: '1.9rem', fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {centre}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {centreSub}
          </Typography>
        </Box>
      </Box>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {slices.map(s => (
          <Box
            component="li"
            key={s.label}
            onClick={onSelect ? () => onSelect(s) : undefined}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              cursor: onSelect ? 'pointer' : 'default',
              borderRadius: 1,
              px: 0.5,
              mx: -0.5,
              '&:hover': onSelect ? { bgcolor: 'action.hover' } : undefined,
            }}
          >
            <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: color(s.tone), flexShrink: 0 }} />
            <Typography variant="body2" sx={{ minWidth: 92 }}>
              {s.label}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {s.value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export interface BarPart {
  value: number;
  tone: Tone;
  label: string;
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** Either one value, or stacked parts. */
  parts: BarPart[];
  valueText: ReactNode;
  title?: string;
  onClick?: () => void;
}

/** Horizontal bars, single or stacked, scaled to the largest row (or `max`). */
export function BarList({ rows, max }: { rows: BarRow[]; max?: number }) {
  const color = useTone();
  const top = max ?? Math.max(1, ...rows.map(r => r.parts.reduce((n, p) => n + p.value, 0)));
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {rows.map((r, i) => {
        const total = r.parts.reduce((n, p) => n + p.value, 0);
        return (
          <Box
            key={r.key}
            onClick={r.onClick}
            title={r.title ?? r.parts.map(p => `${p.label}: ${p.value}`).join(', ')}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(90px, 34%) 1fr auto',
              alignItems: 'center',
              columnGap: 1.5,
              cursor: r.onClick ? 'pointer' : 'default',
              borderRadius: 1,
              px: 0.5,
              mx: -0.5,
              '&:hover': r.onClick ? { bgcolor: 'action.hover' } : undefined,
            }}
          >
            <Typography variant="body2" noWrap>
              {r.label}
            </Typography>
            <Box sx={{ height: 12, borderRadius: 6, bgcolor: 'action.hover', overflow: 'hidden', display: 'flex' }}>
              <Box
                className="vksfleet-bar"
                sx={{ display: 'flex', width: `${Math.min(100, (total / top) * 100)}%`, animationDelay: `${i * 60}ms` }}
              >
                {r.parts
                  .filter(p => p.value > 0)
                  .map((p, j, arr) => (
                    <Box
                      key={p.label}
                      sx={{
                        flexGrow: p.value,
                        flexBasis: 0,
                        bgcolor: color(p.tone),
                        borderRight: j < arr.length - 1 ? '2px solid' : 'none',
                        borderColor: 'background.paper',
                      }}
                    />
                  ))}
              </Box>
            </Box>
            <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
              {r.valueText}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/** Legend for stacked bars. */
export function Legend({ items }: { items: Array<{ label: string; tone: Tone }> }) {
  const color = useTone();
  return (
    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {items.map(i => (
        <Box key={i.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: color(i.tone) }} />
          <Typography variant="caption" color="text.secondary">
            {i.label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
