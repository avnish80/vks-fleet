import { Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { Glance, HORIZON_DAYS, HorizonItem, inWords, NowItem } from '../fleetHero';

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
      <circle cx={60} cy={60} r={r} fill="none" stroke={scoreColour(score)} strokeWidth={11} strokeLinecap="round" strokeDasharray={`${len * pct} ${len}`} transform="rotate(-90 60 60)" />
      <text x={60} y={60} textAnchor="middle" dominantBaseline="central" fontSize={30} fontWeight={800} fill="currentColor">
        {score ?? '—'}
      </text>
      <text x={60} y={86} textAnchor="middle" fontSize={10} fill="currentColor" opacity={0.6}>
        fleet score
      </text>
    </svg>
  );
}

const card = { p: 2, borderRadius: 3, height: '100%', display: 'flex', flexDirection: 'column' as const };

export function FleetHero({ glance, top, horizon, now = Date.now(), onScore }: { glance: Glance; top: NowItem[]; horizon: HorizonItem[]; now?: number; onScore?: () => void }) {
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
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr', xl: '0.9fr 1.3fr 1.6fr' }, gap: 2, px: 2, mb: 2 }}>
      <Paper variant="outlined" sx={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        <Box role="button" onClick={onScore} title="The average best-practice score of the clusters: click for each cluster's" sx={{ cursor: onScore ? 'pointer' : 'default' }}>
          <Ring score={glance.score} />
        </Box>
        <Box sx={{ display: 'grid', gap: 0.5 }}>
          <Typography sx={{ fontSize: '1.6rem', fontWeight: 800, lineHeight: 1 }}>{glance.clusters}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: -0.25 }}>
            clusters
          </Typography>
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
      </Paper>

      <Paper variant="outlined" sx={card}>
        <Typography sx={{ fontWeight: 800, mb: 1 }}>Needs you now</Typography>
        {top.length ? (
          <Box sx={{ display: 'grid', gap: 1.25 }}>
            {top.map(i => (
              <Box key={i.id} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: SEV[i.severity], mt: 0.6, flexShrink: 0 }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 700, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {i.title}
                  </Typography>
                  {i.sub && (
                    <Typography variant="caption" color="text.secondary">
                      {i.sub}
                    </Typography>
                  )}
                </Box>
                {i.investigate ? (
                  <Button size="small" component={Link} to={`/vks-fleet/investigate?cluster=${encodeURIComponent(i.investigate.clusterKey)}${i.investigate.node ? `&node=${encodeURIComponent(i.investigate.node)}` : ''}`} sx={{ py: 0, flexShrink: 0 }}>
                    Investigate
                  </Button>
                ) : i.path ? (
                  <Button size="small" component={Link} to={i.path} sx={{ py: 0, flexShrink: 0 }}>
                    Open
                  </Button>
                ) : null}
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
            ✓ Nothing needs you right now.
          </Typography>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ ...card, gridColumn: { md: '1 / -1', xl: 'auto' } }}>
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
        {horizon.length ? (
          <Box sx={{ display: 'grid', gap: 0.5, mt: 1 }}>
            {horizon.slice(0, 4).map((h, k) => (
              <Box key={k} sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
                <Typography variant="caption" sx={{ minWidth: 70, fontWeight: 700, color: TONE[h.tone], fontVariantNumeric: 'tabular-nums' }}>
                  {inWords(h.at, now)}
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                  {...(h.path ? { component: Link, to: h.path } : {})}
                >
                  {h.text}
                </Typography>
              </Box>
            ))}
            {horizon.length > 4 && (
              <Typography variant="caption" color="text.secondary">
                and {horizon.length - 4} more (hover the dots)
              </Typography>
            )}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Nothing expires or runs out in the next {days} days, as far as the fleet can see.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
