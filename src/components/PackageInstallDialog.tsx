import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { headlampWriter } from '../api/headlampClient';
import { installPlan } from '../packageInstall';
import { ClusterPackages, compareVersions, defaultInstallName } from '../packages';
import { FleetCluster } from '../types';
import { buildValues, Field, schemaFields, valuesText } from '../valuesSchema';
import { BatchActionDialog, BatchItem } from './BatchActionDialog';

export interface InstallTarget {
  cluster: FleetCluster;
  cp: ClusterPackages;
  writable: boolean;
}

/**
 * Install a package from the clusters' own repositories: pick clusters,
 * version, namespace and values (a form from the package's schema, or YAML),
 * then dry-run and install on each cluster in turn.
 */
export function PackageInstallDialog({ refName, displayName, targets, onClose, onDone }: { refName: string; displayName: string; targets: InstallTarget[]; onClose: () => void; onDone: () => void }) {
  const eligible = targets.filter(t => t.writable && (t.cp.definitions ?? []).some(d => d.refName === refName) && !t.cp.items.some(i => i.refName === refName));
  const [chosen, setChosen] = React.useState<Set<string>>(new Set(eligible.map(t => t.cluster.key)));
  const selected = eligible.filter(t => chosen.has(t.cluster.key));
  // Versions every chosen cluster offers, newest first.
  const offered = (t: InstallTarget) => (t.cp.definitions ?? []).filter(d => d.refName === refName).map(d => d.version);
  const common = (selected.length ? selected : eligible)
    .map(offered)
    .reduce<string[] | null>((acc, vs) => (acc === null ? vs : acc.filter(v => vs.includes(v))), null) ?? [];
  const versions = [...common].sort((a, b) => compareVersions(b, a));
  const [version, setVersion] = React.useState(versions[0] ?? '');
  const firstDef = (selected[0] ?? eligible[0])?.cp.definitions?.find(d => d.refName === refName && d.version === version);
  const [namespace, setNamespace] = React.useState(firstDef?.namespace ?? 'tkg-system');
  const [name, setName] = React.useState(defaultInstallName(refName));
  const [mode, setMode] = React.useState<'form' | 'text'>('form');
  const [entries, setEntries] = React.useState<Record<string, string | boolean | undefined>>({});
  const [text, setText] = React.useState('');
  const [review, setReview] = React.useState<BatchItem[] | null>(null);

  const fields: Field[] = React.useMemo(() => schemaFields(firstDef?.schema), [firstDef?.schema]);
  const built = buildValues(fields, entries);
  const values = mode === 'form' ? valuesText(built.values) : text;
  const problems = mode === 'form' ? built.errors : [];

  if (review) {
    return <BatchActionDialog title={`Install ${displayName}`} items={review} onClose={onClose} onDone={onDone} />;
  }

  const next = () => {
    setReview(
      selected.map(t => {
        const def = t.cp.definitions!.find(d => d.refName === refName && d.version === version) ?? { refName, version, namespace };
        return {
          label: t.cluster.name,
          writer: headlampWriter(t.cp.contextName),
          plan: installPlan({ cluster: t.cluster.name, def, namespace, name, values, installed: t.cp.items, versionsHere: offered(t) }),
        };
      })
    );
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Install {displayName}</DialogTitle>
      <DialogContent>
        {eligible.length === 0 ? (
          <Alert severity="info">
            {(() => {
              const offering = targets.filter(t => (t.cp.definitions ?? []).some(d => d.refName === refName));
              const have = offering.filter(t => t.cp.items.some(i => i.refName === refName));
              if (have.length) {
                const where = have.map(t => {
                  const i = t.cp.items.find(x => x.refName === refName)!;
                  return `${t.cluster.name} (${i.namespace}/${i.name}${i.managedByVks ? ', managed by VKS' : ''})`;
                });
                return `${displayName} is already installed in ${where.join(', ')}.`;
              }
              if (!offering.length) return `No cluster's package repositories offer ${refName}.`;
              return `You can't change the clusters that offer ${refName}.`;
            })()}
          </Alert>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
            <Box>
              <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Clusters</Typography>
              {eligible.map(t => (
                <FormControlLabel
                  key={t.cluster.key}
                  control={
                    <Checkbox
                      checked={chosen.has(t.cluster.key)}
                      onChange={e => {
                        const s = new Set(chosen);
                        if (e.target.checked) s.add(t.cluster.key);
                        else s.delete(t.cluster.key);
                        setChosen(s);
                      }}
                    />
                  }
                  label={`${t.cluster.name} (${t.cluster.namespace})`}
                />
              ))}
            </Box>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <TextField select size="small" label="Version" value={versions.includes(version) ? version : ''} onChange={e => setVersion(e.target.value)} sx={{ minWidth: 280 }} helperText="Versions every chosen cluster offers">
                {versions.map(v => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField size="small" label="Namespace" value={namespace} onChange={e => setNamespace(e.target.value.trim())} helperText="Where the package's repository is, normally" />
              <TextField
                size="small"
                label="Install name"
                value={name}
                onChange={e => setName(e.target.value.trim().toLowerCase())}
                error={!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name) || name.length > 40}
                helperText="Lowercase letters, digits and dashes"
              />
            </Box>
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography sx={{ fontWeight: 600 }}>Values</Typography>
                <Button size="small" variant={mode === 'form' ? 'contained' : 'text'} onClick={() => setMode('form')} disabled={!fields.length}>
                  Form
                </Button>
                <Button
                  size="small"
                  variant={mode === 'text' ? 'contained' : 'text'}
                  onClick={() => {
                    if (mode === 'form' && !text) setText(valuesText(built.values));
                    setMode('text');
                  }}
                >
                  YAML
                </Button>
                <Typography variant="caption" color="text.secondary">
                  {fields.length ? 'Only settings you change are sent; the rest keep the package defaults.' : "This package doesn't publish a values schema: use YAML, or leave empty for the defaults."}
                </Typography>
              </Box>
              {mode === 'form' && fields.length > 0 ? (
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5, maxHeight: 360, overflowY: 'auto', pr: 1 }}>
                  {fields.map(f => (
                    <FieldInput key={f.key} field={f} value={entries[f.key]} onChange={v => setEntries({ ...entries, [f.key]: v })} />
                  ))}
                </Box>
              ) : (
                <TextField
                  multiline
                  minRows={6}
                  fullWidth
                  value={mode === 'form' ? values : text}
                  onChange={e => {
                    setMode('text');
                    setText(e.target.value);
                  }}
                  placeholder="# values.yaml (YAML or JSON); empty uses the package defaults"
                  InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.82rem' } }}
                />
              )}
              {problems.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {problems.join('; ')}
                </Alert>
              )}
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!selected.length || !version || !name || !namespace || problems.length > 0} onClick={next}>
          Review and dry run
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function FieldInput({ field: f, value, onChange }: { field: Field; value: string | boolean | undefined; onChange: (v: string | boolean | undefined) => void }) {
  const def = f.default === undefined ? undefined : typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default);
  if (f.type === 'boolean') {
    const checked = value === undefined ? f.default === true : value === true;
    return (
      <FormControlLabel
        title={f.description}
        control={<Checkbox checked={checked} onChange={e => onChange(e.target.checked)} />}
        label={<Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{f.key}</Typography>}
      />
    );
  }
  if (f.type === 'enum') {
    return (
      <TextField select size="small" label={f.key} value={value === undefined ? def ?? '' : String(value)} onChange={e => onChange(e.target.value)} helperText={f.description} FormHelperTextProps={{ sx: { maxHeight: 40, overflow: 'hidden' } }}>
        {f.enum!.map(o => (
          <MenuItem key={o} value={o}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  }
  return (
    <TextField
      size="small"
      label={f.key}
      value={value === undefined ? '' : String(value)}
      placeholder={def ?? ''}
      type={f.type === 'number' || f.type === 'integer' ? 'number' : 'text'}
      onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
      helperText={f.description ?? (f.type === 'json' ? 'JSON' : undefined)}
      FormHelperTextProps={{ sx: { maxHeight: 40, overflow: 'hidden' } }}
    />
  );
}
