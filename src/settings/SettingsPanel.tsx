import { Box, TextField, Typography } from '@mui/material';
import React from 'react';
import {
  DEFAULT_REFRESH_SECONDS,
  DEFAULT_TENANT_LABEL,
  formatTenantNames,
  isValidSupervisorId,
  MIN_REFRESH_SECONDS,
  parseNamespaces,
  parseTenantNames,
} from '../config';
import { SupervisorConfig } from '../types';
import { settingsStore, useRawSettings } from './store';

/**
 * Phase 1: edits a single Supervisor (index 0 of the stored list).
 * Phase 2: render this form once per entry, with add and remove.
 */
export function SettingsPanel() {
  const raw = useRawSettings();
  const current: Partial<SupervisorConfig> = raw.supervisors?.[0] ?? {};

  // Kept as text while editing so typing commas and spaces isn't fought by parsing.
  const [namespacesText, setNamespacesText] = React.useState((current.namespaces ?? []).join(', '));
  const [namesText, setNamesText] = React.useState(formatTenantNames(current.tenantNames));

  function saveSupervisor(patch: Partial<SupervisorConfig>) {
    const next = { ...current, ...patch } as SupervisorConfig;
    const rest = (raw.supervisors ?? []).slice(1);
    settingsStore.update({ supervisors: [next, ...rest] });
  }

  const id = current.id ?? '';
  const idError = id !== '' && !isValidSupervisorId(id);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 640 }}>
      <Typography variant="body2">
        Point the fleet view at the Supervisor your VKS clusters run on. Headlamp must already have a
        cluster entry (kubeconfig context) for that Supervisor.
      </Typography>

      <TextField
        label="Headlamp cluster for the Supervisor"
        helperText="The cluster name exactly as Headlamp lists it."
        value={current.headlampCluster ?? ''}
        onChange={e => saveSupervisor({ headlampCluster: e.target.value })}
        required
      />
      <TextField
        label="Supervisor ID"
        helperText={
          idError
            ? 'Use lowercase letters, numbers, dots and dashes.'
            : "Used in links to clusters. Set it once and don't change it; leave empty to use the cluster name."
        }
        error={idError}
        value={id}
        onChange={e => saveSupervisor({ id: e.target.value.trim() })}
      />
      <TextField
        label="Display name"
        helperText="Optional. For example: sg-az1-supervisor."
        value={current.displayName ?? ''}
        onChange={e => saveSupervisor({ displayName: e.target.value })}
      />
      <TextField
        label="Namespaces"
        helperText="Comma-separated. Read when your account can't list clusters across all namespaces, which is typical for tenant users."
        value={namespacesText}
        onChange={e => {
          setNamespacesText(e.target.value);
          saveSupervisor({ namespaces: parseNamespaces(e.target.value) });
        }}
      />
      <TextField
        label="Tenant label key"
        helperText={`Namespace label whose value identifies the tenant. VCFA sets ${DEFAULT_TENANT_LABEL}. Clear it to treat each namespace as its own tenant.`}
        value={current.tenantLabelKey ?? DEFAULT_TENANT_LABEL}
        onChange={e => saveSupervisor({ tenantLabelKey: e.target.value.trim() })}
      />
      <TextField
        label="Tenant names"
        multiline
        minRows={3}
        placeholder={'81bc9f2a-8e16-46e0-b7e2-3e94bf215fc1 = org1\n6b9e01e4-8214-4c8a-9378-eae07e9e5dde = org2'}
        helperText="One per line: tenant ID = name. The fleet view shows each unnamed tenant's ID so you can copy it here."
        value={namesText}
        onChange={e => {
          setNamesText(e.target.value);
          saveSupervisor({ tenantNames: parseTenantNames(e.target.value) });
        }}
      />
      <TextField
        label="Refresh every (seconds)"
        type="number"
        inputProps={{ min: MIN_REFRESH_SECONDS }}
        helperText={`Minimum ${MIN_REFRESH_SECONDS}.`}
        value={raw.refreshSeconds ?? DEFAULT_REFRESH_SECONDS}
        onChange={e => settingsStore.update({ refreshSeconds: Number(e.target.value) })}
      />
    </Box>
  );
}
