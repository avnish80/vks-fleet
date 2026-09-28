import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { dropElevation, elevate, useElevation } from '../elevation';

const DURATIONS = [5, 15, 30, 60];

/** The reason-and-duration form, used in the top bar's dialog and inline in action dialogs. */
export function ElevateForm({ onElevated, compact }: { onElevated?: () => void; compact?: boolean }) {
  const [reason, setReason] = React.useState('');
  const [minutes, setMinutes] = React.useState(15);
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <TextField size="small" label="Why (recorded on each change)" value={reason} onChange={e => setReason(e.target.value)} sx={{ flex: 1, minWidth: compact ? 200 : 280 }} autoFocus={!compact} />
      <TextField select size="small" label="For" value={minutes} onChange={e => setMinutes(Number(e.target.value))} sx={{ width: 120 }}>
        {DURATIONS.map(m => (
          <MenuItem key={m} value={m}>
            {m} min
          </MenuItem>
        ))}
      </TextField>
      <Button
        variant="contained"
        color="warning"
        disabled={reason.trim().length < 3}
        onClick={() => {
          elevate(minutes, reason);
          onElevated?.();
        }}
      >
        Elevate
      </Button>
    </Box>
  );
}

/** In an action dialog, before its dry run: elevation needed first. */
export function ElevationGate() {
  const { enabled, active } = useElevation();
  if (!enabled || active) return null;
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        You're viewing read-only. This change (and its dry run) needs elevation: it then uses the admin sign-in, for a limited time,
        with your reason recorded on what it changes.
      </Typography>
      <ElevateForm compact />
    </Alert>
  );
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Top bar: "Read-only · Elevate…", or the countdown while elevated. */
export function ElevationControl() {
  const { enabled, active, secondsLeft } = useElevation();
  const [open, setOpen] = React.useState(false);
  if (!enabled) return null;
  if (active) {
    return (
      <Box
        title={`Elevated: ${active.reason}`}
        sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.5, borderRadius: 1, bgcolor: 'warning.main', color: 'warning.contrastText' }}
      >
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          Elevated · {mmss(secondsLeft)} left
        </Typography>
        <Button size="small" color="inherit" variant="outlined" onClick={dropElevation} sx={{ py: 0, minWidth: 0 }}>
          Drop
        </Button>
      </Box>
    );
  }
  return (
    <>
      <Button size="small" variant="outlined" onClick={() => setOpen(true)} title="Everyday viewing uses the read-only sign-in; changes need elevation">
        Read-only · Elevate…
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
          <DialogTitle>Elevate to make changes</DialogTitle>
          <DialogContent>
            <Typography variant="body2" sx={{ mb: 2 }}>
              For the time you choose, changes go through the admin sign-in (reads stay read-only). Your reason is recorded on
              everything you change. It ends by itself, when you drop it, or when the page reloads.
            </Typography>
            <ElevateForm onElevated={() => setOpen(false)} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
          </DialogActions>
        </Dialog>
      )}
    </>
  );
}
