import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { settingsStore, useRawSettings } from '../settings/store';
import { DURATIONS, newSilence } from '../silences';
import { Silence } from '../types';

/** Mute one issue or finding, or a whole cluster (maintenance), for a while. */
export function SilenceDialog({ match, label, onClose }: { match: Silence['match']; label: string; onClose: () => void }) {
  const raw = useRawSettings();
  const [reason, setReason] = React.useState('');
  const [hours, setHours] = React.useState(match.clusterKey ? 8 : 24 * 30);
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{match.clusterKey ? 'Maintenance mode' : 'Silence'}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Typography variant="body2">
            {match.clusterKey
              ? `Every issue from ${label} is muted until the time is up: for planned work, so alerts don't distract.`
              : `"${label}" stops appearing among active issues until the time is up. It stays visible under Silenced.`}
          </Typography>
          <TextField select size="small" label="For" value={hours} onChange={e => setHours(Number(e.target.value))}>
            {DURATIONS.map(d => (
              <MenuItem key={d.hours} value={d.hours}>
                {d.label}
              </MenuItem>
            ))}
          </TextField>
          <TextField size="small" label="Reason (required)" value={reason} onChange={e => setReason(e.target.value)} />
          <Typography variant="caption" color="text.secondary">
            Silences are kept with the plugin settings in this browser (an administrator can preset them).
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!reason.trim()}
          onClick={() => {
            settingsStore.update({ silences: [...(raw.silences ?? []), newSilence(match, label, reason.trim(), hours)] });
            onClose();
          }}
        >
          {match.clusterKey ? 'Start maintenance' : 'Silence'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Ends a silence this browser created (preset ones stay: they're the administrator's). */
export function removeSilence(id: string) {
  const own = settingsStore.get()?.silences ?? [];
  settingsStore.update({ silences: own.filter(s => s.id !== id) });
}

/** Whether a silence was created in this browser (and so can be ended here). */
export function isOwnSilence(id: string): boolean {
  return (settingsStore.get()?.silences ?? []).some(s => s.id === id);
}
