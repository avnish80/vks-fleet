import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, TextField, Typography } from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link, useHistory } from 'react-router-dom';
import { certRotationPlan, controlPlaneReplicasPlan } from '../actions';
import { supervisorWriter } from '../api/headlampClient';
import { compliance, DEFAULT_BASELINE, evaluateBaseline, fixLink, profileFor, RuleResult } from '../baseline';
import { clusterPath } from '../routes';
import { settingsStore } from '../settings/store';
import { Baseline, BaselineProfile, FleetCluster, SupervisorResult } from '../types';
import { usePackages } from '../usePackages';
import { useClusterScans } from '../useClusterScans';
import { useBackups } from '../useBackups';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile, useTone } from './charts';

function BaselineEditor({ baseline, onChange, onReset }: { baseline: Baseline; onChange: (b: Baseline) => void; onReset?: () => void }) {
  const set = (patch: Partial<Baseline>) => onChange({ ...baseline, ...patch });
  const [vmText, setVmText] = React.useState(baseline.vmClasses.join(', '));
  const [scText, setScText] = React.useState(baseline.storageClasses.join(', '));
  const [pkgText, setPkgText] = React.useState(baseline.requiredPackages.join(', '));
  const list = (t: string) => t.split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 2 }}>
      <TextField select SelectProps={{ native: true }} size="small" label="Control plane" value={baseline.controlPlaneReplicas}
        onChange={e => set({ controlPlaneReplicas: Number(e.target.value) })}>
        <option value={3}>3 nodes (highly available)</option>
        <option value={1}>1 node is fine</option>
      </TextField>
      <TextField size="small" type="number" label="Minimum nodes per worker pool" value={baseline.minPoolNodes}
        onChange={e => set({ minPoolNodes: Math.max(0, Number(e.target.value) || 0) })} />
      <TextField size="small" type="number" label="Minor versions behind allowed" value={baseline.maxMinorsBehind}
        onChange={e => set({ maxMinorsBehind: Math.max(0, Number(e.target.value) || 0) })} />
      <TextField size="small" type="number" label="Backup within (hours, 0 = don't check)" value={baseline.backupWithinHours}
        onChange={e => set({ backupWithinHours: Math.max(0, Number(e.target.value) || 0) })} />
      <TextField size="small" label="Allowed VM classes (empty = any)" value={vmText}
        onChange={e => { setVmText(e.target.value); set({ vmClasses: list(e.target.value) }); }} />
      <TextField size="small" label="Allowed storage classes (empty = any)" value={scText}
        onChange={e => { setScText(e.target.value); set({ storageClasses: list(e.target.value) }); }} />
      <TextField size="small" label="Target Kubernetes minor, e.g. 1.36 (empty = off)" value={baseline.targetMinor}
        onChange={e => set({ targetMinor: e.target.value.trim().replace(/^v/, '') })} />
      <TextField size="small" label="Required packages, e.g. cert-manager, fluent-bit>=3.2" value={pkgText}
        onChange={e => { setPkgText(e.target.value); set({ requiredPackages: e.target.value.split(',').map(x => x.trim()).filter(Boolean) }); }} />
      <TextField select SelectProps={{ native: true }} size="small" label="Pod Security default at least" value={baseline.podSecurity}
        onChange={e => set({ podSecurity: e.target.value as Baseline['podSecurity'] })}>
        <option value="">not checked</option>
        <option value="baseline">baseline</option>
        <option value="restricted">restricted</option>
      </TextField>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, gridColumn: '1 / -1' }}>
        <FormControlLabel control={<Checkbox checked={baseline.certificateRotation} onChange={e => set({ certificateRotation: e.target.checked })} />} label="Certificate rotation on" />
        <FormControlLabel control={<Checkbox checked={baseline.healthCheck} onChange={e => set({ healthCheck: e.target.checked })} />} label="Node health checks" />
        <FormControlLabel control={<Checkbox checked={baseline.latestClass} onChange={e => set({ latestClass: e.target.checked })} />} label="Newest cluster class" />
        <FormControlLabel control={<Checkbox checked={baseline.multiZone} onChange={e => set({ multiZone: e.target.checked })} />} label="Spread across zones" />
        {onReset && <Button size="small" onClick={onReset}>Reset to defaults</Button>}
      </Box>
    </Box>
  );
}

type Fixing = { c: FleetCluster; r: SupervisorResult; kind: 'control-plane' | 'cert-rotation'; baseline: Baseline };

const csv = (xs?: string[]) => (xs ?? []).join(', ');
const fromCsv = (t: string) => t.split(',').map(x => x.trim()).filter(Boolean);

/** The default standard and the named profiles, one at a time. */
function ProfilesEditor({ baseline, profiles, counts }: { baseline: Baseline; profiles: BaselineProfile[]; counts: Map<string, number> }) {
  const [editing, setEditing] = React.useState<string>('default');
  const current = profiles.find(p => p.name === editing);
  const save = (next: BaselineProfile[]) => settingsStore.update({ baselineProfiles: next });
  const update = (patch: Partial<BaselineProfile>) => current && save(profiles.map(p => (p.name === current.name ? { ...p, ...patch } : p)));
  const add = () => {
    let name = 'prod';
    for (let i = 2; profiles.some(p => p.name === name) || name === 'default'; i++) name = `profile-${i}`;
    save([...profiles, { name, match: { labels: [`env=${name}`] }, baseline: { ...baseline } }]);
    setEditing(name);
  };
  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
        {['default', ...profiles.map(p => p.name)].map(n => (
          <Button key={n} size="small" variant={editing === n ? 'contained' : 'outlined'} onClick={() => setEditing(n)} sx={{ textTransform: 'none' }}>
            {n} <Box component="span" sx={{ ml: 0.75, opacity: 0.75 }}>({counts.get(n) ?? 0})</Box>
          </Button>
        ))}
        <Button size="small" onClick={add}>+ Profile</Button>
        <Typography variant="caption" color="text.secondary">
          Each cluster gets the first profile whose match fits it (in this order), else the default.
        </Typography>
      </Box>
      {current ? (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 2, mb: 2 }}>
            <TextField size="small" label="Profile name" defaultValue={current.name} key={`n-${current.name}`}
              onBlur={e => { const n = e.target.value.trim(); if (n && n !== current.name && n !== 'default' && !profiles.some(p => p.name === n)) { update({ name: n }); setEditing(n); } }} />
            <TextField size="small" label="Cluster labels (key=value)" defaultValue={csv(current.match.labels)} key={`l-${current.name}`}
              onChange={e => update({ match: { ...current.match, labels: fromCsv(e.target.value) } })} />
            <TextField size="small" label="Cluster names (* wildcards)" defaultValue={csv(current.match.clusters)} key={`c-${current.name}`}
              onChange={e => update({ match: { ...current.match, clusters: fromCsv(e.target.value) } })} />
            <TextField size="small" label="Namespaces (* wildcards)" defaultValue={csv(current.match.namespaces)} key={`s-${current.name}`}
              onChange={e => update({ match: { ...current.match, namespaces: fromCsv(e.target.value) } })} />
            <TextField size="small" label="Orgs" defaultValue={csv(current.match.orgs)} key={`o-${current.name}`}
              onChange={e => update({ match: { ...current.match, orgs: fromCsv(e.target.value) } })} />
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Button size="small" color="error" onClick={() => { save(profiles.filter(p => p.name !== current.name)); setEditing('default'); }}>
                Delete profile
              </Button>
            </Box>
          </Box>
          <BaselineEditor key={`b-${current.name}`} baseline={current.baseline} onChange={b => update({ baseline: b })} />
        </>
      ) : (
        <BaselineEditor key="b-default" baseline={baseline} onChange={b => settingsStore.update({ baseline: b })} onReset={() => settingsStore.update({ baseline: DEFAULT_BASELINE })} />
      )}
    </Box>
  );
}

export function BaselinePage() {
  const { config, results, refresh, canWrite } = useFleetData();
  const baseline = config.baseline!;
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; contextName: string } => !!t.contextName);
  const backups = useBackups(targets);
  const profiles = config.baselineProfiles ?? [];
  const all = [baseline, ...profiles.map(p => p.baseline)];
  const needPackages = all.some(b => b.requiredPackages.length);
  const needPsa = all.some(b => b.podSecurity);
  const packages = usePackages(needPackages ? targets : []);
  const scans = useClusterScans(
    needPsa ? clusters.map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName })).filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName) : [],
    baseline.allowedRegistries
  );
  const [detail, setDetail] = React.useState<string | null>(null);
  const tone = useTone();
  const history = useHistory();
  const [fixing, setFixing] = React.useState<Fixing | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  if (results === null) return <Loader title="Loading clusters" />;

  const fleetZones = new Set(clusters.flatMap(c => c.machines.map(m => m.failureDomain)).filter(Boolean)).size;
  const resultOf = new Map(results.flatMap(r => r.clusters.map(c => [c.key, r] as [string, SupervisorResult])));
  const rows = clusters.map(c => {
    const prof = profileFor(c, profiles, baseline);
    const rules = evaluateBaseline(c, prof.baseline, fleetZones, backups?.get(c.key), new Date(), {
      packages: packages?.get(c.key)?.items,
      psaDefault: (scans ?? []).find(x => x.clusterKey === c.key)?.psaDefault,
    });
    return { c, rules, score: compliance(rules), profile: prof.name, standard: prof.baseline };
  });
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.profile, (counts.get(r.profile) ?? 0) + 1);
  const detailRow = rows.find(r => r.c.key === detail);
  const ruleIds = rows[0]?.rules.map(r => ({ id: r.id, title: r.title })) ?? [];
  const drifting = rows.filter(r => r.score.drift > 0).length;
  const overall = rows.length ? Math.round(rows.reduce((n, r) => n + r.score.pct, 0) / rows.length) : 100;

  const cellColour = (r: RuleResult) =>
    r.status === 'ok' ? tone('success') : r.status === 'drift' ? tone('warning') : tone('neutral');

  return (
    <>
      <ChartStyles />
      <SectionBox title="Fleet baseline">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The standard every cluster should meet, and where each one drifts. Drift that can be fixed safely has a Fix
          button (with the usual checks and dry run); the rest link to the dialog that handles it. The standard is kept
          with the plugin settings, so an administrator can preset it in config.json.
        </Typography>
        {notice && (
          <Typography sx={{ mb: 2 }} color="success.main">
            {notice}
          </Typography>
        )}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 2, mb: 3 }}>
          <KpiTile label="Compliance" value={`${overall}%`} sub="average across clusters" tone={overall >= 90 ? 'success' : overall >= 70 ? 'warning' : 'error'} meter={{ value: overall, max: 100 }} />
          <KpiTile label="Drifting clusters" value={drifting} sub={`of ${rows.length}`} tone={drifting ? 'warning' : 'success'} />
          <KpiTile label="Rules" value={ruleIds.length} sub="checked per cluster" tone="info" />
        </Box>
        <ProfilesEditor baseline={baseline} profiles={profiles} counts={counts} />
      </SectionBox>

      <SectionBox title="Compliance">
        <Box sx={{ overflowX: 'auto' }}>
          <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: '4px', minWidth: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <Box component="th" sx={{ textAlign: 'left', p: 1 }}>Cluster</Box>
                <Box component="th" sx={{ textAlign: 'left', p: 1 }}>Profile</Box>
                <Box component="th" sx={{ textAlign: 'left', p: 1 }}>Score</Box>
                {ruleIds.map(r => (
                  <Box component="th" key={r.id} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>{r.title}</Box>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows
                .sort((a, b) => a.score.pct - b.score.pct || a.c.name.localeCompare(b.c.name))
                .map(({ c, rules, score, profile, standard }) => (
                  <tr key={c.key}>
                    <Box component="td" sx={{ p: 1, whiteSpace: 'nowrap' }}>
                      <Button size="small" onClick={() => setDetail(c.key)} sx={{ textTransform: 'none', fontWeight: 700, p: 0, minWidth: 0 }} title="Desired vs actual">
                        {c.name}
                      </Button>
                    </Box>
                    <Box component="td" sx={{ p: 1, whiteSpace: 'nowrap' }}>
                      <Typography variant="body2">{profile}</Typography>
                    </Box>
                    <Box component="td" sx={{ p: 1 }}>
                      <StatusLabel status={score.pct >= 90 ? 'success' : score.pct >= 70 ? 'warning' : 'error'}>{`${score.pct}%`}</StatusLabel>
                    </Box>
                    {rules.map(r => {
                      const link = r.fix ? fixLink(c, r.fix) : undefined;
                      return (
                        <Box
                          component="td"
                          key={r.id}
                          title={`${r.title}\nNow: ${r.current}\nExpected: ${r.expected}`}
                          sx={{ p: 1, borderRadius: 1, bgcolor: 'action.hover', borderLeft: '4px solid', borderLeftColor: cellColour(r), verticalAlign: 'top', minWidth: 130 }}
                        >
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {r.status === 'ok' ? 'OK' : r.status === 'drift' ? 'Drift' : r.status === 'off' ? 'Off' : '?'}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                            {r.current}
                          </Typography>
                          {r.fix && r.fix.kind !== 'link' && canWrite(resultOf.get(c.key)!.supervisor.id) && (
                            <Button size="small" onClick={() => setFixing({ c, r: resultOf.get(c.key)!, kind: r.fix!.kind as Fixing['kind'], baseline: standard })}>
                              Fix
                            </Button>
                          )}
                          {link && (
                            <Button size="small" onClick={() => history.push(link)}>
                              {r.fix?.kind === 'link' ? r.fix.label : 'Fix'}
                            </Button>
                          )}
                        </Box>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Click a cluster for desired vs actual. "?" means it couldn't be checked (for example, backups need a sign-in to the
          cluster).
        </Typography>
      </SectionBox>

      {detailRow && (
        <Dialog open onClose={() => setDetail(null)} maxWidth="md" fullWidth>
          <DialogTitle>
            {detailRow.c.name}: desired vs actual{' '}
            <Typography component="span" variant="body2" color="text.secondary">
              profile {detailRow.profile}, {detailRow.score.pct}% ({detailRow.score.drift} drifting)
            </Typography>
          </DialogTitle>
          <DialogContent>
            <SimpleTable
              columns={[
                { label: 'Rule', getter: (r: RuleResult) => <b>{r.title}</b> },
                { label: 'Desired', getter: (r: RuleResult) => r.expected },
                { label: 'Actual', getter: (r: RuleResult) => <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{r.current}</Typography> },
                { label: '', getter: (r: RuleResult) => <StatusLabel status={r.status === 'ok' ? 'success' : r.status === 'drift' ? 'error' : ''}>{r.status === 'ok' ? 'matches' : r.status === 'drift' ? 'drift' : r.status === 'off' ? 'off' : 'unknown'}</StatusLabel> },
                {
                  label: '',
                  getter: (r: RuleResult) => {
                    const link = r.fix ? fixLink(detailRow.c, r.fix) : undefined;
                    return link ? (
                      <Button size="small" onClick={() => history.push(link)}>
                        {r.fix?.kind === 'link' ? r.fix.label : 'Fix'}
                      </Button>
                    ) : r.fix && canWrite(resultOf.get(detailRow.c.key)!.supervisor.id) ? (
                      <Button size="small" onClick={() => { setFixing({ c: detailRow.c, r: resultOf.get(detailRow.c.key)!, kind: r.fix!.kind as Fixing['kind'], baseline: detailRow.standard }); setDetail(null); }}>
                        Fix
                      </Button>
                    ) : null;
                  },
                },
              ]}
              data={[...detailRow.rules].sort((a, b) => ['drift', 'unknown', 'ok', 'off'].indexOf(a.status) - ['drift', 'unknown', 'ok', 'off'].indexOf(b.status))}
            />
          </DialogContent>
          <DialogActions>
            <Button component={Link} to={clusterPath(detailRow.c)}>Open cluster</Button>
            <Button onClick={() => setDetail(null)}>Close</Button>
          </DialogActions>
        </Dialog>
      )}
      {fixing && (
        <ActionDialog
          plan={
            fixing.kind === 'control-plane'
              ? controlPlaneReplicasPlan(fixing.c, fixing.baseline.controlPlaneReplicas)
              : certRotationPlan(fixing.c)
          }
          writer={supervisorWriter(fixing.r.supervisor)}
          onClose={() => setFixing(null)}
          onApplied={m => {
            setNotice(m);
            refresh();
          }}
        />
      )}
    </>
  );
}
