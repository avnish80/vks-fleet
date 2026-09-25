import { Alert, Box, Button, Paper, TextField, Typography } from '@mui/material';
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

type Draft = Partial<SupervisorConfig>;

/** One Supervisor's form. Text fields that are parsed (lists, names) keep their raw text while editing. */
function SupervisorForm({
  value,
  index,
  duplicateId,
  onChange,
  onRemove,
}: {
  value: Draft;
  index: number;
  duplicateId: boolean;
  onChange: (next: Draft) => void;
  onRemove: () => void;
}) {
  const [namespacesText, setNamespacesText] = React.useState((value.namespaces ?? []).join(', '));
  const [namesText, setNamesText] = React.useState(formatTenantNames(value.tenantNames));
  const id = value.id ?? '';
  const idError = id !== '' && !isValidSupervisorId(id);
  const save = (patch: Draft) => onChange({ ...value, ...patch });

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {value.displayName?.trim() || value.id || value.headlampCluster || `Supervisor ${index + 1}`}
        </Typography>
        <Button size="small" color="error" onClick={onRemove}>
          Remove
        </Button>
      </Box>
      <TextField
        label="Headlamp cluster for the Supervisor"
        helperText="The cluster name exactly as Headlamp lists it."
        value={value.headlampCluster ?? ''}
        onChange={e => save({ headlampCluster: e.target.value })}
        required
        size="small"
      />
      <TextField
        label="Supervisor ID"
        helperText={
          duplicateId
            ? 'Another Supervisor already uses this ID. IDs must be unique.'
            : idError
            ? 'Use lowercase letters, numbers, dots and dashes.'
            : "Used in links to clusters. Set it once and don't change it; leave empty to use the cluster name."
        }
        error={idError || duplicateId}
        value={id}
        onChange={e => save({ id: e.target.value.trim() })}
        size="small"
      />
      <TextField
        label="Display name"
        helperText="Optional. For example: sg-az1-supervisor."
        value={value.displayName ?? ''}
        onChange={e => save({ displayName: e.target.value })}
        size="small"
      />
      <TextField
        label="Namespaces"
        helperText="Comma-separated. Read when your account can't list clusters across all namespaces."
        value={namespacesText}
        onChange={e => {
          setNamespacesText(e.target.value);
          save({ namespaces: parseNamespaces(e.target.value) });
        }}
        size="small"
      />
      <TextField
        label="Tenant label key"
        helperText={`Namespace label whose value identifies the tenant. VCFA sets ${DEFAULT_TENANT_LABEL}. Clear it to treat each namespace as its own tenant.`}
        value={value.tenantLabelKey ?? DEFAULT_TENANT_LABEL}
        onChange={e => save({ tenantLabelKey: e.target.value.trim() })}
        size="small"
      />
      <TextField
        label="Tenant names"
        multiline
        minRows={2}
        placeholder={'81bc9f2a-8e16-46e0-b7e2-3e94bf215fc1 = org1\n6b9e01e4-8214-4c8a-9378-eae07e9e5dde = org2'}
        helperText="One per line: tenant ID = name. Unnamed tenants show their ID on the fleet page so you can copy it here."
        value={namesText}
        onChange={e => {
          setNamesText(e.target.value);
          save({ tenantNames: parseTenantNames(e.target.value) });
        }}
        size="small"
      />
    </Paper>
  );
}

export function SettingsPanel() {
  const raw = useRawSettings();
  const supervisors: Draft[] = raw.supervisors ?? [];
  // Stable keys for the forms, so removing one doesn't reset the others' text fields.
  const [keys, setKeys] = React.useState<number[]>(() => supervisors.map((_, i) => i));
  const nextKey = React.useRef(supervisors.length);
  if (keys.length !== supervisors.length) {
    // Settings changed elsewhere (another tab): realign.
    const realigned = supervisors.map((_, i) => keys[i] ?? nextKey.current++);
    setKeys(realigned);
  }

  const write = (list: Draft[]) => settingsStore.update({ supervisors: list as SupervisorConfig[] });
  const idOf = (s: Draft) => (s.id?.trim() || s.headlampCluster?.trim().toLowerCase() || '');
  const ids = supervisors.map(idOf);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 720 }}>
      <Typography variant="body2">
        Add each Supervisor your VKS clusters run on. Headlamp must already have a cluster entry (kubeconfig context)
        for each one.
      </Typography>
      {supervisors.length === 0 && <Alert severity="info">No Supervisors yet. Add one to see its clusters.</Alert>}
      {supervisors.map((s, i) => (
        <SupervisorForm
          key={keys[i] ?? i}
          value={s}
          index={i}
          duplicateId={!!ids[i] && ids.indexOf(ids[i]) !== i}
          onChange={next => write(supervisors.map((x, j) => (j === i ? next : x)))}
          onRemove={() => {
            write(supervisors.filter((_, j) => j !== i));
            setKeys(keys.filter((_, j) => j !== i));
          }}
        />
      ))}
      <Box>
        <Button
          variant="outlined"
          onClick={() => {
            write([...supervisors, { namespaces: [] } as Draft]);
            setKeys([...keys, nextKey.current++]);
          }}
        >
          Add Supervisor
        </Button>
      </Box>
      <TextField
        label="Refresh every (seconds)"
        type="number"
        inputProps={{ min: MIN_REFRESH_SECONDS }}
        helperText={`Minimum ${MIN_REFRESH_SECONDS}. Applies to every Supervisor.`}
        value={raw.refreshSeconds ?? DEFAULT_REFRESH_SECONDS}
        onChange={e => settingsStore.update({ refreshSeconds: Number(e.target.value) })}
        size="small"
        sx={{ maxWidth: 260 }}
      />
    </Box>
  );
}
