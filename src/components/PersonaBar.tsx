import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { Guard } from './Guard';
import { ElevationControl } from './Elevation';
import React, { ReactNode } from 'react';
import { FleetProvider, useFleetData } from '../fleetContext';
import { identityLabel } from '../identity';
import { ALL_ORGS } from '../scope';
import { useTone } from './charts';
import { CommandPalette } from './CommandPalette';

/** Who is signed in, and (for operators and read-only admins) which org they're looking at. */
export function PersonaBar() {
  const { persona, orgs, org, setOrg, config, identities, identity, setIdentity, canSwitchIdentity, userNames, all } = useFleetData();
  const expired = (all ?? []).find(r => r.signInExpired);
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
          <ElevationControl />
          {config.demo && (
            <Box
              title="Demo mode (Settings): a fictional fleet; nothing is ever changed"
              sx={{ px: 1, py: 0.25, borderRadius: 1, bgcolor: 'warning.main', color: 'warning.contrastText', fontWeight: 700, fontSize: '0.75rem', letterSpacing: 0.5 }}
            >
              DEMO
            </Box>
          )}
          <Typography sx={{ fontWeight: 600 }}>{persona?.label ?? 'Checking access…'}</Typography>
          {persona?.user && (
            <Typography variant="body2" color="text.secondary">
              as {persona.user}
            </Typography>
          )}
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 200 }}>
          {persona?.detail}
        </Typography>
        <Typography variant="caption" color="text.secondary" title="Jump to any page, cluster, VM or namespace">
          Ctrl+K to jump
        </Typography>
        {canSwitchIdentity && (
          <TextField
            select
            size="small"
            label="Signed in as"
            value={identity ?? ''}
            onChange={e => setIdentity(e.target.value)}
            sx={{ minWidth: 260 }}
            title="Switches the account the plugin reads and acts with"
          >
            {identities.map(i => (
              <MenuItem key={i.id} value={i.id}>
                {identityLabel(i, userNames.get(i.id))}
              </MenuItem>
            ))}
          </TextField>
        )}
        {(config.links ?? []).map(l => (
          <Button key={l.url} size="small" variant="outlined" href={l.url} target="_blank" rel="noopener noreferrer">
            {l.label}
          </Button>
        ))}
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
      {expired && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {expired.error}
        </Alert>
      )}
      {org !== ALL_ORGS && p === 'operator' && !config.readOnly && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Viewing {orgName ?? 'one org'} only. You're signed in as an operator, so actions still use operator rights.
        </Alert>
      )}
    </Box>
  );
}

/** Consistent, calmer tables and spacing on every plugin page (scoped to the plugin). */
function PageStyles() {
  return (
    <style>{`
      .vks-fleet-page .MuiTableCell-head { font-weight: 600; white-space: nowrap; }
      .vks-fleet-page .MuiTableCell-root { vertical-align: top; }
      .vks-fleet-page .MuiTableBody-root .MuiTableRow-root:hover > td { background-color: rgba(127, 127, 127, 0.06); }
      .vks-fleet-page table { font-variant-numeric: tabular-nums; }
      .vks-fleet-page .MuiAlert-root { border-radius: 8px; }
      .vks-fleet-page pre, .vks-fleet-page code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    `}</style>
  );
}

/** Every plugin page: shared data, the persona bar, then the page. */
export function PageFrame({ children }: { children: ReactNode }) {
  return (
    <FleetProvider>
      <PageStyles />
      <Box className="vks-fleet-page">
        <PersonaBar />
        <CommandPalette />
        <Guard name="This page">{children}</Guard>
      </Box>
    </FleetProvider>
  );
}
