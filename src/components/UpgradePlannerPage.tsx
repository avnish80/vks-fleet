import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link } from 'react-router-dom';
import { upgradePlan, upgradeProgress } from '../actions';
import { describeError } from '../api/client';
import { supervisorWriter } from '../api/headlampClient';
import {
  canStart,
  PlanEntry,
  readiness,
  Readiness,
  runState,
  suggestWaves,
  waveState,
  WaveState,
} from '../planner';
import { upgradeKind, upgradeTargets } from '../releases';
import { clusterPath } from '../routes';
import { FleetCluster, SupervisorResult } from '../types';
import { usePolling } from '../usePolling';
import { useWorkloadHealth } from '../useWorkload';
import { blockingPdbs } from './ActionDialog';
import { ChartStyles, KpiTile } from './charts';

const WAVES = [1, 2, 3, 4];

/** The plan is kept per browser, so it survives reloads while a rollout is in progress. */
const planStore = new ConfigStore<{ entries?: Record<string, PlanEntry> }>('vks-fleet-upgrade-plan');
const usePlanRaw = planStore.useConfig();

const READY: Record<Readiness['level'], { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  ready: { text: 'Ready', status: 'success' },
  warnings: { text: 'Ready with warnings', status: 'warning' },
  blocked: { text: 'Blocked', status: 'error' },
  nothing: { text: 'Nothing to do', status: '' },
};

const WAVE_STATE: Record<WaveState, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  empty: { text: 'Empty', status: '' },
  'not-started': { text: 'Not started', status: '' },
  running: { text: 'Running', status: 'warning' },
  done: { text: 'Done', status: 'success' },
  failed: { text: 'Failed', status: 'error' },
};

type Row = { c: FleetCluster; r: SupervisorResult; entry: PlanEntry; ready: Readiness };

type RunResult = { cluster: string; ok: boolean; message: string };

export function UpgradePlannerPage() {
  const { config, results, refresh, canWrite } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const stored = usePlanRaw()?.entries ?? {};
  const [open, setOpen] = React.useState<string | null>(null);
  const [runWave, setRunWave] = React.useState<number | null>(null);

  const ctxKey = clusters.map(c => `${c.key}=${workload.byKey.get(c.key)?.contextName ?? ''}`).join('|');
  const pdbs = usePolling(
    ctxKey || null,
    async () => {
      const out = new Map<string, string[]>();
      await Promise.all(
        clusters.map(async c => {
          const ctx = workload.byKey.get(c.key)?.contextName;
          if (!ctx) return;
          const r = await blockingPdbs(ctx);
          if (r.names) out.set(c.key, r.names);
        })
      );
      return out;
    },
    120
  );

  if (results === null) return <Loader title="Loading clusters" />;

  const resultOf = new Map(results.flatMap(r => r.clusters.map(c => [c.key, r] as [string, SupervisorResult])));
  const suggested = suggestWaves(clusters, c => resultOf.get(c.key)?.releases ?? []);
  const entryOf = (c: FleetCluster): PlanEntry => stored[c.key] ?? suggested.get(c.key) ?? { wave: 0, target: '', moveClass: false };
  const rows: Row[] = clusters.map(c => {
    const r = resultOf.get(c.key)!;
    const entry = entryOf(c);
    return { c, r, entry, ready: readiness(c, entry, r.releases ?? [], r.vmClasses ?? [], pdbs?.get(c.key)) };
  });
  const save = (c: FleetCluster, patch: Partial<PlanEntry>) =>
    planStore.update({ entries: { ...stored, [c.key]: { ...entryOf(c), ...patch } } });

  const waveMembers = (w: number) => rows.filter(x => x.entry.wave === w && x.entry.target);
  const states = new Map<number, WaveState>(WAVES.map(w => [w, waveState(waveMembers(w))]));
  const upgradable = rows.filter(x => upgradeTargets(x.c.kubernetesVersion, x.r.releases ?? []).length > 0);
  const inProgress = rows.filter(x => x.entry.target && runState(x.c, x.entry.target) === 'upgrading');

  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Upgrade planner"
        headerProps={{
          actions: [
            <Button key="reset" size="small" onClick={() => planStore.update({ entries: {} })}>
              Reset to suggested plan
            </Button>,
          ],
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Plan upgrades across the fleet in waves: a small canary first, then the rest. Each cluster gets the same
          checks as a single upgrade, plus whether its quota has room for the nodes a rolling upgrade adds. A wave can
          start only when the previous one has finished healthy. The plan is kept in this browser.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 2 }}>
          <KpiTile label="Can upgrade" value={upgradable.length} sub={`of ${rows.length} clusters`} tone="info" />
          <KpiTile label="Ready" value={rows.filter(x => x.entry.wave && x.ready.level === 'ready').length} sub="planned and clear" tone="success" />
          <KpiTile
            label="Blocked"
            value={rows.filter(x => x.entry.wave && x.ready.level === 'blocked').length}
            sub="fix before their wave"
            tone={rows.some(x => x.entry.wave && x.ready.level === 'blocked') ? 'error' : 'success'}
          />
          <KpiTile label="In progress" value={inProgress.length} sub="rolling now" tone={inProgress.length ? 'warning' : 'neutral'} />
        </Box>
      </SectionBox>

      <SectionBox title="Waves">
        {WAVES.filter(w => waveMembers(w).length).length === 0 ? (
          <Typography color="text.secondary">No clusters are planned. Put clusters into waves in the table below.</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {WAVES.map(w => {
              const members = waveMembers(w);
              if (!members.length) return null;
              const st = states.get(w)!;
              const gate = canStart(w, states);
              return (
                <Box key={w} sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
                    <Typography sx={{ fontWeight: 600 }}>
                      Wave {w}
                      {w === 1 ? ' (canary)' : ''}: {members.length} cluster{members.length === 1 ? '' : 's'}
                    </Typography>
                    <StatusLabel status={WAVE_STATE[st].status}>{WAVE_STATE[st].text}</StatusLabel>
                    {!gate.ok && st === 'not-started' && (
                      <Typography variant="body2" color="text.secondary">
                        {gate.reason}
                      </Typography>
                    )}
                    <Box sx={{ flex: 1 }} />
                    <Button
                      size="small"
                      variant="contained"
                      disabled={!gate.ok || st === 'done' || st === 'running' || !members.every(m => canWrite(m.r.supervisor.id))}
                      title={members.every(m => canWrite(m.r.supervisor.id)) ? undefined : 'Read-only access: upgrades are not allowed'}
                      onClick={() => setRunWave(w)}
                    >
                      Upgrade wave {w}
                    </Button>
                  </Box>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                    {members.map(m => {
                      const rs = runState(m.c, m.entry.target);
                      const p = upgradeProgress(m.c);
                      const updated = p ? p.controlPlane.updated + p.pools.reduce((n, x) => n + x.updated, 0) : 0;
                      const total = p ? p.controlPlane.total + p.pools.reduce((n, x) => n + x.total, 0) : 0;
                      return (
                        <Box key={m.c.key} sx={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 1fr) 150px 1fr', gap: 1.5, alignItems: 'center' }}>
                          <Link to={clusterPath(m.c)}>{m.c.name}</Link>
                          <Typography variant="body2" color="text.secondary">
                            {m.c.kubernetesVersion} → {m.entry.target}
                          </Typography>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            {rs === 'upgrading' && total > 0 ? (
                              <>
                                <Box sx={{ flex: 1, height: 8, borderRadius: 4, bgcolor: 'action.hover', overflow: 'hidden' }}>
                                  <Box sx={{ width: `${(updated / total) * 100}%`, height: '100%', bgcolor: 'info.main' }} />
                                </Box>
                                <Typography variant="body2">{`${updated}/${total} nodes`}</Typography>
                              </>
                            ) : (
                              <StatusLabel
                                status={rs === 'done' ? 'success' : rs === 'failed' ? 'error' : m.ready.level === 'blocked' ? 'error' : ''}
                              >
                                {rs === 'done' ? 'Upgraded' : rs === 'failed' ? 'Failed' : m.ready.level === 'blocked' ? 'Blocked' : 'Waiting'}
                              </StatusLabel>
                            )}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Clusters">
        <SimpleTable
          columns={[
            {
              label: 'Wave',
              getter: (x: Row) =>
                upgradeTargets(x.c.kubernetesVersion, x.r.releases ?? []).length ? (
                  <TextField select size="small" value={x.entry.wave} onChange={e => save(x.c, { wave: Number(e.target.value) })} sx={{ minWidth: 120 }}>
                    <MenuItem value={0}>Not planned</MenuItem>
                    {WAVES.map(w => (
                      <MenuItem key={w} value={w}>
                        Wave {w}
                      </MenuItem>
                    ))}
                  </TextField>
                ) : (
                  '—'
                ),
            },
            { label: 'Cluster', getter: (x: Row) => <Link to={clusterPath(x.c)}>{x.c.name}</Link> },
            { label: 'Tenant', getter: (x: Row) => x.c.tenantName },
            { label: 'Current', getter: (x: Row) => x.c.kubernetesVersion ?? '—' },
            {
              label: 'Target',
              getter: (x: Row) => {
                const targets = upgradeTargets(x.c.kubernetesVersion, x.r.releases ?? []);
                return targets.length ? (
                  <TextField select size="small" value={x.entry.target} onChange={e => save(x.c, { target: e.target.value })} sx={{ minWidth: 200 }}>
                    {targets.map(v => (
                      <MenuItem key={v} value={v}>
                        {v} ({upgradeKind(x.c.kubernetesVersion, v) === 'minor' ? 'minor' : 'patch'})
                      </MenuItem>
                    ))}
                  </TextField>
                ) : (
                  'Up to date'
                );
              },
            },
            {
              label: 'Class',
              getter: (x: Row) =>
                x.c.classUpdate ? (
                  <Box component="label" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} title={`${x.c.clusterClass} → ${x.c.classUpdate}`}>
                    <Checkbox size="small" checked={x.entry.moveClass} onChange={e => save(x.c, { moveClass: e.target.checked })} />
                    <Typography variant="body2">to {x.c.classUpdate}</Typography>
                  </Box>
                ) : (
                  x.c.clusterClass ?? '—'
                ),
            },
            {
              label: 'Readiness',
              getter: (x: Row) => (
                <Box>
                  <Box
                    component="span"
                    sx={{ cursor: 'pointer' }}
                    onClick={() => setOpen(open === x.c.key ? null : x.c.key)}
                    title="Show the checks"
                  >
                    <StatusLabel status={READY[x.ready.level].status}>{`${READY[x.ready.level].text} ›`}</StatusLabel>
                  </Box>
                  {open === x.c.key && (
                    <Box component="ul" sx={{ m: 0, mt: 1, pl: 2 }}>
                      {x.ready.checks.map(ch => (
                        <li key={ch.text}>
                          <Typography variant="body2" color={ch.level === 'block' ? 'error' : ch.level === 'warn' ? 'warning.main' : 'text.secondary'}>
                            {ch.text}
                          </Typography>
                        </li>
                      ))}
                    </Box>
                  )}
                </Box>
              ),
            },
          ]}
          data={rows.sort((a, b) => (a.entry.wave || 9) - (b.entry.wave || 9) || a.c.name.localeCompare(b.c.name))}
        />
      </SectionBox>

      {runWave !== null && (
        <RunWaveDialog
          wave={runWave}
          members={waveMembers(runWave)}
          pdbs={pdbs ?? undefined}
          onClose={() => setRunWave(null)}
          onDone={() => refresh()}
        />
      )}
    </>
  );
}

/**
 * Checks every cluster in the wave with a dry run first; only if all pass
 * does it apply them, one after another.
 */
function RunWaveDialog({
  wave,
  members,
  pdbs,
  onClose,
  onDone,
}: {
  wave: number;
  members: Row[];
  pdbs?: Map<string, string[]>;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [phase, setPhase] = React.useState<'idle' | 'checking' | 'checked' | 'applying' | 'done'>('idle');
  const [results, setResults] = React.useState<RunResult[]>([]);
  const runnable = members.filter(m => m.ready.level !== 'blocked' && runState(m.c, m.entry.target) === 'waiting');
  const skipped = members.filter(m => !runnable.includes(m));
  const word = `wave ${wave}`;

  const plans = runnable.map(m => ({
    m,
    plan: upgradePlan(m.c, m.entry.target, m.entry.moveClass && m.c.classUpdate ? m.c.classUpdate : null, {
      available: m.r.releases ?? [],
      blockingPdbs: pdbs?.get(m.c.key),
    }),
    writer: supervisorWriter(m.r.supervisor),
  }));

  async function run(dryRun: boolean) {
    setPhase(dryRun ? 'checking' : 'applying');
    const out: RunResult[] = [];
    for (const { m, plan, writer } of plans) {
      try {
        for (const req of plan.requests(dryRun ? 'dry run' : `${reason} (${word})`)) await writer.send(req, dryRun);
        out.push({ cluster: m.c.name, ok: true, message: dryRun ? 'Accepted in a dry run.' : `Upgrading to ${m.entry.target}.` });
      } catch (err) {
        out.push({ cluster: m.c.name, ok: false, message: describeError(err) });
        if (!dryRun) break; // stop the wave at the first failure
      }
      setResults([...out]);
    }
    setResults(out);
    setPhase(dryRun ? 'checked' : 'done');
    if (!dryRun) onDone();
  }

  const allPassed = phase === 'checked' && results.length === plans.length && results.every(r => r.ok);
  return (
    <Dialog open onClose={phase === 'applying' ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Upgrade wave {wave}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Typography variant="body2">
            {runnable.length} cluster{runnable.length === 1 ? '' : 's'} will be upgraded, one after another. Each one's control
            plane is upgraded first, then its node pools one node at a time.
          </Typography>
          {skipped.length > 0 && (
            <Alert severity="warning">
              Left out (blocked, already upgrading or done): {skipped.map(s => s.c.name).join(', ')}.
            </Alert>
          )}
          {results.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {results.map(r => (
                <li key={r.cluster}>
                  <Typography variant="body2" color={r.ok ? 'text.primary' : 'error'}>
                    {r.cluster}: {r.message}
                  </Typography>
                </li>
              ))}
            </Box>
          )}
          {phase === 'checked' && !allPassed && (
            <Alert severity="error">At least one cluster would be rejected. Fix it or take it out of the wave, then check again.</Alert>
          )}
          {allPassed && <Alert severity="success">Every cluster in the wave passed the dry run.</Alert>}
          {phase !== 'done' && (
            <>
              <TextField label="Reason (recorded on each cluster)" value={reason} onChange={e => setReason(e.target.value)} size="small" required />
              <TextField label={`Type ${word} to confirm`} value={confirm} onChange={e => setConfirm(e.target.value)} size="small" />
            </>
          )}
          {phase === 'done' && (
            <Alert severity={results.every(r => r.ok) ? 'success' : 'error'}>
              {results.every(r => r.ok)
                ? 'The wave has started. Progress shows on the Waves panel; the next wave unlocks when this one finishes healthy.'
                : 'The wave stopped at the first failure. The clusters listed before it are upgrading.'}
            </Alert>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={phase === 'applying'}>
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {phase !== 'done' && (
          <Button onClick={() => run(true)} disabled={!runnable.length || phase === 'checking' || phase === 'applying'}>
            {phase === 'checking' ? 'Checking…' : 'Dry run'}
          </Button>
        )}
        {phase !== 'done' && (
          <Button
            variant="contained"
            color="error"
            onClick={() => run(false)}
            disabled={!allPassed || !reason.trim() || confirm.trim() !== word}
          >
            {phase === 'applying' ? 'Upgrading…' : `Upgrade wave ${wave}`}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
