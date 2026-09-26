import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import React from 'react';
import { ActionPlan, blocked } from '../actions';
import { describeError, SupervisorWriter } from '../api/client';

export interface BatchItem {
  label: string;
  plan: ActionPlan;
  writer: SupervisorWriter;
}

/**
 * The same change across several places: blocked items are left out, every
 * other one is dry-run first, and only if all pass are they applied one
 * after another, stopping at the first failure.
 */
export function BatchActionDialog({
  title,
  items,
  onClose,
  onDone,
}: {
  title: string;
  items: BatchItem[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [phase, setPhase] = React.useState<'idle' | 'checking' | 'checked' | 'applying' | 'done'>('idle');
  const [results, setResults] = React.useState<Array<{ label: string; ok: boolean; message: string }>>([]);
  const runnable = items.filter(i => !blocked(i.plan));
  const skipped = items.filter(i => blocked(i.plan));

  async function run(dryRun: boolean) {
    setPhase(dryRun ? 'checking' : 'applying');
    const out: Array<{ label: string; ok: boolean; message: string }> = [];
    for (const it of runnable) {
      try {
        for (const req of it.plan.requests(dryRun ? 'dry run' : reason)) await it.writer.send(req, dryRun);
        out.push({ label: it.label, ok: true, message: dryRun ? 'Accepted in a dry run.' : 'Done.' });
      } catch (err) {
        out.push({ label: it.label, ok: false, message: describeError(err) });
        if (!dryRun) break;
      }
      setResults([...out]);
    }
    setResults(out);
    setPhase(dryRun ? 'checked' : 'done');
    if (!dryRun) onDone?.();
  }
  const allPassed = phase === 'checked' && results.length === runnable.length && results.every(r => r.ok);
  return (
    <Dialog open onClose={phase === 'applying' ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
          <Typography variant="body2">
            {runnable.length} to change, one after another{skipped.length ? `; ${skipped.length} left out` : ''}.
          </Typography>
          {skipped.length > 0 && (
            <Alert severity="info">
              Left out: {skipped.map(s => `${s.label} (${s.plan.checks.find(c => c.level === 'block')?.text ?? 'blocked'})`).join('; ')}
            </Alert>
          )}
          {results.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {results.map(r => (
                <li key={r.label}>
                  <Typography variant="body2" color={r.ok ? 'text.primary' : 'error'}>
                    {r.label}: {r.message}
                  </Typography>
                </li>
              ))}
            </Box>
          )}
          {phase === 'checked' && !allPassed && <Alert severity="error">At least one would be rejected; nothing was changed.</Alert>}
          {allPassed && <Alert severity="success">All passed the dry run.</Alert>}
          {phase === 'done' && (
            <Alert severity={results.every(r => r.ok) ? 'success' : 'error'}>
              {results.every(r => r.ok) ? 'All done.' : 'Stopped at the first failure; the ones before it were changed.'}
            </Alert>
          )}
          {phase !== 'done' && <TextField size="small" label="Reason" value={reason} onChange={e => setReason(e.target.value)} />}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={phase === 'applying'}>
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {phase !== 'done' && (
          <Button onClick={() => run(true)} disabled={!runnable.length || phase === 'checking' || phase === 'applying'}>
            {phase === 'checking' ? 'Checking…' : 'Dry run'}
          </Button>
        )}
        {phase !== 'done' && (
          <Button variant="contained" onClick={() => run(false)} disabled={!allPassed || !reason.trim()}>
            {phase === 'applying' ? 'Applying…' : 'Apply all'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
