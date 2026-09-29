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
import { useObservability } from '../useObservability';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { useWorkloadHealth } from '../useWorkload';
import { useVcenterStatus } from '../useVcenterStatus';
import { matchSupervisor, placementFor } from '../vcenterStatus';

const DOT: Record<IncidentEvent['tone'], string> = { success: '#10b981', warning: '#f59e0b', error: '#ef4444', info: '#3b82f6', neutral: '#94a3b8' };
const SOURCE: Record<IncidentEvent['source'], string> = { change: 'Change', condition: 'Condition', alert: 'Alert', event: 'Event', anomaly: 'Unusual', forecast: 'Forecast', issue: 'Open issue' };
const STATE_COLOUR: Record<Layer['state'], string> = { ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', unknown: '#94a3b8' };

/**
 * Investigate: one cluster, one window, one page. The timeline (what happened,
 * with a suggested trigger and a post-mortem draft) beside the walk-down (which
 * layer under a node is in trouble), with problem nodes picked out.
 */
export function InvestigatePage() {
  const { results, all, inventoryAll, limitsAll, persona, config } = useFleetData();
  const vcenter = useVcenterStatus(config);
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
  const hours = Number(q.get('hours') ?? 24) || 24;
  const workload = useWorkloadHealth(cluster ? [cluster] : [], 60);
  const ctx = cluster && workload.byKey.get(cluster.key)?.contextName;
  const obs = useObservability(cluster && ctx ? [{ key: cluster.key, name: cluster.name, contextName: ctx }] : []);
  const operator = !!persona && ['operator', 'readonly', 'unknown'].includes(persona.persona);
  const health = useSupervisorHealth(all, inventoryAll, operator && !!cluster);
  const [copied, setCopied] = React.useState(false);
  if (results === null) return <Loader title="Loading clusters" />;

  const picker = (
    <TextField select size="small" label="Cluster" value={cluster?.key ?? ''} onChange={e => set({ cluster: e.target.value, node: undefined, pod: undefined })} sx={{ minWidth: 260 }}>
      {clusters.map(c => (
        <MenuItem key={c.key} value={c.key}>
          {c.name} ({c.namespace})
        </MenuItem>
      ))}
    </TextField>
  );
  if (!cluster) {
    return (
      <SectionBox title="Investigate">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Pick a cluster: what happened in it as one story (changes, alerts, events, anomalies, open issues) with a post-mortem
          draft, and a walk down the layers under any of its nodes.
        </Typography>
        {picker}
      </SectionBox>
    );
  }

  const now = new Date();
  const wl = workload.byKey.get(cluster.key);
  const summary = (obs ?? [])[0];
  const r = (results ?? []).find(x => x.clusters.some(c => c.key === cluster.key))!;
  const inv = inventoryAll?.get(cluster.supervisorId);
  const h = (health ?? []).find(x => x.supervisorId === cluster.supervisorId);
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
  const vcSup = vcenter?.status ? matchSupervisor(vcenter.status, r.supervisor, (all ?? []).length, h?.nodes.filter(n => n.role === 'host').map(n => n.name)) : undefined;
  const placed = placementFor(vcenter?.status, vcSup?.id);
  const hostOf = (name: string) => placed.get(name);
  const patterns = hostPatterns(cluster, wl, inv, hostOf);
  const nodes = cluster.machines.map(m => m.nodeName ?? m.name);
  const problemNodes = Array.from(new Set([...patterns.flatMap(p => p.problemNodes), ...issues.flatMap(i => i.affected.nodes), ...(wl?.podIssues ?? []).map(p => p.node).filter((n): n is string => !!n), ...cluster.machines.filter(m => m.deletingSince || !m.ready).map(m => m.nodeName ?? m.name)]));
  const node = q.get('node') ?? problemNodes[0];
  const podParam = q.get('pod');
  const pod = podParam?.includes('/') ? { namespace: podParam.split('/')[0], name: podParam.slice(podParam.indexOf('/') + 1) } : undefined;
  const walk = node
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
        hostOf,
      })
    : undefined;
  const nodeIn = (text: string) => nodes.find(n => text.includes(n));

  return (
    <SectionBox
      title={`Investigate: ${cluster.name}`}
      headerProps={{
        actions: [
          picker,
          <TextField key="h" select size="small" label="Window" value={hours} onChange={e => set({ hours: String(e.target.value) })} sx={{ width: 120 }}>
            {[6, 24, 72].map(x => (
              <MenuItem key={x} value={x}>
                {x < 48 ? `${x} hours` : `${x / 24} days`}
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
      <Alert severity={inc.firstSymptom || inc.events.some(e => e.time === undefined && e.symptom) ? 'warning' : 'success'} sx={{ mb: 1.5 }}>
        {inc.summary}
      </Alert>
      {patterns.map(p => (
        <Alert key={p.host} severity="warning" sx={{ mb: 1.5 }} action={<Button size="small" color="inherit" onClick={() => set({ node: p.problemNodes[0] })}>Walk down</Button>}>
          {p.problemNodes.length} of the {p.totalProblemNodes} nodes with problems are VMs on <b>{p.host}</b>: look at that host first.
        </Alert>
      ))}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' }, gap: 3 }}>
        <Box>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>What happened (last {hours < 48 ? `${hours} hours` : `${hours / 24} days`})</Typography>
          {!wl && <Typography color="text.secondary">Reading the cluster…</Typography>}
          <Box sx={{ position: 'relative', pl: 3 }}>
            <Box sx={{ position: 'absolute', left: 9, top: 6, bottom: 6, width: 2, bgcolor: 'divider' }} />
            {inc.events.map((e, i) => {
              const mentioned = nodeIn(e.text);
              return (
                <Box key={i} sx={{ position: 'relative', mb: 1.25 }}>
                  <Box sx={{ position: 'absolute', left: -21, top: 5, width: 12, height: 12, borderRadius: '50%', bgcolor: DOT[e.tone], border: 2, borderColor: 'background.paper', boxShadow: 1 }} />
                  <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 118, fontVariantNumeric: 'tabular-nums' }}>
                      {e.time ? new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'now'}
                    </Typography>
                    <Box sx={{ px: 0.75, borderRadius: 1, bgcolor: 'action.hover', fontSize: '0.72rem', fontWeight: 600 }}>{SOURCE[e.source]}</Box>
                    <Typography variant="body2" sx={{ flex: 1, minWidth: 220 }}>
                      {e.text}
                      {mentioned && mentioned !== node && (
                        <Button size="small" onClick={() => set({ node: mentioned })} sx={{ ml: 0.5, py: 0, minWidth: 0 }}>
                          walk down
                        </Button>
                      )}
                    </Typography>
                    {inc.trigger === e && <StatusLabel status="warning">possible trigger</StatusLabel>}
                    {inc.firstSymptom === e && <StatusLabel status="error">first symptom</StatusLabel>}
                  </Box>
                </Box>
              );
            })}
            {!inc.events.length && <Typography color="text.secondary">Nothing in this window.</Typography>}
          </Box>
        </Box>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography sx={{ fontWeight: 600, flex: 1 }}>The layers under</Typography>
            <TextField select size="small" value={node ?? ''} onChange={e => set({ node: e.target.value })} sx={{ minWidth: 220 }}>
              {nodes.map(n => (
                <MenuItem key={n} value={n}>
                  {problemNodes.includes(n) ? `⚠ ${n}` : n}
                </MenuItem>
              ))}
            </TextField>
          </Box>
          {!node ? (
            <Typography color="text.secondary">Pick a node (⚠ marks nodes with problems).</Typography>
          ) : !walk ? (
            <Loader title="Reading the layers" />
          ) : (
            <>
              <Alert severity={walk.likely ? (walk.likely.state === 'bad' ? 'error' : 'warning') : 'success'} sx={{ mb: 1.5 }}>
                {walk.summary}
              </Alert>
              {walk.layers.map((l, i) => (
                <Box key={l.layer}>
                  <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 2, borderLeft: `4px solid ${STATE_COLOUR[l.state]}`, ...(walk.likely === l ? { boxShadow: `0 0 0 2px ${STATE_COLOUR[l.state]}33` } : {}) }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                      <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: 0.6, color: 'text.secondary', minWidth: 84 }}>
                        {l.layer}
                      </Typography>
                      <Typography sx={{ fontWeight: 600, flex: 1, overflowWrap: 'anywhere' }}>{l.name}</Typography>
                      {walk.likely === l && <StatusLabel status={l.state === 'bad' ? 'error' : 'warning'}>likely</StatusLabel>}
                    </Box>
                    {l.facts.map((f, k) => (
                      <Typography key={k} variant="body2" color={l.state === 'ok' ? 'text.secondary' : 'text.primary'}>
                        {f}
                      </Typography>
                    ))}
                  </Paper>
                  {i < walk.layers.length - 1 && <Box sx={{ width: 2, height: 12, bgcolor: 'divider', ml: 3 }} />}
                </Box>
              ))}
            </>
          )}
        </Box>
      </Box>
    </SectionBox>
  );
}
