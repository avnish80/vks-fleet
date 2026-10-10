import { Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { FixProposal, ScoreDriver } from '../fixes';
import { IssueRecommendation, TriageCounts } from '../recommendations';
import { HORIZON_DAYS, HorizonItem, inWords, NowItem } from '../fleetHero';

const TONE = { error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' } as const;
const SEV = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' } as const;
export const scoreColour = (s?: number) => (s === undefined ? '#94a3b8' : s >= 90 ? '#10b981' : s >= 70 ? '#f59e0b' : '#ef4444');

/** The fleet score as a ring. */
export function Ring({ score, size = 120, caption = true }: { score?: number; size?: number; caption?: boolean }) {
  const r = 46;
  const len = 2 * Math.PI * r;
  const pct = score === undefined ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} role="img" aria-label={`Fleet score ${score ?? 'unknown'}`}>
      <circle cx={60} cy={60} r={r} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={11} />
      <circle cx={60} cy={60} r={r} fill="none" stroke={scoreColour(score)} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${len * pct} ${len}`} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray 600ms ease, stroke 600ms ease' }} />
      <text x={60} y={60} textAnchor="middle" dominantBaseline="central" fontSize={caption ? 30 : 36} fontWeight={800} fill="currentColor">
        {score ?? '—'}
      </text>
      {caption && (
        <text x={60} y={86} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>
          fleet score
        </text>
      )}
    </svg>
  );
}

export const card = { p: 2, borderRadius: 3, display: 'flex', flexDirection: 'column' as const };

/** What holds the score down: one bar per check, sized by the points it costs. A row opens the clusters behind it. */
export function Drivers({ drivers, simulate, clusterLinks }: { drivers: ScoreDriver[]; simulate: boolean; clusterLinks: Map<string, { name: string; path: string }> }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [all, setAll] = React.useState(false);
  const shown = all ? drivers : drivers.slice(0, 5);
  const max = Math.max(...drivers.map(d => d.points), 1);
  if (!drivers.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        Every best-practice check that could run is passing.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 0.25 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, mb: 0.5 }}>
        What holds the score down (click one for the clusters behind it)
      </Typography>
      {shown.map(d => {
        const gone = simulate && !!d.fix;
        const isOpen = open === d.id;
        const links = d.clusterKeys.map(k => clusterLinks.get(k)).filter((x): x is { name: string; path: string } => !!x);
        return (
          <Box key={d.id}>
            <Box
              component="button"
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : d.id)}
              title={`Not passing in ${d.clusters} cluster${d.clusters === 1 ? '' : 's'}${d.fix ? `. Fix: ${d.fix}` : ''}`}
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(120px, 270px) minmax(60px, 1fr) 52px',
                gap: 1.5,
                alignItems: 'center',
                width: '100%',
                p: 0.5,
                m: 0,
                border: 0,
                borderRadius: 1,
                bgcolor: isOpen ? 'action.hover' : 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: gone ? 'text.secondary' : 'text.primary', textDecoration: gone ? 'line-through' : 'underline', textDecorationStyle: gone ? 'solid' : 'dotted', textUnderlineOffset: '3px' }}>
                {d.title}
              </Typography>
              <Box sx={{ height: 10 }}>
                <Box sx={{ height: 10, width: `${Math.max(6, (d.points / max) * 100)}%`, borderRadius: '3px', border: '1px solid', borderColor: gone ? 'info.main' : 'warning.main', bgcolor: gone ? 'transparent' : 'warning.main', transition: 'background-color 240ms ease' }} />
              </Box>
              <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 700, color: gone ? 'info.main' : 'text.primary', textAlign: 'right' }}>
                {gone ? 'fixed' : `−${d.points}`}
              </Typography>
            </Box>
            {isOpen && (
              <Box sx={{ px: 0.5, pt: 0.5, pb: 1, display: 'grid', gap: 0.5 }}>
                <Typography variant="body2" color="text.secondary">
                  Not passing in {d.clusters} cluster{d.clusters === 1 ? '' : 's'}. Each link opens that cluster's checks, with how to fix it.
                </Typography>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.5 }}>
                  {links.map(l => (
                    <Typography key={l.path} variant="body2" component={Link} to={l.path} sx={{ fontWeight: 700 }}>
                      {l.name}
                    </Typography>
                  ))}
                </Box>
                {d.fix && (
                  <Typography variant="body2">
                    <Box component="span" sx={{ fontWeight: 700 }}>
                      Fix ready:{' '}
                    </Box>
                    {d.fix}
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        );
      })}
      {drivers.length > 5 && (
        <Box>
          <Button size="small" onClick={() => setAll(!all)} sx={{ px: 0.5 }}>
            {all ? 'Show the top 5' : `Show all ${drivers.length} (${drivers.length - 5} smaller ones)`}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export function FixChip({ text, tone }: { text: string; tone: 'ready' | 'fixed' | 'decision' }) {
  const colour = tone === 'fixed' ? 'info.main' : tone === 'ready' ? 'text.primary' : 'warning.main';
  return (
    <Box component="span" sx={{ px: 1, py: '1px', borderRadius: 5, border: '1px solid', borderColor: colour, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', color: tone === 'fixed' ? 'info.main' : 'text.primary' }}>
      {text}
    </Box>
  );
}

/** What needs you now: one line per item, with the action that fits it (the fix, Investigate, or the page). */
export function NowList({
  items,
  fixByIssue = new Map(),
  recByIssue = new Map(),
  simulate = false,
  lines = 2,
}: {
  items: NowItem[];
  /** The fix the plugin has, by issue id. */
  fixByIssue?: Map<string, FixProposal>;
  /** The recommended step for issues without a fix, by issue id. */
  recByIssue?: Map<string, IssueRecommendation>;
  simulate?: boolean;
  /** Lines a title may take before it is cut. */
  lines?: number;
}) {
  if (!items.length) {
    return (
      <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
        Nothing needs you right now.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid' }}>
      {items.map((i, k) => {
        const fix = fixByIssue.get(i.id);
        const rec = fix ? undefined : recByIssue.get(i.id);
        const fixed = simulate && !!fix;
        return (
          <Box key={i.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', py: 0.75, borderTop: k ? 1 : 0, borderColor: 'divider' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: fixed ? TONE.info : SEV[i.severity], mt: 0.6, flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.25, alignItems: 'baseline' }}>
              <Typography variant="body2" title={i.title} sx={{ fontWeight: 700, display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden', textDecoration: fixed ? 'line-through' : 'none', color: fixed ? 'text.secondary' : 'text.primary' }}>
                {i.title}
              </Typography>
              {i.sub && (
                <Typography variant="caption" color="text.secondary">
                  {i.sub}
                </Typography>
              )}
              {fixed ? <FixChip text="Fixed in simulation" tone="fixed" /> : fix ? <FixChip text="Fix ready" tone="ready" /> : rec ? <FixChip text="Recommended" tone="ready" /> : null}
            </Box>
            {fix && !fixed ? (
              <Button size="small" component={Link} to={fix.path} title={fix.label} sx={{ py: 0, flexShrink: 0 }}>
                Fix…
              </Button>
            ) : rec ? (
              <Button size="small" component={Link} to={rec.path} title={rec.why} sx={{ py: 0, flexShrink: 0 }}>
                {rec.label}
              </Button>
            ) : i.investigate ? (
              <Button size="small" component={Link} to={`/vks-fleet/investigate?cluster=${encodeURIComponent(i.investigate.clusterKey)}${i.investigate.node ? `&node=${encodeURIComponent(i.investigate.node)}` : ''}`} sx={{ py: 0, flexShrink: 0 }}>
                Investigate
              </Button>
            ) : i.path ? (
              <Button size="small" component={Link} to={i.path} sx={{ py: 0, flexShrink: 0 }}>
                Open
              </Button>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** The next 30 days as a line: a dot for each thing that expires or runs out. */
export function HorizonTimeline({ horizon, now = Date.now() }: { horizon: HorizonItem[]; now?: number }) {
  const days = HORIZON_DAYS;
  const x = (t: number) => 14 + Math.max(0, Math.min(1, (t - now) / (days * 86400e3))) * 572;
  // Stagger dots that would overlap.
  const placed: Array<{ item: HorizonItem; cx: number; row: number }> = [];
  for (const item of horizon) {
    const cx = x(item.at);
    let row = 0;
    while (placed.some(p => p.row === row && Math.abs(p.cx - cx) < 18)) row += 1;
    placed.push({ item, cx, row: Math.min(row, 2) });
  }
  return (
    <>
      <Typography sx={{ fontWeight: 800, mb: 0.5 }}>Next {days} days</Typography>
      <svg viewBox="0 0 600 68" width="100%" role="img" aria-label="What expires or runs out in the next 30 days" style={{ display: 'block', overflow: 'visible', maxWidth: 760 }}>
        <line x1={14} x2={586} y1={46} y2={46} stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
        {[0, 7, 14, 21, 28].map(d => (
          <g key={d}>
            <line x1={x(now + d * 86400e3)} x2={x(now + d * 86400e3)} y1={42} y2={50} stroke="currentColor" strokeOpacity={0.3} />
            <text x={x(now + d * 86400e3)} y={64} fontSize={13} textAnchor={d === 0 ? 'start' : 'middle'} fill="currentColor" opacity={0.6}>
              {d === 0 ? 'today' : `${d / 7} wk`}
            </text>
          </g>
        ))}
        {placed.map(({ item, cx, row }, k) => (
          <g key={k}>
            <line x1={cx} x2={cx} y1={46} y2={34 - row * 12} stroke={TONE[item.tone]} strokeOpacity={0.5} />
            <circle cx={cx} cy={30 - row * 12} r={8} fill={TONE[item.tone]} stroke="white" strokeOpacity={0.8} strokeWidth={2}>
              <title>{`${inWords(item.at, now)}: ${item.text}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      {horizon.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Nothing expires or runs out in the next {days} days, as far as the fleet can see.
        </Typography>
      )}
      {horizon.length > 0 && (
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5 }}>
          {horizon.slice(0, 8).map((h, k) => (
            <li key={k}>
              <Typography variant="body2">
                <Box component="span" sx={{ fontWeight: 700, color: TONE[h.tone] }}>
                  {inWords(h.at, now)}
                </Box>
                {': '}
                {h.path ? <Link to={h.path}>{h.text}</Link> : h.text}
              </Typography>
            </li>
          ))}
          {horizon.length > 8 && (
            <li>
              <Typography variant="body2" color="text.secondary">
                and {horizon.length - 8} more: hover a dot for what it is.
              </Typography>
            </li>
          )}
        </Box>
      )}
    </>
  );
}

/** As it is; with the fixes the plugin has; with the recommended steps done as well. */
export type SimulateMode = 'off' | 'fixes' | 'recommended';

const MODES: Array<{ mode: SimulateMode; label: string }> = [
  { mode: 'off', label: 'As it is' },
  { mode: 'fixes', label: 'With fixes' },
  { mode: 'recommended', label: 'With fixes and recommendations' },
];

/**
 * Simulate: the fleet as it is, with the fixes the plugin has, or with the
 * recommended steps done as well, and the score for each. It only redraws the
 * page: nothing is sent anywhere.
 */
export function SimulatePanel({
  counts,
  mode,
  score,
  fixedScore,
  recommendedScore,
  onMode,
}: {
  counts: TriageCounts;
  mode: SimulateMode;
  /** The fleet score as it is. */
  score?: number;
  /** With every fixable check passing. */
  fixedScore?: number;
  /** With the recommended steps done as well (upgrades and class changes are not counted). */
  recommendedScore?: number;
  onMode: (mode: SimulateMode) => void;
}) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const left = mode === 'recommended' ? counts.decision : counts.open - counts.fixable;
  const sentence = !counts.open
    ? 'No open issues need action.'
    : mode === 'off'
    ? `Of ${plural(counts.open, 'open issue', 'open issues')}: ${counts.fixable} with a fix ready, ${counts.recommended} with a recommended step, ${counts.decision} that need${counts.decision === 1 ? 's' : ''} a decision. Pick a view to see the fleet with them done; nothing is changed.`
    : mode === 'fixes'
    ? `${plural(counts.fixable, 'fix', 'fixes')} simulated. ${left ? `${plural(left, 'issue is', 'issues are')} left.` : 'Nothing would be left.'} Nothing has been changed.`
    : `${plural(counts.fixable, 'fix', 'fixes')} and the recommended steps simulated (upgrades are not counted: each is its own project). ${left ? `${plural(left, 'issue needs', 'issues need')} a decision.` : 'Nothing would be left.'} Nothing has been changed.`;
  const after = mode === 'recommended' ? recommendedScore : fixedScore;
  const moved = mode !== 'off' && score !== undefined && after !== undefined;
  return (
    <Paper variant="outlined" sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, rowGap: 1 }}>
      <Box>
        <Typography sx={{ fontWeight: 800, mb: 0.5 }}>Simulate</Typography>
        <Box role="group" aria-label="Simulate" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {MODES.map(m => (
            <Button
              key={m.mode}
              size="small"
              variant={mode === m.mode ? 'contained' : 'outlined'}
              aria-pressed={mode === m.mode}
              disabled={m.mode === 'fixes' ? !counts.fixable : m.mode === 'recommended' ? !counts.fixable && !counts.recommended : false}
              onClick={() => onMode(m.mode)}
              sx={{ textTransform: 'none' }}
            >
              {m.label}
            </Button>
          ))}
        </Box>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ flex: '1 1 320px' }}>
        {sentence}
      </Typography>
      {moved && (
        <Typography sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>
          Fleet score{' '}
          <Box component="span" sx={{ color: scoreColour(score) }}>
            {score}
          </Box>
          {' → '}
          <Box component="span" sx={{ color: scoreColour(after) }}>
            {after}
          </Box>
        </Typography>
      )}
    </Paper>
  );
}
