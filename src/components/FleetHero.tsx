import { Box, Button, FormControlLabel, Paper, Switch, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { FixCounts, FixProposal, ScoreDriver, WallTile } from '../fixes';
import { Glance, HORIZON_DAYS, HorizonItem, inWords, NowItem } from '../fleetHero';
import { ClusterWall, FleetMark } from './ClusterWall';

const TONE = { error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' } as const;
const SEV = { critical: '#ef4444', warning: '#f59e0b', info: '#3b82f6' } as const;
const scoreColour = (s?: number) => (s === undefined ? '#94a3b8' : s >= 90 ? '#10b981' : s >= 70 ? '#f59e0b' : '#ef4444');

function Ring({ score }: { score?: number }) {
  const r = 46;
  const len = 2 * Math.PI * r;
  const pct = score === undefined ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg viewBox="0 0 120 120" width={120} height={120} role="img" aria-label={`Fleet health ${score ?? 'unknown'}`}>
      <circle cx={60} cy={60} r={r} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth={11} />
      <circle cx={60} cy={60} r={r} fill="none" stroke={scoreColour(score)} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${len * pct} ${len}`} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray 600ms ease, stroke 600ms ease' }} />
      <text x={60} y={60} textAnchor="middle" dominantBaseline="central" fontSize={30} fontWeight={800} fill="currentColor">
        {score ?? '—'}
      </text>
      <text x={60} y={86} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>
        fleet score
      </text>
    </svg>
  );
}

const card = { p: 2, borderRadius: 3, display: 'flex', flexDirection: 'column' as const };

/** What holds the score down: one bar per check, sized by the points it costs. */
function Drivers({ drivers, simulate }: { drivers: ScoreDriver[]; simulate: boolean }) {
  const shown = drivers.slice(0, 5);
  const max = Math.max(...shown.map(d => d.points), 1);
  if (!shown.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        Every best-practice check that could run is passing.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 0.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
        What holds the score down
      </Typography>
      {shown.map(d => {
        const gone = simulate && !!d.fix;
        return (
          <Box key={d.id} title={`${d.clusters} cluster${d.clusters === 1 ? '' : 's'}${d.fix ? `. Fix: ${d.fix}` : ''}`} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr) 52px', gap: 1.5, alignItems: 'center' }}>
            <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: gone ? 'text.secondary' : 'text.primary', textDecoration: gone ? 'line-through' : 'none' }}>
              {d.title}
            </Typography>
            <Box sx={{ height: 10 }}>
              <Box sx={{ height: 10, width: `${Math.max(6, (d.points / max) * 100)}%`, borderRadius: '3px', border: '1px solid', borderColor: gone ? 'info.main' : 'warning.main', bgcolor: gone ? 'transparent' : 'warning.main', transition: 'background-color 240ms ease' }} />
            </Box>
            <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 700, color: gone ? 'info.main' : 'text.primary', textAlign: 'right' }}>
              {gone ? 'fixed' : `−${d.points}`}
            </Typography>
          </Box>
        );
      })}
      {drivers.length > shown.length && (
        <Typography variant="caption" color="text.secondary">
          and {drivers.length - shown.length} smaller ones
        </Typography>
      )}
    </Box>
  );
}

function FixChip({ text, tone }: { text: string; tone: 'ready' | 'fixed' | 'decision' }) {
  const colour = tone === 'fixed' ? 'info.main' : tone === 'ready' ? 'text.primary' : 'warning.main';
  return (
    <Box component="span" sx={{ px: 1, py: '1px', borderRadius: 5, border: '1px solid', borderColor: colour, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap', color: tone === 'fixed' ? 'info.main' : 'text.primary' }}>
      {text}
    </Box>
  );
}

export function FleetHero({
  glance,
  top,
  horizon,
  now = Date.now(),
  onScore,
  tiles = [],
  drivers = [],
  fixes = { open: 0, fixable: 0 },
  fixByIssue = new Map(),
  simulate = false,
  simulatedScore,
  onSimulate,
}: {
  glance: Glance;
  top: NowItem[];
  horizon: HorizonItem[];
  now?: number;
  onScore?: () => void;
  /** One tile per cluster. */
  tiles?: WallTile[];
  drivers?: ScoreDriver[];
  fixes?: FixCounts;
  /** The fix the plugin has, by issue id. */
  fixByIssue?: Map<string, FixProposal>;
  simulate?: boolean;
  /** The fleet score with every fixable check passing. */
  simulatedScore?: number;
  onSimulate?: (on: boolean) => void;
}) {
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
  const score = simulate && simulatedScore !== undefined ? simulatedScore : glance.score;
  const left = fixes.open - fixes.fixable;
  const sentence = !fixes.open
    ? 'No open issues need action.'
    : !fixes.fixable
    ? `None of the ${fixes.open} open issues has a one-click fix yet: each needs a decision.`
    : simulate
    ? `${fixes.fixable} fix${fixes.fixable === 1 ? '' : 'es'} simulated. ${left ? `${left} issue${left === 1 ? '' : 's'} left need${left === 1 ? 's' : ''} a decision.` : 'Nothing would be left.'} Nothing has been changed.`
    : `${fixes.fixable} of ${fixes.open} open issues ${fixes.fixable === 1 ? 'has' : 'have'} a fix ready.`;
  return (
    <Box sx={{ display: 'grid', gap: 2, px: 2, mb: 2 }}>
      <Paper variant="outlined" sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box role="button" onClick={onScore} title="The average best-practice score of the clusters: click for each cluster's" sx={{ cursor: onScore ? 'pointer' : 'default' }}>
            <Ring score={score} />
          </Box>
          <Box sx={{ display: 'grid', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <FleetMark size={28} />
              <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, lineHeight: 1 }}>{glance.clusters}</Typography>
              <Typography variant="body2" color="text.secondary">
                clusters
              </Typography>
            </Box>
            <Typography variant="body2" sx={{ fontWeight: 700, color: glance.attention ? 'warning.main' : 'success.main' }}>
              {glance.attention ? `${glance.attention} need${glance.attention === 1 ? 's' : ''} attention` : 'all healthy'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              <Box component="span" sx={{ color: glance.critical ? 'error.main' : undefined, fontWeight: glance.critical ? 700 : 400 }}>
                {glance.critical} critical
              </Box>{' '}
              · {glance.warnings} warnings
            </Typography>
            {glance.supervisorScore !== undefined && (
              <Typography variant="body2" component={Link} to="/vks-fleet/supervisor-health" sx={{ color: scoreColour(glance.supervisorScore), fontWeight: 700, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                Supervisor {glance.supervisorScore}/100 ›
              </Typography>
            )}
          </Box>
        </Box>
        <Box sx={{ flex: '1 1 340px', minWidth: 0 }}>
          <Drivers drivers={drivers} simulate={simulate} />
        </Box>
        <Box sx={{ flex: '0 1 260px', display: 'grid', gap: 0.5 }}>
          {onSimulate && (
            <FormControlLabel
              control={<Switch checked={simulate} disabled={!fixes.fixable && !simulate} onChange={e => onSimulate(e.target.checked)} />}
              label={<Typography sx={{ fontWeight: 700 }}>Simulate fixes</Typography>}
            />
          )}
          <Typography variant="body2" color="text.secondary">
            {sentence}
          </Typography>
        </Box>
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.8fr) minmax(0, 1fr)' }, gap: 2, alignItems: 'start' }}>
        <Paper variant="outlined" sx={card}>
          <ClusterWall tiles={tiles} simulate={simulate} />
        </Paper>

        <Paper variant="outlined" sx={card}>
          <Typography sx={{ fontWeight: 800, mb: 1 }}>Needs you now</Typography>
          {top.length ? (
            <Box sx={{ display: 'grid' }}>
              {top.map(i => {
                const fix = fixByIssue.get(i.id);
                const fixed = simulate && !!fix;
                return (
                  <Box key={i.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', py: 1, borderTop: 1, borderColor: 'divider' }}>
                    <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: fixed ? TONE.info : SEV[i.severity], mt: 0.6, flexShrink: 0 }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" sx={{ fontWeight: 700, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textDecoration: fixed ? 'line-through' : 'none', color: fixed ? 'text.secondary' : 'text.primary' }}>
                        {i.title}
                      </Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', mt: 0.25 }}>
                        {i.sub && (
                          <Typography variant="caption" color="text.secondary">
                            {i.sub}
                          </Typography>
                        )}
                        {fixed ? <FixChip text="Fixed in simulation" tone="fixed" /> : fix ? <FixChip text="Fix ready" tone="ready" /> : null}
                      </Box>
                    </Box>
                    {fix && !fixed ? (
                      <Button size="small" component={Link} to={fix.path} title={fix.label} sx={{ py: 0, flexShrink: 0 }}>
                        Fix…
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
          ) : (
            <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
              Nothing needs you right now.
            </Typography>
          )}

          <Typography sx={{ fontWeight: 800, mt: 2, mb: 0.5 }}>Next {days} days</Typography>
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
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
              {horizon.length === 1 ? `1 item expires or runs out, ${inWords(horizon[0].at, now)}.` : `${horizon.length} items expire or run out; the first ${inWords(horizon[0].at, now)}.`} Hover a dot for what it is.
            </Typography>
          )}
        </Paper>
      </Box>
    </Box>
  );
}
