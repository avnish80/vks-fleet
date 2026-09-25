import { Loader, SectionBox, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Checkbox, FormControlLabel, TextField, Typography } from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link, useHistory } from 'react-router-dom';
import { certRotationPlan, controlPlaneReplicasPlan } from '../actions';
import { supervisorWriter } from '../api/headlampClient';
import { compliance, DEFAULT_BASELINE, evaluateBaseline, fixLink, RuleResult } from '../baseline';
import { clusterPath } from '../routes';
import { settingsStore } from '../settings/store';
import { Baseline, FleetCluster, SupervisorResult } from '../types';
import { useBackups } from '../useBackups';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile, useTone } from './charts';

function BaselineEditor({ baseline }: { baseline: Baseline }) {
  const set = (patch: Partial<Baseline>) => settingsStore.update({ baseline: { ...baseline, ...patch } });
  const [vmText, setVmText] = React.useState(baseline.vmClasses.join(', '));
  const [scText, setScText] = React.useState(baseline.storageClasses.join(', '));
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
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, gridColumn: '1 / -1' }}>
        <FormControlLabel control={<Checkbox checked={baseline.certificateRotation} onChange={e => set({ certificateRotation: e.target.checked })} />} label="Certificate rotation on" />
        <FormControlLabel control={<Checkbox checked={baseline.healthCheck} onChange={e => set({ healthCheck: e.target.checked })} />} label="Node health checks" />
        <FormControlLabel control={<Checkbox checked={baseline.latestClass} onChange={e => set({ latestClass: e.target.checked })} />} label="Newest cluster class" />
        <FormControlLabel control={<Checkbox checked={baseline.multiZone} onChange={e => set({ multiZone: e.target.checked })} />} label="Spread across zones" />
        <Button size="small" onClick={() => settingsStore.update({ baseline: DEFAULT_BASELINE })}>Reset to defaults</Button>
      </Box>
    </Box>
  );
}

type Fixing = { c: FleetCluster; r: SupervisorResult; kind: 'control-plane' | 'cert-rotation' };

export function BaselinePage() {
  const { config, results, refresh, canWrite } = useFleetData();
  const baseline = config.baseline!;
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; contextName: string } => !!t.contextName);
  const backups = useBackups(targets);
  const tone = useTone();
  const history = useHistory();
  const [fixing, setFixing] = React.useState<Fixing | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  if (results === null) return <Loader title="Loading clusters" />;

  const fleetZones = new Set(clusters.flatMap(c => c.machines.map(m => m.failureDomain)).filter(Boolean)).size;
  const resultOf = new Map(results.flatMap(r => r.clusters.map(c => [c.key, r] as [string, SupervisorResult])));
  const rows = clusters.map(c => {
    const rules = evaluateBaseline(c, baseline, fleetZones, backups?.get(c.key));
    return { c, rules, score: compliance(rules) };
  });
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
        <BaselineEditor baseline={baseline} />
      </SectionBox>

      <SectionBox title="Compliance">
        <Box sx={{ overflowX: 'auto' }}>
          <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: '4px', minWidth: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <Box component="th" sx={{ textAlign: 'left', p: 1 }}>Cluster</Box>
                <Box component="th" sx={{ textAlign: 'left', p: 1 }}>Score</Box>
                {ruleIds.map(r => (
                  <Box component="th" key={r.id} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>{r.title}</Box>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows
                .sort((a, b) => a.score.pct - b.score.pct || a.c.name.localeCompare(b.c.name))
                .map(({ c, rules, score }) => (
                  <tr key={c.key}>
                    <Box component="td" sx={{ p: 1, whiteSpace: 'nowrap' }}>
                      <Link to={clusterPath(c)}>{c.name}</Link>
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
                            <Button size="small" onClick={() => setFixing({ c, r: resultOf.get(c.key)!, kind: r.fix!.kind as Fixing['kind'] })}>
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
          Hover a cell for current and expected values. "?" means it couldn't be checked (for example, backups need a
          sign-in to the cluster).
        </Typography>
      </SectionBox>

      {fixing && (
        <ActionDialog
          plan={
            fixing.kind === 'control-plane'
              ? controlPlaneReplicasPlan(fixing.c, baseline.controlPlaneReplicas)
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
