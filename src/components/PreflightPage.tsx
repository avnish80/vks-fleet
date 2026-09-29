import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { headlampClient, supervisorWriter } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { configuredByNamespace } from '../limits';
import { AREAS, ChangeSpec, fetchLive, preflight, PreflightCheck } from '../preflight';
import { ImpactRow } from '../provision';
import { upgradeTargets } from '../releases';
import { useObservability } from '../useObservability';
import { usePolling } from '../usePolling';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile } from './charts';

const LEVEL: Record<PreflightCheck['level'], { status: string; text: string }> = {
  ok: { status: 'success', text: 'ok' },
  warn: { status: 'warning', text: 'check' },
  block: { status: 'error', text: 'blocks' },
};
const VERDICT = {
  go: { severity: 'success' as const, text: 'Clear to go' },
  caution: { severity: 'warning' as const, text: 'Go ahead with care' },
  stop: { severity: 'error' as const, text: 'Stop' },
};

/**
 * Change impact analysis: pick a cluster and a change (upgrade, scale a pool,
 * change a pool's VM class) and see, before starting it, what it touches and
 * whether it's safe.
 */
export function PreflightPage() {
  const { results, all, inventoryAll, limitsAll, persona, canWrite, refresh } = useFleetData();
  const location = useLocation();
  const history = useHistory();
  const q = new URLSearchParams(location.search);
  const set = (changes: Record<string, string | undefined>) => {
    const p = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) v ? p.set(k, v) : p.delete(k);
    history.replace(`${location.pathname}?${p.toString()}`);
  };
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const cluster = clusters.find(c => c.key === q.get('cluster'));
  const workload = useWorkloadHealth(cluster ? [cluster] : [], 120);
  const ctx = cluster ? workload.byKey.get(cluster.key)?.contextName : undefined;
  const obs = useObservability(cluster && ctx ? [{ key: cluster.key, name: cluster.name, contextName: ctx }] : []);
  const live = usePolling(ctx ? `preflight|${ctx}` : null, () => fetchLive(headlampClient(ctx!)), 60);
  const operator = !!persona && ['operator', 'readonly', 'unknown'].includes(persona.persona);
  const health = useSupervisorHealth(all, inventoryAll, operator && !!cluster);
  const [applying, setApplying] = React.useState(false);
  if (results === null) return <Loader title="Loading clusters" />;

  const r = cluster ? (results ?? []).find(x => x.clusters.some(c => c.key === cluster.key)) : undefined;
  const kind = (q.get('kind') as ChangeSpec['kind']) ?? 'upgrade';
  const targets = cluster ? upgradeTargets(cluster.kubernetesVersion, r?.releases ?? []) : [];
  const pool = q.get('pool') ?? cluster?.nodePools[0]?.name ?? '';
  const classes = (r?.vmClasses ?? []).filter(v => cluster && v.namespace === cluster.namespace);
  const change: ChangeSpec | undefined = !cluster
    ? undefined
    : kind === 'upgrade'
    ? targets.length || q.get('target')
      ? { kind, target: q.get('target') ?? targets[0] }
      : undefined
    : kind === 'scale'
    ? { kind, pool, replicas: Number(q.get('replicas') ?? cluster.nodePools.find(p => p.name === pool)?.desired ?? 1) }
    : q.get('vmClass')
    ? { kind, pool, vmClass: q.get('vmClass')! }
    : undefined;
  const h = cluster ? (health ?? []).find(x => x.supervisorId === cluster.supervisorId) : undefined;
  const summary = (obs ?? [])[0];
  const pf =
    cluster && change
      ? preflight({
          cluster,
          change,
          releases: r?.releases ?? [],
          vmClasses: r?.vmClasses ?? [],
          limits: limitsAll.get(cluster.namespace),
          configured: configuredByNamespace(all ?? [], inventoryAll).get(cluster.namespace),
          deprecated: summary?.stack.prometheus ? summary.deprecatedApis : undefined,
          live: live ?? undefined,
          supervisorScore: h?.score,
          staleControllers: h?.leases.filter(l => l.state !== 'ok').map(l => l.controller),
        })
      : undefined;
  const poolOf = cluster?.nodePools.find(p => p.name === pool);
  const impactTable = (rows: ImpactRow[]) => (
    <SimpleTable
      columns={[
        { label: 'Resource', getter: (x: ImpactRow) => x.resource },
        { label: 'Now', getter: (x: ImpactRow) => x.before },
        { label: 'With the change', getter: (x: ImpactRow) => <b>{x.after}</b> },
        { label: 'Limit', getter: (x: ImpactRow) => x.limit || '—' },
        { label: '', getter: (x: ImpactRow) => <StatusLabel status={x.status === 'ok' ? 'success' : x.status === 'warn' ? 'warning' : 'error'}>{x.status === 'ok' ? 'fits' : x.status === 'warn' ? 'tight' : 'over'}</StatusLabel> },
      ]}
      data={rows}
    />
  );
  const yaml =
    change?.kind === 'vmclass'
      ? `spec:\n  topology:\n    workers:\n      machineDeployments:\n      - name: ${change.pool}\n        variables:\n          overrides:\n          - name: vmClass\n            value: ${change.vmClass}`
      : '';

  return (
    <>
      <ChartStyles />
      <SectionBox title="Pre-flight: what a change will do, before you start it">
        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField select size="small" label="Cluster" value={cluster?.key ?? ''} onChange={e => set({ cluster: e.target.value, target: undefined, pool: undefined, replicas: undefined, vmClass: undefined })} sx={{ minWidth: 240 }}>
            {clusters.map(c => (
              <MenuItem key={c.key} value={c.key}>
                {c.name} ({c.namespace})
              </MenuItem>
            ))}
          </TextField>
          {cluster && (
            <TextField select size="small" label="Change" value={kind} onChange={e => set({ kind: e.target.value })} sx={{ minWidth: 200 }}>
              <MenuItem value="upgrade">Upgrade Kubernetes</MenuItem>
              <MenuItem value="scale">Scale a node pool</MenuItem>
              <MenuItem value="vmclass">Change a pool's VM class</MenuItem>
            </TextField>
          )}
          {cluster && kind === 'upgrade' && (
            <TextField select size="small" label="To" value={change?.kind === 'upgrade' ? change.target : ''} onChange={e => set({ target: e.target.value })} sx={{ minWidth: 220 }} disabled={!targets.length}>
              {targets.map(t => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </TextField>
          )}
          {cluster && kind !== 'upgrade' && (
            <TextField select size="small" label="Pool" value={pool} onChange={e => set({ pool: e.target.value, replicas: undefined })} sx={{ minWidth: 140 }}>
              {cluster.nodePools.map(p => (
                <MenuItem key={p.name} value={p.name}>
                  {p.name} ({p.desired ?? p.ready} × {p.vmClass ?? '?'})
                </MenuItem>
              ))}
            </TextField>
          )}
          {cluster && kind === 'scale' && (
            <TextField size="small" type="number" label="Nodes" value={change?.kind === 'scale' ? change.replicas : ''} onChange={e => set({ replicas: String(Math.max(0, Number(e.target.value) || 0)) })} sx={{ width: 110 }} />
          )}
          {cluster && kind === 'vmclass' && (
            <TextField select size="small" label="New VM class" value={q.get('vmClass') ?? ''} onChange={e => set({ vmClass: e.target.value })} sx={{ minWidth: 220 }}>
              {classes.map(v => (
                <MenuItem key={v.name} value={v.name}>
                  {v.name}
                  {v.cpus ? ` (${v.cpus} vCPU, ${Math.round((v.memoryBytes ?? 0) / 2 ** 30)} GiB)` : ''}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Box>
        {!cluster && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Before an upgrade, a pool scale or a VM class change: the version path, capacity while it runs and after, which pods move
            and what would block or break, cluster and Supervisor health, deprecated APIs and packages, with a verdict.
          </Typography>
        )}
        {cluster && kind === 'upgrade' && !targets.length && (
          <Typography color="text.secondary" sx={{ mt: 1.5 }}>
            No newer release is offered for {cluster.name} ({cluster.kubernetesVersion}).
          </Typography>
        )}
      </SectionBox>

      {pf && (
        <SectionBox title={pf.title}>
          <Alert
            severity={VERDICT[pf.verdict].severity}
            sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}
            action={
              pf.plan && cluster && r && canWrite(cluster.supervisorId) ? (
                <Button color="inherit" variant="outlined" size="small" disabled={pf.verdict === 'stop'} onClick={() => setApplying(true)}>
                  Continue to the change…
                </Button>
              ) : undefined
            }
          >
            <Typography sx={{ fontWeight: 700 }}>{VERDICT[pf.verdict].text}</Typography>
            {pf.recommendation}
          </Alert>
          {pf.blast && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2, mb: 2 }}>
              <KpiTile label={pf.blast.removing ? 'Nodes removed' : 'Nodes replaced'} value={pf.blast.removing ?? pf.blast.nodes.length + pf.blast.controlPlane} sub={pf.blast.removing ? `of ${pf.blast.nodes.length} in the pool` : pf.blast.controlPlane ? `incl. ${pf.blast.controlPlane} control plane` : 'workers'} tone="primary" />
              <KpiTile label="Pods that move" value={pf.blast.pods} sub={pf.blast.removing ? 'at most' : 'rescheduled'} tone="primary" />
              <KpiTile label="Workloads" value={pf.blast.workloads} sub={`${pf.blast.namespaces} namespaces`} tone="primary" />
              <KpiTile label="Brief outage" value={pf.blast.singleReplica.length} sub="single-replica workloads" tone={pf.blast.singleReplica.length ? 'warning' : 'success'} />
              <KpiTile label="Would block" value={pf.blast.blockingPdbs.length + pf.blast.pinned.length} sub="PDBs, pinned pods" tone={pf.blast.blockingPdbs.length + pf.blast.pinned.length ? 'warning' : 'success'} />
            </Box>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 3 }}>
            <Box>
              {AREAS.filter(a => pf.checks.some(x => x.area === a)).map(a => (
                <Box key={a} sx={{ mb: 1.5 }}>
                  <Typography sx={{ fontWeight: 700, mb: 0.5 }}>{a}</Typography>
                  {pf.checks
                    .filter(x => x.area === a)
                    .sort((x, y) => ['block', 'warn', 'ok'].indexOf(x.level) - ['block', 'warn', 'ok'].indexOf(y.level))
                    .map((x, i) => (
                      <Box key={i} sx={{ display: 'flex', gap: 1, alignItems: 'baseline', mb: 0.5 }}>
                        <Box sx={{ minWidth: 64 }}>
                          <StatusLabel status={LEVEL[x.level].status}>{LEVEL[x.level].text}</StatusLabel>
                        </Box>
                        <Typography variant="body2" sx={{ fontWeight: x.level === 'ok' ? 400 : 600 }}>
                          {x.text}
                        </Typography>
                      </Box>
                    ))}
                </Box>
              ))}
            </Box>
            <Box>
              {pf.capacity.during && (
                <Box sx={{ mb: 2 }}>
                  <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Namespace capacity while it runs</Typography>
                  {impactTable(pf.capacity.during)}
                </Box>
              )}
              {pf.capacity.after && (
                <Box sx={{ mb: 2 }}>
                  <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Namespace capacity afterwards</Typography>
                  {impactTable(pf.capacity.after)}
                </Box>
              )}
              {yaml && pf.verdict !== 'stop' && (
                <Box>
                  <Typography sx={{ fontWeight: 700, mb: 0.5 }}>The change</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                    Set in the Cluster's spec (kubectl edit, or the cluster's GitOps source):
                  </Typography>
                  <Box component="pre" sx={{ m: 0, p: 1.25, bgcolor: 'action.hover', borderRadius: 1, fontSize: '0.8rem', overflowX: 'auto' }}>
                    {yaml}
                  </Box>
                </Box>
              )}
              {!live && ctx && <Typography color="text.secondary">Reading the cluster…</Typography>}
            </Box>
          </Box>
          {poolOf && kind === 'vmclass' && !q.get('vmClass') && <Typography color="text.secondary">Choose the new VM class.</Typography>}
        </SectionBox>
      )}
      {applying && pf?.plan && r && <ActionDialog plan={pf.plan} writer={supervisorWriter(r.supervisor)} onClose={() => setApplying(false)} onApplied={() => refresh()} />}
    </>
  );
}
