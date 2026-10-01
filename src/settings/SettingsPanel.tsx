import { Alert, Box, Button, Checkbox, FormControlLabel, MenuItem, Paper, Radio, RadioGroup, TextField, Typography } from '@mui/material';
import { MAX_PER_CLUSTER, MAX_TOTAL, requestStats } from '../api/limiter';
import React, { ReactNode } from 'react';
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
import { headlampClient, listHeadlampClusters } from '../api/headlampClient';
import { usePolling } from '../usePolling';
import { discoverVcfaOrgs } from '../vcfa';
import { fetchVcenterStatus, STALE_MINUTES } from '../vcenterStatus';
import { adminTwins, changesMode, changesPatch, Level, probeContext, probeSupervisor, SupervisorProbe } from '../settingsStatus';
import { useManagedConfig } from './managed';
import { settingsStore, useRawSettings } from './store';

type Draft = Partial<SupervisorConfig>;

const ICON: Record<Level, { mark: string; colour: string }> = {
  ok: { mark: '✓', colour: 'success.main' },
  warn: { mark: '!', colour: 'warning.main' },
  error: { mark: '✕', colour: 'error.main' },
  pending: { mark: '·', colour: 'text.secondary' },
};

function Mark({ level }: { level: Level }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', width: 18, height: 18, borderRadius: '50%', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: 'common.white', bgcolor: ICON[level].colour, flexShrink: 0 }}>
      {ICON[level].mark}
    </Box>
  );
}

function StatusLine({ level, text, fix }: { level: Level; text: string; fix?: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 0.75 }}>
      <Mark level={level} />
      <Typography variant="body2">
        <b>{text}</b>
        {fix && level !== 'ok' && (
          <Box component="span" sx={{ color: 'text.secondary' }}>
            {' '}
            {fix}
          </Box>
        )}
      </Typography>
    </Box>
  );
}

function Section({ title, blurb, children }: { title: string; blurb?: string; children: ReactNode }) {
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" sx={{ fontSize: '1.05rem', fontWeight: 700, mb: 0.25 }}>
        {title}
      </Typography>
      {blurb && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          {blurb}
        </Typography>
      )}
      {children}
    </Box>
  );
}

/** A context picker: Headlamp's clusters, or free text when the list can't be read. */
function ContextField({ label, value, contexts, onChange, helperText, placeholder, required }: { label: string; value: string; contexts: string[]; onChange: (v: string) => void; helperText?: string; placeholder?: string; required?: boolean }) {
  if (!contexts.length) {
    return <TextField fullWidth size="small" label={label} value={value} placeholder={placeholder} helperText={helperText} required={required} onChange={e => onChange(e.target.value.trim())} />;
  }
  const options = value && !contexts.includes(value) ? [value, ...contexts] : contexts;
  return (
    <TextField fullWidth select size="small" label={label} value={value} helperText={helperText} required={required} onChange={e => onChange(String(e.target.value))}>
      {!required && <MenuItem value="">(none)</MenuItem>}
      {options.map(c => (
        <MenuItem key={c} value={c}>
          {c}
          {!contexts.includes(c) ? ' (not in Headlamp)' : ''}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** One Supervisor: the context, a name, its status, org names, and the rarely needed fields under Advanced. */
function SupervisorForm({
  value,
  index,
  duplicateId,
  contexts,
  probe,
  onChange,
  onRemove,
}: {
  value: Draft;
  index: number;
  duplicateId: boolean;
  contexts: string[];
  probe?: SupervisorProbe;
  onChange: (next: Draft) => void;
  onRemove: () => void;
}) {
  const [advanced, setAdvanced] = React.useState(false);
  const [namespacesText, setNamespacesText] = React.useState((value.namespaces ?? []).join(', '));
  const [namesText, setNamesText] = React.useState(formatTenantNames(value.tenantNames));
  const id = value.id ?? '';
  const idError = id !== '' && !isValidSupervisorId(id);
  const save = (patch: Draft) => onChange({ ...value, ...patch });
  const vcfa = value.mode === 'vcfa';
  const orgIds = Array.from(new Set([...(probe?.orgIds ?? []), ...Object.keys(value.tenantNames ?? {})])).sort();

  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 1.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        {probe && <Mark level={probe.level} />}
        <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
          {value.displayName?.trim() || value.id || value.headlampCluster || `Supervisor ${index + 1}`}
          {probe && (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
              {probe.text}
            </Typography>
          )}
        </Typography>
        <Button size="small" color="error" onClick={onRemove}>
          Remove
        </Button>
      </Box>
      {probe && probe.level !== 'ok' && probe.fix && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: -1 }}>
          {probe.fix}
        </Typography>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
        <ContextField
          label={vcfa ? 'Headlamp context (VCF Automation)' : 'Headlamp cluster for the Supervisor'}
          value={value.headlampCluster ?? ''}
          contexts={contexts}
          onChange={v => save({ headlampCluster: v })}
          required
        />
        <TextField size="small" label="Display name" placeholder="e.g. sg-az1" value={value.displayName ?? ''} onChange={e => save({ displayName: e.target.value })} />
      </Box>
      {!vcfa && (value.tenantLabelKey ?? DEFAULT_TENANT_LABEL) !== '' && (
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 700, mb: 0.5 }}>
            Org names
          </Typography>
          {orgIds.length ? (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 320px) 1fr', gap: 1, alignItems: 'center' }}>
              {orgIds.map(oid => (
                <React.Fragment key={oid}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', color: 'text.secondary', overflow: 'hidden', textOverflow: 'ellipsis' }} title={oid}>
                    {oid}
                  </Typography>
                  <TextField
                    size="small"
                    placeholder="name, e.g. finance"
                    value={value.tenantNames?.[oid] ?? ''}
                    onChange={e => {
                      const names = { ...(value.tenantNames ?? {}) };
                      if (e.target.value.trim()) names[oid] = e.target.value;
                      else delete names[oid];
                      setNamesText(formatTenantNames(names));
                      save({ tenantNames: names });
                    }}
                  />
                </React.Fragment>
              ))}
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {probe?.level === 'ok' ? 'No org IDs found on its namespaces.' : 'The orgs appear here once the Supervisor can be read.'}
            </Typography>
          )}
        </Box>
      )}
      <Box>
        <Button size="small" onClick={() => setAdvanced(!advanced)} sx={{ px: 0 }}>
          {advanced ? '▾ Advanced' : '▸ Advanced'}
        </Button>
      </Box>
      {advanced && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75 }}>
          <TextField
            label="Supervisor ID"
            helperText={
              duplicateId
                ? 'Another Supervisor already uses this ID. IDs must be unique.'
                : idError
                ? 'Use lowercase letters, numbers, dots and dashes.'
                : "Used in links to clusters. Set it once and don't change it; empty uses the cluster name."
            }
            error={idError || duplicateId}
            value={id}
            onChange={e => save({ id: e.target.value.trim() })}
            size="small"
          />
          <TextField
            label="Namespaces"
            helperText="Comma-separated. Only when the account can't list clusters across all namespaces."
            value={namespacesText}
            onChange={e => {
              setNamespacesText(e.target.value);
              save({ namespaces: parseNamespaces(e.target.value) });
            }}
            size="small"
          />
          {!vcfa && (
            <>
              <TextField
                label="Tenant label key"
                helperText={`The namespace label that identifies the org. VCF Automation sets ${DEFAULT_TENANT_LABEL}; empty treats each namespace as its own org.`}
                value={value.tenantLabelKey ?? DEFAULT_TENANT_LABEL}
                onChange={e => save({ tenantLabelKey: e.target.value.trim() })}
                size="small"
              />
              <TextField
                label="Org names as text"
                multiline
                minRows={2}
                placeholder={'66666666-7777-4888-8999-000000000000 = finance'}
                helperText="One per line: org ID = name. For orgs the list above can't find."
                value={namesText}
                onChange={e => {
                  setNamesText(e.target.value);
                  save({ tenantNames: parseTenantNames(e.target.value) });
                }}
                size="small"
              />
            </>
          )}
        </Box>
      )}
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
  const [showDiagnostics, setShowDiagnostics] = React.useState(false);

  const managed = useManagedConfig();
  const clusterList = usePolling('settings-contexts', listHeadlampClusters, 60);
  const contexts = (clusterList ?? []).map(c => c.name).sort();
  const discovered = clusterList ? discoverVcfaOrgs(clusterList) : [];
  const newOrgs = discovered.filter(d => !supervisors.some(x => x.id === d.id || x.headlampCluster === d.headlampCluster));
  const write = (list: Draft[]) => settingsStore.update({ supervisors: list as SupervisorConfig[] });
  const idOf = (s: Draft) => (s.id?.trim() || s.headlampCluster?.trim().toLowerCase() || '');
  const ids = supervisors.map(idOf);
  const effective = supervisors.length ? supervisors : ((managed?.supervisors ?? []) as Draft[]);
  const mode = changesMode({ readOnly: raw.readOnly || managed?.readOnly, elevation: raw.elevation });
  const suffix = raw.elevation?.suffix || '-admin';

  // Setup checks (every minute): Supervisors, VCF Automation org contexts, the collector.
  const probeKey = JSON.stringify([effective.map(s => [s.headlampCluster, s.mode, s.tenantLabelKey]), newOrgs.map(o => o.headlampCluster), raw.vcenter, contexts.length]);
  const probes = usePolling(
    `settings-probes|${probeKey}`,
    async () => {
      const sv = await Promise.all(
        effective.map(s =>
          s.mode === 'vcfa'
            ? probeContext(headlampClient(s.headlampCluster ?? ''), s.headlampCluster ?? '')
            : probeSupervisor(headlampClient(s.headlampCluster ?? ''), s.headlampCluster ?? '', contexts, s.tenantLabelKey ?? DEFAULT_TENANT_LABEL)
        )
      );
      const orgs = await Promise.all(newOrgs.map(o => probeContext(headlampClient(o.headlampCluster ?? ''), o.org ?? o.headlampCluster ?? '')));
      const collector = raw.vcenter?.context ? await fetchVcenterStatus(headlampClient(raw.vcenter.context), raw.vcenter.namespace || 'vks-fleet', raw.vcenter.configMap || 'vks-fleet-vcenter') : undefined;
      return { sv, orgs, collector };
    },
    60
  );
  const twins = adminTwins(
    contexts,
    suffix,
    effective.map(s => ({ context: s.headlampCluster ?? '', admin: s.adminContext })),
    discovered.map(d => d.headlampCluster ?? ''),
    probes ? probes.sv.flatMap(p => (p as SupervisorProbe).clusterNames ?? []) : undefined
  );

  const status: Array<{ level: Level; text: string; fix?: string }> = [];
  if (raw.demo) status.push({ level: 'warn', text: 'Demo mode is on: every page shows the demo fleet.', fix: 'Turn it off under Display.' });
  if (!effective.length) status.push({ level: 'pending', text: 'No Supervisor yet.', fix: 'Add one below.' });
  effective.forEach((s, i) => {
    const p = probes?.sv[i];
    status.push(p ? { ...p, text: `${s.displayName || s.headlampCluster || 'Supervisor'}: ${p.text}` } : { level: 'pending', text: `${s.displayName || s.headlampCluster}: checking…` });
  });
  newOrgs.forEach((o, i) => {
    const p = probes?.orgs[i];
    if (p && p.level !== 'ok') status.push({ ...p, text: `${o.org} (VCF Automation, not added): ${p.text.replace(/^[^:]*: /, '')}` });
  });
  if (raw.vcenter?.context) {
    const c = probes?.collector;
    status.push(
      !c
        ? { level: 'pending', text: 'vCenter collector: checking…' }
        : c.error
        ? { level: 'error', text: `vCenter collector: ${c.error}`, fix: 'Check the context and that the collector runs.' }
        : (c.ageMinutes ?? 0) > STALE_MINUTES
        ? { level: 'warn', text: `vCenter collector: last written ${c.ageMinutes} minutes ago`, fix: 'The collector may have stopped (its CronJob or timer).' }
        : { level: 'ok', text: `vCenter collector: last written ${c.ageMinutes} min ago` }
    );
  }
  if (mode === 'elevate' && contexts.length) {
    const missing = twins.supervisors.filter(x => !x.found);
    status.push(
      missing.length
        ? { level: 'warn', text: `Elevation: no admin context ${missing.map(x => x.admin).join(', ')}`, fix: 'Sign in the admin account under that name (the refresh script does), or set the change context below.' }
        : { level: 'ok', text: `Elevation: admin contexts found for ${twins.supervisors.length} Supervisor${twins.supervisors.length === 1 ? '' : 's'} and ${twins.clustersWith} cluster${twins.clustersWith === 1 ? '' : 's'}` }
    );
    if (twins.clustersWithout.length) status.push({ level: 'warn', text: `Elevation: no admin context for ${twins.clustersWithout.slice(0, 4).join(', ')}${twins.clustersWithout.length > 4 ? ` and ${twins.clustersWithout.length - 4} more` : ''}`, fix: `Changes to those clusters would fail while elevated (they need <name>${suffix}).` });
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', maxWidth: 820 }}>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Typography sx={{ fontWeight: 800, mb: 1 }}>Setup status</Typography>
        {status.map((x, i) => (
          <StatusLine key={i} {...x} />
        ))}
      </Paper>

      <Section title="Supervisors" blurb="Each Supervisor your VKS clusters run on. Headlamp needs a cluster entry (kubeconfig context) for it, from kubectl vsphere login.">
        {managed && (
          <Alert
            severity="info"
            sx={{ mb: 1.5 }}
            action={
              supervisors.length === 0 ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    const list = (managed.supervisors ?? []) as Draft[];
                    write(list);
                    setKeys(list.map(() => nextKey.current++));
                  }}
                >
                  Copy to edit
                </Button>
              ) : (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    write([]);
                    setKeys([]);
                  }}
                >
                  Use administrator settings
                </Button>
              )
            }
          >
            {supervisors.length === 0
              ? `Your administrator preset ${managed.supervisors?.length ?? 0} Supervisor${(managed.supervisors?.length ?? 0) === 1 ? '' : 's'}, and they're in use. Copy them here to change anything for this browser.`
              : 'This browser uses its own settings instead of the administrator preset.'}
          </Alert>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {supervisors.map((s, i) => (
            <SupervisorForm
              key={keys[i] ?? i}
              value={s}
              index={i}
              duplicateId={!!ids[i] && ids.indexOf(ids[i]) !== i}
              contexts={contexts.filter(c => !c.endsWith(suffix) || c === s.headlampCluster)}
              probe={probes?.sv[i] as SupervisorProbe | undefined}
              onChange={next => write(supervisors.map((x, j) => (j === i ? next : x)))}
              onRemove={() => {
                write(supervisors.filter((_, j) => j !== i));
                setKeys(keys.filter((_, j) => j !== i));
              }}
            />
          ))}
        </Box>
        <Box sx={{ mt: 1.5 }}>
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
        {newOrgs.length > 0 && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              VCF Automation org contexts found (from <code>vcf context create</code>). Adding one shows that org's clusters with the
              org user's own rights:
            </Typography>
            {newOrgs.map((d, i) => {
              const p = probes?.orgs[i];
              return (
                <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  {p && <Mark level={p.level} />}
                  <Typography variant="body2">
                    <b>{d.org}</b>: {d.namespaces.join(', ')}
                    {p && p.level !== 'ok' && (
                      <Box component="span" sx={{ color: 'text.secondary' }}>
                        {' '}
                        ({p.text.replace(/^[^:]*: /, '')})
                      </Box>
                    )}
                  </Typography>
                  <Button
                    size="small"
                    onClick={() => {
                      write([...supervisors, d as Draft]);
                      setKeys([...keys, nextKey.current++]);
                    }}
                  >
                    Add
                  </Button>
                </Box>
              );
            })}
            {supervisors.length === 0 && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                With no Supervisors configured, these orgs are used automatically.
              </Typography>
            )}
          </Alert>
        )}
      </Section>

      <Section
        title="vCenter collector (optional)"
        blurb="The collector reads vCenter (status, hosts, alarms, utilisation, VM placement) and saves it as a ConfigMap. Choose where it saves: a platform-owned Supervisor namespace needs no extra cluster; a management cluster, or the cluster Headlamp runs in, also work. Not a tenant's namespace: its users could read it. Leave the context empty if you don't run the collector."
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 1.5 }}>
          <ContextField
            label="Context"
            value={raw.vcenter?.context ?? ''}
            contexts={contexts.filter(c => !c.endsWith(suffix))}
            onChange={v => settingsStore.update({ vcenter: { namespace: 'vks-fleet', configMap: 'vks-fleet-vcenter', ...(raw.vcenter ?? {}), context: v } })}
          />
          <TextField size="small" label="Namespace" value={raw.vcenter?.namespace ?? 'vks-fleet'} onChange={e => settingsStore.update({ vcenter: { context: '', configMap: 'vks-fleet-vcenter', ...(raw.vcenter ?? {}), namespace: e.target.value } })} />
          <TextField size="small" label="ConfigMap" value={raw.vcenter?.configMap ?? 'vks-fleet-vcenter'} onChange={e => settingsStore.update({ vcenter: { context: '', namespace: 'vks-fleet', ...(raw.vcenter ?? {}), configMap: e.target.value } })} />
        </Box>
      </Section>

      <Section title="Changes" blurb="What the plugin may change. Every change still shows its checks and runs a dry run first.">
        <RadioGroup
          value={mode}
          onChange={(e: { target: { value: string } }) => settingsStore.update(changesPatch(e.target.value as 'allow' | 'elevate' | 'readonly', raw.elevation))}
        >
          <FormControlLabel value="allow" disabled={managed?.readOnly === true} control={<Radio size="small" />} label={<span><b>Allow changes</b>: actions use the signed-in account, as its rights allow.</span>} />
          <FormControlLabel value="elevate" disabled={managed?.readOnly === true} control={<Radio size="small" />} label={<span><b>Read by default, elevate to change</b>: viewing uses a read-only sign-in; changes need Elevate (top bar), with a reason and a time limit, and go through an admin sign-in.</span>} />
          <FormControlLabel value="readonly" control={<Radio size="small" />} label={<span><b>Read-only</b>: never offer actions{managed?.readOnly === true ? ' (set by your administrator)' : ''}.</span>} />
        </RadioGroup>
        {mode === 'elevate' && (
          <Paper variant="outlined" sx={{ p: 1.5, mt: 1, borderRadius: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Typography variant="body2" color="text.secondary">
              Admin sign-ins are separate contexts named like the read ones plus a suffix (kubernetes-cluster-c3d4 → kubernetes-cluster-c3d4{suffix}).
              The refresh script (deploy/jump-server/vks-refresh.sh) signs in both accounts and names them this way.
            </Typography>
            <TextField size="small" label="Suffix of admin contexts" value={raw.elevation?.suffix ?? '-admin'} onChange={e => settingsStore.update({ elevation: { enabled: true, suffix: e.target.value } })} sx={{ maxWidth: 260 }} />
            {(raw.supervisors ?? []).map((sv, i) => {
              const t = twins.supervisors.find(x => x.context === sv.headlampCluster);
              return (
                <Box key={sv.headlampCluster ?? i} sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  {t && contexts.length > 0 && <Mark level={t.found ? 'ok' : 'warn'} />}
                  <Box sx={{ flex: 1, maxWidth: 460 }}>
                    <ContextField
                      label={`Change context for ${sv.displayName || sv.headlampCluster}`}
                      value={sv.adminContext ?? ''}
                      contexts={contexts}
                      placeholder={`${sv.headlampCluster}${suffix}`}
                      helperText={`Empty uses ${sv.headlampCluster}${suffix}.`}
                      onChange={v => settingsStore.update({ supervisors: (raw.supervisors ?? []).map((x, k) => (k === i ? { ...x, adminContext: v } : x)) })}
                    />
                  </Box>
                </Box>
              );
            })}
          </Paper>
        )}
        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Checkbox
              checked={raw.identitySwitch !== false && managed?.identitySwitch !== false}
              disabled={managed?.identitySwitch === false}
              onChange={e => settingsStore.update({ identitySwitch: e.target.checked })}
            />
          }
          label={`Offer "Signed in as" to switch between the accounts in this Headlamp's kubeconfig${managed?.identitySwitch === false ? ' (turned off by your administrator)' : ''}`}
        />
      </Section>

      <Section title="Display">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <LinksEditor value={raw.links ?? []} />
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
          <FormControlLabel
            control={<Checkbox checked={raw.demo === true} onChange={e => settingsStore.update({ demo: e.target.checked })} />}
            label="Demo mode: a fictional fleet instead of your Supervisors (nothing is ever changed; dry runs work). For trying it out, screenshots and talks."
          />
          {raw.demo === true && (
            <TextField
              select
              size="small"
              label="Demo fleet size"
              value={Number(raw.demoScale) || 4}
              onChange={e => settingsStore.update({ demoScale: Number(e.target.value) })}
              sx={{ maxWidth: 260, ml: 4 }}
              helperText="Clusters cloned from the four, to see every page at scale."
            >
              {[4, 12, 20, 50].map(n => (
                <MenuItem key={n} value={n}>
                  {n} clusters
                </MenuItem>
              ))}
            </TextField>
          )}
        </Box>
      </Section>

      <Box sx={{ mt: 3 }}>
        <Button size="small" onClick={() => setShowDiagnostics(!showDiagnostics)} sx={{ px: 0 }}>
          {showDiagnostics ? '▾ Diagnostics' : '▸ Diagnostics: requests per cluster, errors, response times'}
        </Button>
        {showDiagnostics && <Diagnostics />}
      </Box>
    </Box>
  );
}

/** Links to other Headlamp instances, one "Label = https://…" per line. */
function LinksEditor({ value }: { value: Array<{ label: string; url: string }> }) {
  const [text, setText] = React.useState(value.map(l => `${l.label} = ${l.url}`).join('\n'));
  return (
    <TextField
      label="Links to other views (one per line: Label = https://…)"
      placeholder={'Read-only view = https://fleet-ro.example.com\norg2 view = https://fleet-org2.example.com'}
      multiline
      minRows={2}
      size="small"
      value={text}
      onChange={e => {
        setText(e.target.value);
        const links = e.target.value
          .split('\n')
          .map(line => {
            const i = line.indexOf('=');
            return i > 0 ? { label: line.slice(0, i).trim(), url: line.slice(i + 1).trim() } : undefined;
          })
          .filter((l): l is { label: string; url: string } => !!l && !!l.label && /^https?:\/\//.test(l.url));
        settingsStore.update({ links });
      }}
      helperText="Shown as buttons in the bar at the top of every plugin page."
    />
  );
}

/** Requests per cluster since the page was opened: for judging load and spotting a slow or failing cluster. */
function Diagnostics() {
  const [, setTick] = React.useState(0);
  const st = requestStats();
  const minutes = Math.max(1, Math.round((Date.now() - st.since) / 60000));
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" sx={{ fontSize: '1rem', fontWeight: 600 }}>
        Diagnostics
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Requests the plugin made per cluster in the last {minutes} minute{minutes === 1 ? '' : 's'} (since this browser tab loaded
        Headlamp). At most {MAX_PER_CLUSTER} run at once per cluster and {MAX_TOTAL} overall; now {st.inFlight} running, {st.waiting} waiting.
        Refreshes pause while the tab is hidden.
      </Typography>
      <Button size="small" onClick={() => setTick(t => t + 1)}>
        Refresh
      </Button>
      {st.clusters.length > 0 && (
        <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem', mt: 1 }}>
          <thead>
            <tr>
              {['Cluster (context)', 'Requests', 'Per minute', 'Errors', 'Denied / not found', 'Average', 'Slowest', 'Last error'].map(h => (
                <Box component="th" key={h} sx={{ textAlign: 'left', p: 0.75, borderBottom: 1, borderColor: 'divider' }}>
                  {h}
                </Box>
              ))}
            </tr>
          </thead>
          <tbody>
            {st.clusters.map(c => (
              <tr key={c.cluster}>
                <Box component="td" sx={{ p: 0.75 }}>{c.cluster}</Box>
                <Box component="td" sx={{ p: 0.75 }}>{c.requests}</Box>
                <Box component="td" sx={{ p: 0.75 }}>{(c.requests / minutes).toFixed(1)}</Box>
                <Box component="td" sx={{ p: 0.75, color: c.errors ? 'error.main' : undefined }}>{c.errors}</Box>
                <Box component="td" sx={{ p: 0.75, color: 'text.secondary' }} title="Expected answers to probes (a tool not installed, a namespace not readable)">{c.expected ?? 0}</Box>
                <Box component="td" sx={{ p: 0.75 }}>{c.requests ? `${Math.round(c.totalMs / c.requests)} ms` : '—'}</Box>
                <Box component="td" sx={{ p: 0.75 }}>{c.slowestMs} ms</Box>
                <Box component="td" sx={{ p: 0.75, color: 'text.secondary', maxWidth: 360, overflowWrap: 'anywhere' }}>{c.lastError ?? ''}</Box>
              </tr>
            ))}
          </tbody>
        </Box>
      )}
    </Box>
  );
}

