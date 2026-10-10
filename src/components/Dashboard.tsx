/**
 * The fleet dashboard's own pieces: the score with its trend, and the blocks.
 * Each block is one number, one status and one line, and opens the page that
 * owns the detail.
 */
import { Box, Paper, Typography, useTheme } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { blockChange, BlockTone, DashboardBlock } from '../dashboard';
import { ScoreDriver } from '../fixes';
import { blockSeries, ScorePoint, seriesLine, SeriesPoint, sparkline, TREND_DAYS } from '../scoreHistory';
import { card, Drivers, Ring, scoreColour } from './FleetHero';

/** Simple stroke glyphs (24×24), drawn for this plugin: one per block. */
const BLOCK_GLYPHS: Record<DashboardBlock['id'], string> = {
  clusters: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  supervisor: 'M3 12h4l2-6 4 12 2-6h6',
  capacity: 'M4 16a8 8 0 1 1 16 0 M12 16l4-5 M4 20h16',
  next30: 'M5 5h14v15H5z M5 10h14 M9 3v4 M15 3v4',
  lifecycle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16V8 M8.5 11.5L12 8l3.5 3.5',
  security: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z',
  governance: 'M9 4h6v3H9z M7 5H5v15h14V5h-2 M9 13l2 2 4-4',
  network: 'M12 3v6 M5 21v-4h14v4 M12 9v8 M9 3h6v6H9z',
};

function useBlockColour(): (t: BlockTone) => string {
  const theme: any = useTheme();
  const p = theme.palette ?? {};
  return (t: BlockTone) => (t === 'bad' ? p.error?.main ?? '#d32f2f' : t === 'warn' ? p.warning?.main ?? '#ed6c02' : t === 'ok' ? p.success?.main ?? '#2e7d32' : p.text?.disabled ?? '#9e9e9e');
}

const TONE_WORD: Record<BlockTone, string> = { bad: 'Needs action', warn: 'Worth a look', ok: 'Fine', none: 'No status' };

/**
 * A block's own trend: its figure over the last 30 days, and how it moved since
 * the last visit. The line is neutral; only the change is coloured, and it is
 * also an arrow and words, never colour alone.
 */
function BlockTrend({ block, series, today }: { block: DashboardBlock; series: SeriesPoint[]; today: string }) {
  const colour = useBlockColour();
  const change = blockChange(block, series, today);
  const w = 72;
  const h = 26;
  const { line, last } = series.length >= 2 ? seriesLine(series, today, w, h, TREND_DAYS, block.unit === '%' || /Pct$|^network$|^supervisor$/.test(block.metric ?? '') ? 10 : 4, 3) : { line: '', last: undefined };
  if (!line && !change) return null;
  const tone = change?.verdict === 'better' ? colour('ok') : change?.verdict === 'worse' ? colour('bad') : undefined;
  return (
    <Box title={change ? `${change.text}. Trend over ${series.length} days, kept in this browser.` : `Trend over ${series.length} days, kept in this browser.`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, ml: 'auto', flexShrink: 0, color: 'text.secondary' }}>
      {change && change.delta !== 0 && (
        <Typography component="span" aria-label={change.text} sx={{ fontSize: '0.8rem', fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: tone ?? 'text.secondary' }}>
          {change.delta > 0 ? '▲' : '▼'} {Math.abs(change.delta)}
        </Typography>
      )}
      {line && (
        <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" style={{ display: 'block' }}>
          <polyline points={line} fill="none" stroke="currentColor" strokeOpacity={0.55} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {last && <circle cx={last.x} cy={last.y} r={2.5} fill={tone ?? 'currentColor'} />}
        </svg>
      )}
    </Box>
  );
}

function Block({ block, series, today }: { block: DashboardBlock; series: SeriesPoint[]; today: string }) {
  const colour = useBlockColour();
  return (
    <Box
      component={Link}
      to={block.path}
      title={`${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ''}. ${block.reason}. Click to open.`}
      sx={{
        p: 1.5,
        borderRadius: 3,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        minWidth: 0,
        color: 'text.primary',
        textDecoration: 'none',
        transition: 'box-shadow 150ms, border-color 150ms',
        '&:hover': { boxShadow: 3, borderColor: 'text.secondary' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: 'text.secondary' }}>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d={BLOCK_GLYPHS[block.id]} />
        </svg>
        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1 }} noWrap>
          {block.label}
        </Typography>
        <Box component="span" aria-hidden="true" sx={{ fontSize: '1rem', lineHeight: 1, opacity: 0.6 }}>
          ›
        </Box>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
          <Typography sx={{ fontSize: '1.7rem', fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{block.value}</Typography>
          {block.unit && (
            <Typography variant="body2" color="text.secondary" noWrap>
              {block.unit}
            </Typography>
          )}
        </Box>
        <BlockTrend block={block} series={series} today={today} />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
        <Box role="img" aria-label={TONE_WORD[block.tone]} sx={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, bgcolor: block.tone === 'none' ? 'transparent' : colour(block.tone), border: '1.5px solid', borderColor: colour(block.tone) }} />
        <Typography variant="body2" color="text.secondary" noWrap>
          {block.reason}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * The blocks: four across on a wide screen, two on a narrow one. `history`:
 * this browser's daily points, from which each block draws its own trend.
 */
export function BlockGrid({ blocks, history = [], today = '' }: { blocks: DashboardBlock[]; history?: ScorePoint[]; today?: string }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }, gap: 1.5 }}>
      {blocks.map(b => (
        <Block key={b.id} block={b} series={today ? blockSeries(history, b.metric) : []} today={today} />
      ))}
    </Box>
  );
}

/** The score over the last 30 days, from what this browser has recorded. */
function Trend({ points, today, score }: { points: ScorePoint[]; today: string; score?: number }) {
  const w = 170;
  const h = 44;
  if (points.length < 2) {
    return (
      <Box sx={{ textAlign: 'right', maxWidth: 190 }}>
        <Typography variant="body2" color="text.secondary">
          Trend starts today
        </Typography>
        <Typography variant="caption" color="text.secondary">
          One point a day, kept in this browser.
        </Typography>
      </Box>
    );
  }
  const { line, last } = sparkline(points, today, w, h);
  const first = points[0];
  const colour = scoreColour(score);
  return (
    <Box sx={{ textAlign: 'right' }}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`Fleet score over ${points.length} days: from ${first.s} to ${points[points.length - 1].s}`} style={{ display: 'block' }}>
        <polyline points={line} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {last && <circle cx={last.x} cy={last.y} r={3.5} fill={colour} />}
      </svg>
      <Typography variant="caption" color="text.secondary" title="One point a day, kept in this browser only. Another browser starts its own history.">
        {points.length >= TREND_DAYS ? `${TREND_DAYS}-day trend` : `Trend over ${points.length} days`} · from {first.s}
      </Typography>
    </Box>
  );
}

/**
 * The top of the dashboard: the fleet score, the fleet in one sentence, and
 * the trend. The score opens what holds it down.
 */
export function ScoreHeader({
  score,
  headline,
  line,
  points,
  today,
  drivers,
  clusterLinks,
}: {
  score?: number;
  headline: string;
  line: string;
  /** The trend's points, oldest first. */
  points: ScorePoint[];
  today: string;
  drivers: ScoreDriver[];
  /** Name and checks page of each cluster, by key, for the links behind a score reason. */
  clusterLinks: Map<string, { name: string; path: string }>;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Paper variant="outlined" sx={{ ...card, gap: 1.5 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 2.5, rowGap: 1 }}>
        <Box
          component="button"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title="The average best-practice score of the clusters. Click for what holds it down."
          sx={{ p: 0, m: 0, border: 0, bgcolor: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', display: 'flex', borderRadius: '50%', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 } }}
        >
          <Ring score={score} size={84} caption={false} />
        </Box>
        <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
          <Typography sx={{ fontSize: '1.25rem', fontWeight: 800, lineHeight: 1.3 }}>{headline}</Typography>
          <Typography variant="body2" color="text.secondary">
            {line}{' '}
            {drivers.length > 0 && (
              <Box component="button" type="button" onClick={() => setOpen(!open)} sx={{ p: 0, border: 0, bgcolor: 'transparent', color: 'primary.main', font: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}>
                {open ? 'Hide the breakdown' : 'What holds the score down'}
              </Box>
            )}
          </Typography>
        </Box>
        <Trend points={points} today={today} score={score} />
      </Box>
      {open && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          <Drivers drivers={drivers} simulate={false} clusterLinks={clusterLinks} />
        </Box>
      )}
    </Paper>
  );
}
