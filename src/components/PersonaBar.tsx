import { Alert, Box, MenuItem, TextField, Typography } from '@mui/material';
import React, { ReactNode } from 'react';
import { FleetProvider, useFleetData } from '../fleetContext';
import { ALL_ORGS } from '../scope';
import { useTone } from './charts';

/** Who is signed in, and (for operators and read-only admins) which org they're looking at. */
export function PersonaBar() {
  const { persona, orgs, org, setOrg, config } = useFleetData();
  const tone = useTone();
  if (!config.supervisors.length) return null;
  const p = persona?.persona ?? 'unknown';
  const colour =
    p === 'operator' ? tone('primary') : p === 'readonly' ? tone('info') : p.startsWith('tenant') ? tone('success') : tone('neutral');
  const canSwitch = (p === 'operator' || p === 'readonly' || p === 'unknown') && orgs.length > 1;
  const orgName = orgs.find(o => o.id === org)?.name;
  return (
    <Box sx={{ px: 2, pt: 2 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          flexWrap: 'wrap',
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          px: 2,
          py: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: colour }} />
          <Typography sx={{ fontWeight: 600 }}>{persona?.label ?? 'Checking access…'}</Typography>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
          {persona?.detail}
        </Typography>
        {canSwitch && (
          <TextField select size="small" label="Org" value={org} onChange={e => setOrg(e.target.value)} sx={{ minWidth: 200 }}>
            <MenuItem value={ALL_ORGS}>All orgs</MenuItem>
            {orgs.map(o => (
              <MenuItem key={o.id} value={o.id}>
                {o.name} ({o.clusters})
              </MenuItem>
            ))}
          </TextField>
        )}
      </Box>
      {org !== ALL_ORGS && p === 'operator' && !config.readOnly && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Viewing {orgName ?? 'one org'} only. You're signed in as an operator, so actions still use operator rights.
        </Alert>
      )}
    </Box>
  );
}

/** Every plugin page: shared data, the persona bar, then the page. */
export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <FleetProvider>
      <PersonaBar />
      {children}
    </FleetProvider>
  );
}
