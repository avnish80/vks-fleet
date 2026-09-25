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

/** Local calendar day as YYYY-MM-DD. */
export function localDay(t: string | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clock(t: string): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Newest-first history of one cluster, grouped by day. */
export function ClusterTimeline({
  entries: allEntries,
  cluster,
  limit = 30,
  day: initialDay,
}: {
  entries: TimelineEntry[];
  cluster: FleetCluster;
  limit?: number;
  /** YYYY-MM-DD to show only that (local) day, e.g. from the overview heatmap. */
  day?: string;
}) {
  const tone = useTone();
  const [all, setAll] = React.useState(false);
  const [dayFilter, setDayFilter] = React.useState<string | undefined>(initialDay);
  React.useEffect(() => setDayFilter(initialDay), [initialDay]);
  const entries = dayFilter ? allEntries.filter(e => localDay(e.time) === dayFilter) : allEntries;
  const shown = all ? entries : entries.slice(0, limit);
  if (!entries.length && !dayFilter) {
    return <Typography color="text.secondary">Nothing recorded yet.</Typography>;
  }
  let lastDay = '';
  return (
    <Box>
      {dayFilter && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <Typography variant="body2">
            Showing {day(`${dayFilter}T12:00:00`)} only ({entries.length} entr{entries.length === 1 ? 'y' : 'ies'}).
          </Typography>
          <Button size="small" onClick={() => setDayFilter(undefined)}>
            Show all days
          </Button>
        </Box>
      )}
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

const TONE_RANK: Record<TimelineEntry['tone'], number> = { error: 0, warning: 1, success: 2, info: 3, neutral: 4 };

/**
 * Clusters × days: each cell counts that day's changes, coloured by the most
 * serious one. Click a cell to open that cluster's timeline for that day.
 */
export function ActivityHeatmap({
  lanes,
  clusters,
  now,
  days = 7,
  max = 12,
}: {
  lanes: Map<string, TimelineEntry[]>;
  clusters: FleetCluster[];
  now: Date;
  days?: number;
  max?: number;
}) {
  const tone = useTone();
  const history = useHistory();
  const byKey = new Map(clusters.map(c => [c.key, c]));
  const dayKeys = Array.from({ length: days }, (_, i) => localDay(new Date(now.getTime() - (days - 1 - i) * 86400000)));
  const rows = [...lanes.entries()]
    .map(([key, entries]) => ({ c: byKey.get(key), entries }))
    .filter((r): r is { c: FleetCluster; entries: TimelineEntry[] } => !!r.c)
    .sort((a, b) => b.entries.length - a.entries.length || a.c.name.localeCompare(b.c.name))
    .slice(0, max);
  if (!rows.some(r => r.entries.length)) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 2 }}>
        No changes in the last {days} days.
      </Typography>
    );
  }
  const today = localDay(now);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: `minmax(140px, 220px) repeat(${days}, minmax(44px, 1fr)) 56px`,
          gap: '6px',
          alignItems: 'center',
          minWidth: 520,
        }}
      >
        <Box />
        {dayKeys.map(d => (
          <Typography key={d} variant="caption" color="text.secondary" sx={{ textAlign: 'center', fontWeight: d === today ? 700 : 400 }}>
            {d === today ? 'Today' : new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
          </Typography>
        ))}
        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
          Total
        </Typography>
        {rows.map(({ c, entries }) => (
          <React.Fragment key={c.key}>
            <Typography variant="body2" noWrap title={c.name}>
              <Link to={clusterDeepLink(c, { hash: 'timeline' })}>{c.name}</Link>
            </Typography>
            {dayKeys.map(d => {
              const es = entries.filter(e => localDay(e.time) === d);
              const worst = es.reduce<TimelineEntry['tone'] | undefined>(
                (w, e) => (w === undefined || TONE_RANK[e.tone] < TONE_RANK[w] ? e.tone : w),
                undefined
              );
              const strength = es.length === 0 ? 0 : es.length === 1 ? 0.35 : es.length <= 3 ? 0.6 : 0.85;
              const title = es.length
                ? `${c.name}, ${d}\n${es
                    .slice(0, 8)
                    .map(e => `${new Date(e.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${e.text}`)
                    .join('\n')}${es.length > 8 ? `\n…and ${es.length - 8} more` : ''}`
                : `${c.name}, ${d}: no changes`;
              return (
                <Box
                  key={d}
                  title={title}
                  onClick={es.length ? () => history.push(`/vks-fleet/clusters/${c.supervisorId}/${c.namespace}/${c.name}?day=${d}#timeline`) : undefined}
                  sx={{
                    position: 'relative',
                    height: 30,
                    borderRadius: 1,
                    bgcolor: 'action.hover',
                    overflow: 'hidden',
                    cursor: es.length ? 'pointer' : 'default',
                    '&:hover': es.length ? { outline: '2px solid', outlineColor: 'text.secondary' } : undefined,
                  }}
                >
                  {worst && (
                    <Box sx={{ position: 'absolute', inset: 0, bgcolor: tone(worst === 'neutral' ? 'neutral' : worst), opacity: strength }} />
                  )}
                  {es.length > 0 && (
                    <Typography
                      variant="body2"
                      sx={{
                        position: 'relative',
                        textAlign: 'center',
                        lineHeight: '30px',
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                        color: strength >= 0.6 ? '#fff' : 'text.primary',
                      }}
                    >
                      {es.length}
                    </Typography>
                  )}
                </Box>
              );
            })}
            <Typography variant="body2" sx={{ textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
              {entries.length}
            </Typography>
          </React.Fragment>
        ))}
      </Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mt: 1.5 }}>
        {(
          [
            ['error', 'Failure'],
            ['warning', 'Deletion or warning'],
            ['success', 'Node added or recovered'],
            ['info', 'Created or plugin action'],
          ] as Array<[TimelineEntry['tone'], string]>
        ).map(([t, label]) => (
          <Box key={t} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{ width: 10, height: 10, borderRadius: '3px', bgcolor: tone(t === 'neutral' ? 'neutral' : t) }} />
            <Typography variant="caption" color="text.secondary">
              {label}
            </Typography>
          </Box>
        ))}
        <Typography variant="caption" color="text.secondary">
          Darker means more changes that day.
        </Typography>
      </Box>
    </Box>
  );
}
