import { Loader, SectionBox, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, Paper, TextField, Typography } from '@mui/material';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { hostPatterns, Layer, walkDown } from '../explain';
import { useFleetData } from '../fleetContext';
import { buildIncident, IncidentEvent, postMortemMarkdown } from '../incident';
import { buildIssues } from '../issues';
import { configuredByNamespace } from '../limits';
import { download } from '../report';
import { fleetTimeline } from '../timeline';
import { FleetCluster } from '../types';
import { useObservability } from '../useObservability';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { useWorkloadHealth } from '../useWorkload';


const DOT: Record<IncidentEvent['tone'], string> = { success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6', neutral: '#94a3b8' };
const SOURCE: Record<IncidentEvent['source'], string> = { change: 'Change', condition: 'Condition', alert: 'Alert', event: 'Event', anomaly: 'Unusual', forecast: 'Forecast', issue: 'Open issue' };

function useSelection() {
  const location = useLocation();
  const history = useHistory();
  const q = new URLSearchParams(location.search);
  const set = (k: string, v?: string) => {
    const p = new URLSearchParams(location.search);
    if (v) p.set(k, v);
    else p.delete(k);
    history.replace(`${location.pathname}?${p.toString()}`);
  };
  return { q, set };
}

function ClusterPicker({ clusters, value, onChange }: { clusters: FleetCluster[]; value?: string; onChange: (k: string) => void }) {
  return (
    <TextField select size="small" label="Cluster" value={value ?? ''} onChange={e => onChange(e.target.value)} sx={{ minWidth: 260 }}>
      {clusters.map(c => (
        <MenuItem key={c.key} value={c.key}>
          {c.name} ({c.namespace})
        </MenuItem>
      ))}
    </TextField>
  );
}

/* ---------------- Incident timeline ---------------- */

export function IncidentPage() {
  const { results } = useFleetData();
  const { q, set } = useSelection();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const cluster = clusters.find(c => c.key === q.get('cluster'));
  const hours = Number(q.get('hours') ?? 24) || 24;
  const workload = useWorkloadHealth(cluster ? [cluster] : [], 60);
  const ctx = cluster && workload.byKey.get(cluster.key)?.contextName;
  const obs = useObservability(cluster && ctx ? [{ key: cluster.key, name: cluster.name, contextName: ctx }] : []);
  const [copied, setCopied] = React.useState(false);
  if (results === null) return <Loader title="Loading clusters" />;
  if (!cluster) {
    return (
      <SectionBox title="Incident timeline">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Everything the fleet knows about one cluster over a window, as one story, with a post-mortem draft to start from.
        </Typography>
        <ClusterPicker clusters={clusters} onChange={k => set('cluster', k)} />
      </SectionBox>
    );
  }
  const now = new Date();
  const wl = workload.byKey.get(cluster.key);
  const summary = (obs ?? [])[0];
  const r = (results ?? []).find(x => x.clusters.some(c => c.key === cluster.key))!;
  const issues = buildIssues([{ ...r, clusters: [cluster] }], new Map(wl ? [[cluster.key, wl]] : []), now).filter(i => i.clusterKey === cluster.key);
  const inc = buildIncident({
    cluster: cluster.name,
    now,
    hours,
    timeline: fleetTimeline([cluster], now, Math.ceil(hours / 24) + 1).get(cluster.key) ?? [],
    alerts: summary?.alerts,
    warnings: wl?.recentWarnings,
    unusual: summary?.unusual,
    forecasts: summary?.forecasts,
    issues,
  });
  const md = postMortemMarkdown(inc, { affected: issues.flatMap(i => i.affected.pods.slice(0, 3).map(p => `pod ${p}`)).slice(0, 8) });
  return (
    <>
      <SectionBox
        title={`Incident timeline: ${cluster.name}`}
        headerProps={{
          actions: [
            <ClusterPicker key="c" clusters={clusters} value={cluster.key} onChange={k => set('cluster', k)} />,
            <TextField key="h" select size="small" label="Window" value={hours} onChange={e => set('hours', String(e.target.value))} sx={{ width: 130 }}>
              {[6, 24, 72].map(h => (
                <MenuItem key={h} value={h}>
                  {h < 48 ? `${h} hours` : `${h / 24} days`}
                </MenuItem>
              ))}
            </TextField>,
            <Button
              key="copy"
              size="small"
              variant="contained"
              onClick={() => {
                navigator.clipboard?.writeText(md);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy as post-mortem draft'}
            </Button>,
            <Button key="dl" size="small" onClick={() => download(`incident-${cluster.name}-${now.toISOString().slice(0, 10)}.md`, md, 'text/markdown')}>
              Download .md
            </Button>,
          ],
        }}
      >
        <Alert severity={inc.firstSymptom || inc.events.some(e => e.time === undefined && e.symptom) ? 'warning' : 'success'} sx={{ mb: 2 }}>
          {inc.summary}
        </Alert>
        {!wl && <Typography color="text.secondary">Reading the cluster…</Typography>}
        <Box sx={{ position: 'relative', pl: 3 }}>
          <Box sx={{ position: 'absolute', left: 9, top: 6, bottom: 6, width: 2, bgcolor: 'divider' }} />
          {inc.events.map((e, i) => {
            const isTrigger = inc.trigger === e;
            const isFirst = inc.firstSymptom === e;
            return (
              <Box key={i} sx={{ position: 'relative', mb: 1.25 }}>
                <Box sx={{ position: 'absolute', left: -21, top: 5, width: 12, height: 12, borderRadius: '50%', bgcolor: DOT[e.tone], border: '2px solid white', boxShadow: '0 0 0 1px rgba(0,0,0,0.12)' }} />
                <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130, fontVariantNumeric: 'tabular-nums' }}>
                    {e.time ? new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'now'}
                  </Typography>
                  <Box sx={{ px: 0.75, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.72rem', fontWeight: 600 }}>{SOURCE[e.source]}</Box>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 260 }}>
                    {e.text}
                  </Typography>
                  {isTrigger && <StatusLabel status="warning">possible trigger</StatusLabel>}
                  {isFirst && <StatusLabel status="error">first symptom</StatusLabel>}
                </Box>
              </Box>
            );
          })}
          {!inc.events.length && <Typography color="text.secondary">Nothing in this window.</Typography>}
        </Box>
      </SectionBox>
    </>
  );
}

/* ---------------- Walk down ---------------- */

const STATE_COLOUR: Record<Layer['state'], string> = { ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', unknown: '#94a3b8' };

export function WalkDownPage() {
  const { results, all, inventoryAll, limitsAll, persona } = useFleetData();
  const { q, set } = useSelection();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const cluster = clusters.find(c => c.key === q.get('cluster'));
  const workload = useWorkloadHealth(cluster ? [cluster] : [], 60);
  const operator = !!persona && ['operator', 'readonly', 'unknown'].includes(persona.persona);
  const health = useSupervisorHealth(all, inventoryAll, operator && !!cluster);
  if (results === null) return <Loader title="Loading clusters" />;
  const nodes = cluster ? cluster.machines.map(m => m.nodeName ?? m.name) : [];
  const node = q.get('node') ?? undefined;
  const podParam = q.get('pod') ?? undefined;
  const pod = podParam && podParam.includes('/') ? { namespace: podParam.split('/')[0], name: podParam.split('/')[1] } : undefined;
  const wl = cluster ? workload.byKey.get(cluster.key) : undefined;
  const inv = cluster ? inventoryAll?.get(cluster.supervisorId) : undefined;
  const h = cluster ? (health ?? []).find(x => x.supervisorId === cluster.supervisorId) : undefined;
  const patterns = cluster ? hostPatterns(cluster, wl, inv) : [];
  const walk =
    cluster && node
      ? walkDown({
          cluster,
          node,
          pod,
          workload: wl,
          inventory: inv,
          hosts: h?.nodes.filter(n => n.role === 'host').map(n => ({ name: n.name, ready: n.ready })),
          limits: limitsAll.get(cluster.namespace),
          configured: configuredByNamespace(all ?? [], inventoryAll).get(cluster.namespace),
          supervisorScore: h?.score,
        })
      : undefined;
  return (
    <SectionBox
      title="Walk down the layers"
      headerProps={{
        actions: [
          <ClusterPicker key="c" clusters={clusters} value={cluster?.key} onChange={k => set('cluster', k)} />,
          ...(cluster
            ? [
                <TextField key="n" select size="small" label="Node" value={node ?? ''} onChange={e => set('node', e.target.value)} sx={{ minWidth: 280 }}>
                  {nodes.map(n => (
                    <MenuItem key={n} value={n}>
                      {n}
                    </MenuItem>
                  ))}
                </TextField>,
              ]
            : []),
        ],
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        From a pod or node down through everything VKS stacks under it: the node, its Machine, its VM, the ESXi host, the
        namespace's capacity and the Supervisor. A problem low in the stack usually explains everything above it.
      </Typography>
      {patterns.map(p => (
        <Alert key={p.host} severity="warning" sx={{ mb: 1.5 }}>
          {p.problemNodes.length} of the {p.totalProblemNodes} nodes with problems in {cluster!.name} are VMs on <b>{p.host}</b>: look at that host first.
        </Alert>
      ))}
      {!cluster || !node ? (
        <Typography color="text.secondary">Choose a cluster and a node.</Typography>
      ) : !walk ? (
        <Loader title="Reading the layers" />
      ) : (
        <>
          <Alert severity={walk.likely ? (walk.likely.state === 'bad' ? 'error' : 'warning') : 'success'} sx={{ mb: 2 }}>
            {walk.summary}
          </Alert>
          <Box sx={{ maxWidth: 820 }}>
            {walk.layers.map((l, i) => (
              <Box key={l.layer}>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    borderLeft: `4px solid ${STATE_COLOUR[l.state]}`,
                    ...(walk.likely === l ? { boxShadow: `0 0 0 2px ${STATE_COLOUR[l.state]}33` } : {}),
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: 0.6, color: 'text.secondary', minWidth: 90 }}>
                      {l.layer}
                    </Typography>
                    <Typography sx={{ fontWeight: 600, flex: 1 }}>{l.name}</Typography>
                    {walk.likely === l && <StatusLabel status={l.state === 'bad' ? 'error' : 'warning'}>likely layer</StatusLabel>}
                  </Box>
                  {l.facts.map((f, k) => (
                    <Typography key={k} variant="body2" color={l.state === 'ok' ? 'text.secondary' : 'text.primary'}>
                      {f}
                    </Typography>
                  ))}
                </Paper>
                {i < walk.layers.length - 1 && <Box sx={{ width: 2, height: 14, bgcolor: 'divider', ml: 3 }} />}
              </Box>
            ))}
          </Box>
        </>
      )}
    </SectionBox>
  );
}
