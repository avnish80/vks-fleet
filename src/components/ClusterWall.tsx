/**
 * The cluster wall: every cluster as one tile, grouped by org, coloured by its
 * worst open issue. The fleet itself is the picture; a tile opens its cluster.
 */
import { alpha, Box, Typography, useTheme } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { KUBERNETES_ICON } from '../assets/kubernetesIcon';
import { TileIcon, TileState, WallTile } from '../fixes';

/** Simple stroke glyphs (24×24), drawn for this plugin. */
const GLYPHS: Record<TileIcon, string> = {
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6z M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  memory: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  network: 'M12 3v6 M5 21v-4h14v4 M12 9v8 M9 3h6v6H9z M2 21h6 M16 21h6',
  node: 'M4 5h16v6H4z M4 13h16v6H4z M8 8h.01 M8 16h.01',
  certificate: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z M9 12l2 2 4-4',
  lifecycle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16V8 M8.5 11.5L12 8l3.5 3.5',
  security: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  alert: 'M12 4l9 16H3L12 4z M12 10v4 M12 17h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l3 3 5-6',
};

export function Glyph({ icon, size = 20 }: { icon: TileIcon; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d={GLYPHS[icon]} />
    </svg>
  );
}

/** The plugin's own mark: a small wall of tiles. */
export function FleetMark({ size = 40 }: { size?: number }) {
  const theme: any = useTheme();
  const main = theme.palette?.primary?.main ?? '#0E4F66';
  const on = theme.palette?.primary?.contrastText ?? '#ffffff';
  const warn = theme.palette?.warning?.main ?? '#f59e0b';
  const cells = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => ({ r, c })));
  return (
    <svg viewBox="0 0 52 52" width={size} height={size} role="img" aria-label="vks-fleet" style={{ flexShrink: 0 }}>
      <rect width={52} height={52} rx={12} fill={main} />
      {cells.map(({ r, c }) => (
        <rect key={`${r}${c}`} x={10 + c * 12} y={10 + r * 12} width={8} height={8} rx={2} fill={r === 1 && c === 1 ? warn : on} fillOpacity={(r === 0 && c === 2) || (r === 2 && c === 0) ? 0.55 : 1} />
      ))}
    </svg>
  );
}

/** The Kubernetes icon on a neutral disc, so it reads on any tile colour. */
export function KubernetesIcon({ size = 18 }: { size?: number }) {
  return (
    <Box sx={{ width: size + 6, height: size + 6, borderRadius: '50%', bgcolor: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <img src={KUBERNETES_ICON} alt="" width={size} height={size} />
    </Box>
  );
}

export function useTileLook(): (s: TileState) => { bg: string; border: string; fg: string; sub: string; dashed?: boolean } {
  const theme: any = useTheme();
  const p = theme.palette ?? {};
  const text = p.text?.primary ?? '#111827';
  const muted = p.text?.secondary ?? '#6b7280';
  return (s: TileState) => {
    if (s === 'critical') return { bg: p.error?.main ?? '#d32f2f', border: p.error?.main ?? '#d32f2f', fg: p.error?.contrastText ?? '#ffffff', sub: p.error?.contrastText ?? '#ffffff' };
    if (s === 'warning') return { bg: alpha(p.warning?.main ?? '#ed6c02', 0.16), border: p.warning?.main ?? '#ed6c02', fg: text, sub: text };
    if (s === 'advisory') return { bg: 'transparent', border: p.warning?.main ?? '#ed6c02', fg: text, sub: muted, dashed: true };
    if (s === 'fixed') return { bg: alpha(p.info?.main ?? '#0288d1', 0.14), border: p.info?.main ?? '#0288d1', fg: text, sub: text };
    return { bg: 'transparent', border: p.divider ?? 'rgba(0,0,0,0.12)', fg: muted, sub: muted };
  };
}

const LEGEND: Array<{ state: TileState; label: string }> = [
  { state: 'critical', label: 'Critical' },
  { state: 'warning', label: 'Needs attention' },
  { state: 'advisory', label: 'Advisory only' },
  { state: 'fixed', label: 'Fixed in simulation' },
  { state: 'healthy', label: 'Healthy' },
];

function Tile({ tile }: { tile: WallTile }) {
  const look = useTileLook()(tile.state);
  return (
    <Box
      component={Link}
      to={tile.path}
      title={`${tile.fullName}: ${tile.line1}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        minHeight: 112,
        p: 1.5,
        borderRadius: 2,
        border: look.dashed ? '1.5px dashed' : '1.5px solid',
        borderColor: look.border,
        bgcolor: look.bg,
        color: look.fg,
        textDecoration: 'none',
        transition: 'background-color 240ms ease, border-color 240ms ease, color 240ms ease',
        '&:hover': { boxShadow: 3 },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <KubernetesIcon />
        <Typography sx={{ flex: 1, minWidth: 0, fontFamily: 'monospace', fontSize: '0.85rem', fontWeight: 700, lineHeight: 1.2, wordBreak: 'break-all', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{tile.name}</Typography>
        <Glyph icon={tile.icon} />
      </Box>
      <Typography sx={{ fontSize: '0.9rem', fontWeight: 600, lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{tile.line1}</Typography>
      <Typography sx={{ mt: 'auto', fontSize: '0.78rem', lineHeight: 1.3, color: look.sub }}>
        {tile.line2}
        {tile.more > 0 ? ` · ${tile.more} more` : ''}
      </Typography>
    </Box>
  );
}

export function ClusterWall({ tiles, simulate }: { tiles: WallTile[]; simulate: boolean }) {
  const look = useTileLook();
  const groups = new Map<string, WallTile[]>();
  for (const t of tiles) groups.set(t.tenantId, [...(groups.get(t.tenantId) ?? []), t]);
  const rank: Record<TileState, number> = { critical: 0, warning: 1, advisory: 2, fixed: 3, healthy: 4 };
  const ordered = Array.from(groups.values()).sort((a, b) => a[0].tenantName.localeCompare(b[0].tenantName));
  // Many clusters: smaller tiles, so the whole fleet still fits one screen.
  const min = tiles.length > 36 ? 132 : 168;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography sx={{ fontWeight: 800 }}>Clusters</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
          {LEGEND.filter(l => l.state !== 'fixed' || simulate).map(l => (
            <Box key={l.state} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Box sx={{ width: 12, height: 12, borderRadius: '3px', border: look(l.state).dashed ? '1px dashed' : '1px solid', borderColor: look(l.state).border, bgcolor: look(l.state).bg }} />
              <Typography variant="caption" color="text.secondary">
                {l.label}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
      {ordered.map(group => (
        <Box key={group[0].tenantId} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {ordered.length > 1 && (
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
              <Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{group[0].tenantName}</Typography>
              <Typography variant="caption" color="text.secondary">
                {group.length} cluster{group.length === 1 ? '' : 's'}
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 1.5 }}>
            {group
              .slice()
              .sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
              .map(t => (
                <Tile key={t.key} tile={t} />
              ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
