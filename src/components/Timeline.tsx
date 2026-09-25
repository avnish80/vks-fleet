import { Box, Button, Typography, useTheme } from '@mui/material';
import React from 'react';
import { Link, useHistory } from 'react-router-dom';
import { clusterDeepLink, machinePath } from '../routes';
import { TimelineEntry } from '../timeline';
import { FleetCluster } from '../types';
import { useTone } from './charts';

function day(t: string): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function clock(t: string): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Newest-first history of one cluster, grouped by day. */
export function ClusterTimeline({ entries, cluster, limit = 30 }: { entries: TimelineEntry[]; cluster: FleetCluster; limit?: number }) {
  const tone = useTone();
  const [all, setAll] = React.useState(false);
  const shown = all ? entries : entries.slice(0, limit);
  if (!entries.length) {
    return <Typography color="text.secondary">Nothing recorded yet.</Typography>;
  }
  let lastDay = '';
  return (
    <Box>
      <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, position: 'relative' }}>
        {shown.map((e, i) => {
          const d = day(e.time);
          const header = d !== lastDay;
          lastDay = d;
          return (
            <React.Fragment key={`${e.time}-${i}`}>
              {header && (
                <Typography
                  component="li"
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, mt: i ? 2 : 0, mb: 1 }}
                >
                  {d}
                </Typography>
              )}
              <Box component="li" sx={{ display: 'grid', gridTemplateColumns: '56px 16px 1fr', alignItems: 'start', columnGap: 1, py: 0.5 }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {clock(e.time)}
                </Typography>
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', mt: '5px', bgcolor: tone(e.tone === 'neutral' ? 'neutral' : e.tone) }} />
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                  {e.machine ? <Link to={machinePath(cluster, e.machine)}>{e.text}</Link> : e.text}
                </Typography>
              </Box>
            </React.Fragment>
          );
        })}
      </Box>
      {entries.length > limit && (
        <Button size="small" onClick={() => setAll(!all)} sx={{ mt: 1 }}>
          {all ? 'Show fewer' : `Show all ${entries.length}`}
        </Button>
      )}
    </Box>
  );
}

/** One lane per cluster over the last few days, a dot per entry. */
export function FleetActivity({
  lanes,
  clusters,
  now,
  days = 7,
}: {
  lanes: Map<string, TimelineEntry[]>;
  clusters: FleetCluster[];
  now: Date;
  days?: number;
}) {
  const theme: any = useTheme();
  const tone = useTone();
  const history = useHistory();
  const muted = theme.palette?.text?.secondary ?? '#666';
  const grid = theme.palette?.divider ?? '#ddd';
  const byKey = new Map(clusters.map(c => [c.key, c]));
  const order = [...lanes.entries()]
    .filter(([, es]) => es.length)
    .sort((a, b) => (b[1][b[1].length - 1]?.time ?? '').localeCompare(a[1][a[1].length - 1]?.time ?? ''))
    .slice(0, 10);
  if (!order.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>
        No activity in the last {days} days.
      </Typography>
    );
  }
  const W = 640;
  const LABEL = 150;
  const LANE = 30;
  const H = order.length * LANE + 28;
  const from = now.getTime() - days * 86400000;
  const x = (t: string) => LABEL + ((new Date(t).getTime() - from) / (days * 86400000)) * (W - LABEL - 12);
  const ticks = Array.from({ length: days + 1 }, (_, i) => new Date(from + i * 86400000));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Activity over the last ${days} days`}>
      {ticks.map((t, i) => {
        const tx = LABEL + (i / days) * (W - LABEL - 12);
        return (
          <g key={i}>
            <line x1={tx} x2={tx} y1={0} y2={H - 20} stroke={grid} strokeWidth={1} />
            {i < days && (
              <text x={tx + 3} y={H - 6} fontSize={10} fill={muted}>
                {t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
              </text>
            )}
          </g>
        );
      })}
      {order.map(([key, entries], i) => {
        const c = byKey.get(key);
        const y = i * LANE + LANE / 2;
        return (
          <g key={key}>
            <text
              x={0}
              y={y + 4}
              fontSize={11}
              fill={muted}
              style={{ cursor: c ? 'pointer' : 'default' }}
              onClick={() => c && history.push(clusterDeepLink(c, { hash: 'timeline' }))}
            >
              {(c?.name ?? key).length > 22 ? `${(c?.name ?? key).slice(0, 21)}…` : c?.name ?? key}
            </text>
            <line x1={LABEL} x2={W - 12} y1={y} y2={y} stroke={grid} strokeWidth={1} strokeDasharray="2 3" />
            {entries.map((e, j) => (
              <circle
                key={j}
                cx={x(e.time)}
                cy={y}
                r={5}
                fill={tone(e.tone === 'neutral' ? 'neutral' : e.tone)}
                stroke={theme.palette?.background?.paper ?? '#fff'}
                strokeWidth={1.5}
                style={{ cursor: c ? 'pointer' : 'default' }}
                onClick={() => c && history.push(e.machine ? machinePath(c, e.machine) : clusterDeepLink(c, { hash: 'timeline' }))}
              >
                <title>{`${new Date(e.time).toLocaleString()}: ${e.text}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
