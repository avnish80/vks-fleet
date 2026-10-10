/**
 * "Do these first": the fleet's recommended steps, the ones with the most
 * effect on top. Each is one step for every cluster it applies to, says what
 * it would clear, and leads to where it is done. Nothing here changes anything.
 */
import { Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { EFFORT_LABEL, effectText, Recommendation } from '../recommendations';
import { card } from './FleetHero';

function Row({ rec, done, first }: { rec: Recommendation; done: boolean; first: boolean }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Box sx={{ py: 1, borderTop: first ? 0 : 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1.5, rowGap: 0.5 }}>
        <Box sx={{ flex: '1 1 320px', minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, textDecoration: done ? 'line-through' : 'none', color: done ? 'text.secondary' : 'text.primary' }}>{rec.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {rec.urgent && (
              <Box component="span" sx={{ color: 'error.main', fontWeight: 700 }}>
                Urgent ·{' '}
              </Box>
            )}
            {effectText(rec)}
          </Typography>
        </Box>
        <Box component="span" title="How much it takes: one click (an action with a dry run), guided (a few steps on a page), or a change window (a planned change)." sx={{ px: 1, py: '1px', borderRadius: 5, border: '1px solid', borderColor: done ? 'info.main' : 'divider', color: done ? 'info.main' : 'text.primary', fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {done ? 'Done in simulation' : EFFORT_LABEL[rec.effort]}
        </Box>
        <Button size="small" variant="contained" component={Link} to={rec.path} title="Opens where it is done. Nothing changes until you confirm it there.">
          Open
        </Button>
        <Button size="small" variant="outlined" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Why'}
        </Button>
      </Box>
      {open && (
        <Box sx={{ mt: 0.75, display: 'grid', gap: 0.5 }}>
          <Typography variant="body2">{rec.why}</Typography>
          {rec.clusters.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.25, alignItems: 'baseline' }}>
              <Typography variant="body2" color="text.secondary">
                {rec.clusters.length === 1 ? 'Cluster:' : `${rec.clusters.length} clusters:`}
              </Typography>
              {rec.clusters.map(c => (
                <Typography key={c.key} variant="body2" component={Link} to={c.path} sx={{ fontWeight: 700 }}>
                  {c.name}
                </Typography>
              ))}
            </Box>
          )}
          {!rec.simulated && (
            <Typography variant="body2" color="text.secondary">
              Not counted in Simulate: it is a project of its own, planned and run from its page.
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

export function RecommendationsCard({ recs, simulated = false, limit = 5 }: { recs: Recommendation[]; /** Simulate is showing the recommended steps as done. */ simulated?: boolean; limit?: number }) {
  const [all, setAll] = React.useState(false);
  if (!recs.length) return null;
  const shown = all ? recs : recs.slice(0, limit);
  return (
    <Paper variant="outlined" sx={card}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 1.5, mb: 0.5 }}>
        <Typography sx={{ fontWeight: 800 }}>Do these first</Typography>
        <Typography variant="body2" color="text.secondary">
          {recs.length === 1 ? 'One recommended step' : `${recs.length} recommended steps`}, most effect first. Each opens where it is done; nothing is changed from here.
        </Typography>
      </Box>
      {shown.map((r, k) => (
        <Row key={r.key} rec={r} done={simulated && r.simulated} first={k === 0} />
      ))}
      {recs.length > limit && (
        <Box>
          <Button size="small" onClick={() => setAll(!all)}>
            {all ? `Show the first ${limit}` : `Show all ${recs.length}`}
          </Button>
        </Box>
      )}
    </Paper>
  );
}
