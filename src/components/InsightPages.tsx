import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { AppGroup, ClusterScan, GitOpsApp, groupApps, NamespacePosture, SECURITY_KIND_LABEL, SecurityFinding, SecurityKind } from '../clusterScan';
import { headlampWriter } from '../api/headlampClient';
import { defaultDenyPlan, podSecurityPlan } from '../guestActions';
import { PssLevel } from '../pss';
import { securityIssueId } from '../scanIssues';
import { activeSilences } from '../silences';
import { Silence } from '../types';
import { ActionDialog } from './ActionDialog';
import { SignInHelper } from './SignInHelper';
import { removeSilence, SilenceDialog } from './SilenceDialog';
import { useFleetData } from '../fleetContext';
import { formatBytes } from '../quantity';
import { download } from '../report';
import { clusterDeepLink } from '../routes';
import { settingsStore } from '../settings/store';
import { showback, ShowbackRow, showbackCsv, showbackMarkdown, showbackTotals } from '../showback';
import { FleetCluster } from '../types';
import { useClusterScans } from '../useClusterScans';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';

/** Scans of every signed-in cluster in the current (org-scoped) view. */
function useScans(): {
  scans: ClusterScan[] | null;
  clusters: FleetCluster[];
  notSignedIn: FleetCluster[];
  loading: boolean;
  health: Map<string, import('../types').WorkloadHealth>;
} {
  const { config, results } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const scans = useClusterScans(targets, config.baseline?.allowedRegistries ?? []);
  return {
    scans,
    clusters,
    notSignedIn: clusters.filter(c => !workload.byKey.get(c.key)?.contextName),
    loading: results === null || (targets.length > 0 && scans === null),
    health: workload.byKey,
  };
}

function SignInNote({ notSignedIn }: { notSignedIn: FleetCluster[] }) {
  if (!notSignedIn.length) return null;
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
      Not signed in, so not included: {notSignedIn.map(c => c.name).join(', ')}.
    </Typography>
  );
}

/* ---------------- Applications ---------------- */

export function AppsPage() {
  const { scans, clusters, notSignedIn, loading, health } = useScans();
  const { config: appsConfig } = useFleetData();
  const [open, setOpen] = React.useState<string | null>(null);
  const [onlyShared, setOnlyShared] = React.useState(false);
  if (loading || !scans) return <Loader title="Reading workloads in the clusters" />;
  const apps = groupApps(scans.flatMap(s => s.workloads));
  const shown = onlyShared ? apps.filter(a => a.clusters.length > 1) : apps;
  const gitops = scans.flatMap(s => s.gitops);
  const byName = new Map(clusters.map(c => [c.key, c]));
  const unhealthy = apps.filter(a => a.ready < a.desired);
  return (
    <>
      <ChartStyles />
      <SectionBox title="Applications">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Deployments, StatefulSets and DaemonSets outside platform namespaces, grouped by app name
          (app.kubernetes.io/name, app, or the workload's name) across every signed-in cluster. Drift means the same image
          at different versions in different places.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 2, mb: 2 }}>
          <KpiTile label="Apps" value={apps.length} sub={`${scans.reduce((n, s) => n + s.workloads.length, 0)} workloads`} tone="primary" />
          <KpiTile label="In several clusters" value={apps.filter(a => a.clusters.length > 1).length} tone="info" />
          <KpiTile label="Version drift" value={apps.filter(a => a.drift.length).length} tone={apps.some(a => a.drift.length) ? 'warning' : 'success'} />
          <KpiTile label="Not fully ready" value={unhealthy.length} tone={unhealthy.length ? 'warning' : 'success'} />
          <KpiTile label="GitOps apps" value={gitops.length} sub={gitops.length ? `${gitops.filter(g => g.ready === false || g.health === 'Degraded').length} failing` : 'none found'} tone="info" />
        </Box>
        <SignInHelper clusters={clusters} health={health} supervisors={appsConfig.supervisors} />
        <FormControlLabel control={<Switch checked={onlyShared} onChange={e => setOnlyShared(e.target.checked)} />} label="Only apps in more than one cluster" />
        <SimpleTable
          columns={[
            {
              label: 'App',
              getter: (a: AppGroup) => (
                <Box component="span" sx={{ cursor: 'pointer', fontWeight: 600 }} onClick={() => setOpen(open === a.app ? null : a.app)}>
                  {a.app} {open === a.app ? '▾' : '▸'}
                </Box>
              ),
            },
            { label: 'Clusters', getter: (a: AppGroup) => a.clusters.join(', ') },
            { label: 'Namespaces', getter: (a: AppGroup) => a.namespaces.join(', ') },
            {
              label: 'Ready',
              getter: (a: AppGroup) => <StatusLabel status={a.ready < a.desired ? 'warning' : 'success'}>{`${a.ready}/${a.desired}`}</StatusLabel>,
            },
            {
              label: 'Images',
              getter: (a: AppGroup) =>
                a.drift.length ? (
                  <StatusLabel status="warning">{`Drift: ${a.drift.map(d => `${d.repo.split('/').pop()} ${d.tags.join(' / ')}`).join('; ')}`}</StatusLabel>
                ) : (
                  <Typography variant="body2">{a.images.slice(0, 2).join(', ')}{a.images.length > 2 ? ` +${a.images.length - 2}` : ''}</Typography>
                ),
            },
          ]}
          data={shown}
        />
        {open && (
          <Box sx={{ mt: 2 }}>
            <Typography sx={{ fontWeight: 600, mb: 1 }}>{open}: where it runs</Typography>
            <SimpleTable
              columns={[
                {
                  label: 'Cluster',
                  getter: (w: AppGroup['workloads'][number]) => {
                    const c = byName.get(w.clusterKey);
                    return c ? <Link to={clusterDeepLink(c, { hash: 'inside' })}>{w.clusterName}</Link> : w.clusterName;
                  },
                },
                { label: 'Workload', getter: (w: AppGroup['workloads'][number]) => `${w.kind} ${w.namespace}/${w.name}` },
                { label: 'Ready', getter: (w: AppGroup['workloads'][number]) => `${w.ready}/${w.desired}` },
                { label: 'Images', getter: (w: AppGroup['workloads'][number]) => w.images.join(', ') },
              ]}
              data={apps.find(a => a.app === open)?.workloads ?? []}
            />
          </Box>
        )}
        <SignInNote notSignedIn={notSignedIn} />
      </SectionBox>

      <Box id="gitops" sx={{ scrollMarginTop: 72 }} />
      <SectionBox title="GitOps">
        {gitops.length === 0 ? (
          <Typography color="text.secondary">No Argo CD Applications or Flux Kustomizations/HelmReleases found in the signed-in clusters.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (g: GitOpsApp) => g.clusterName },
              { label: 'Tool', getter: (g: GitOpsApp) => `${g.tool} ${g.kind}` },
              { label: 'Name', getter: (g: GitOpsApp) => `${g.namespace}/${g.name}` },
              {
                label: 'State',
                getter: (g: GitOpsApp) => {
                  if (g.suspended) return <StatusLabel status="">Suspended</StatusLabel>;
                  if (g.tool === 'Argo CD')
                    return (
                      <StatusLabel status={g.health === 'Degraded' || g.health === 'Missing' ? 'error' : g.sync === 'OutOfSync' ? 'warning' : 'success'}>
                        {`${g.sync ?? '?'} · ${g.health ?? '?'}`}
                      </StatusLabel>
                    );
                  return <StatusLabel status={g.ready === false ? 'error' : g.ready ? 'success' : ''}>{g.ready === false ? 'Failed' : g.ready ? 'Ready' : 'Unknown'}</StatusLabel>;
                },
              },
              { label: 'Revision', getter: (g: GitOpsApp) => g.revision ?? '—' },
              { label: 'Message', getter: (g: GitOpsApp) => g.message ?? '—' },
            ]}
            data={gitops}
          />
        )}
      </SectionBox>
    </>
  );
}

/* ---------------- Security ---------------- */

const KINDS = Object.keys(SECURITY_KIND_LABEL) as SecurityKind[];

function PostureDialog({
  cluster,
  ns,
  contextName,
  onClose,
  onDone,
}: {
  cluster: string;
  ns: NamespacePosture;
  contextName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [level, setLevel] = React.useState<PssLevel>('baseline');
  const [mode, setMode] = React.useState<'warn' | 'enforce'>('warn');
  const [go, setGo] = React.useState(false);
  const refused = ns.refused[level];
  if (go) {
    return <ActionDialog plan={podSecurityPlan(cluster, ns, level, mode)} writer={headlampWriter(contextName)} onClose={onClose} onApplied={onDone} />;
  }
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Pod Security for {ns.name}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Typography variant="body2">
            Now: enforce <b>{ns.enforce ?? 'not set'}</b>, warn <b>{ns.warn ?? 'not set'}</b>. Start with warn to see what would break;
            enforce refuses new pods that break the level (running pods keep running).
          </Typography>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField select size="small" label="Level" value={level} onChange={e => setLevel(e.target.value as PssLevel)} sx={{ minWidth: 160 }}>
              <MenuItem value="baseline">baseline</MenuItem>
              <MenuItem value="restricted">restricted</MenuItem>
            </TextField>
            <TextField select size="small" label="Mode" value={mode} onChange={e => setMode(e.target.value as 'warn' | 'enforce')} sx={{ minWidth: 200 }}>
              <MenuItem value="warn">Warn and audit only</MenuItem>
              <MenuItem value="enforce">Enforce</MenuItem>
            </TextField>
          </Box>
          <Typography sx={{ fontWeight: 600 }}>
            Preview: {refused.length ? `${refused.length} of ${ns.pods} running pods break "${level}"` : `all ${ns.pods} running pods meet "${level}"`}
          </Typography>
          {refused.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2, maxHeight: 220, overflowY: 'auto' }}>
              {refused.map(r => (
                <li key={r.pod}>
                  <Typography variant="body2">
                    <b>{r.pod}</b>: {r.reasons.join(', ')}
                  </Typography>
                </li>
              ))}
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => setGo(true)}>
          Continue
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function findingsCsv(scans: ClusterScan[], silences: Silence[]): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ['cluster,severity,check,finding,objects,accepted_until,accepted_reason'];
  for (const s of scans) {
    for (const f of s.security) {
      const sil = silences.find(x => x.match.issueId === securityIssueId(s.clusterKey, f));
      lines.push([q(s.clusterName), f.severity, q(SECURITY_KIND_LABEL[f.kind]), q(f.title), q(f.objects.join('; ')), sil?.until ?? '', q(sil?.reason ?? '')].join(','));
    }
  }
  return lines.join('\n');
}

export function SecurityPage() {
  const { config, canWrite, refresh } = useFleetData();
  const { scans, clusters, loading, health } = useScans();
  const baseline = config.baseline!;
  const [text, setText] = React.useState(baseline.allowedRegistries.join(', '));
  const [silencing, setSilencing] = React.useState<{ issueId: string; label: string } | null>(null);
  const [posture, setPosture] = React.useState<{ scan: ClusterScan; ns: NamespacePosture } | null>(null);
  const [deny, setDeny] = React.useState<{ scan: ClusterScan; ns: NamespacePosture; variant: 'other-namespaces' | 'all' } | null>(null);
  if (loading || !scans) return <Loader title="Checking security posture" />;
  const silences = activeSilences(config.silences);
  const accepted = (s: ClusterScan, f: SecurityFinding) => silences.find(x => x.match.issueId === securityIssueId(s.clusterKey, f));
  const findings = scans.flatMap(s => s.security.filter(f => !accepted(s, f)));
  const sev = (x: SecurityFinding['severity']) => findings.filter(f => f.severity === x).length;
  const byCluster = new Map(clusters.map(c => [c.key, c]));
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Security posture"
        headerProps={{
          actions: [
            <Button key="csv" size="small" variant="outlined" onClick={() => download(`vks-security-${stamp}.csv`, findingsCsv(scans, silences), 'text/csv')}>
              Export CSV
            </Button>,
          ],
        }}
      >
        <SignInHelper clusters={clusters} health={health} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Each signed-in cluster, checked for: Pod Security levels, privileged or host-level pods, cluster-admin, wildcard roles and
          Secret readers granted to people or apps, images outside your registries or on "latest", pods that may run as root,
          namespaces without network policies, services exposed outside, and certificates. A first look, not a full audit.
          Accepted findings stay listed but stop raising issues until their acceptance expires.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2, mb: 2 }}>
          <KpiTile label="Critical" value={sev('critical')} tone={sev('critical') ? 'error' : 'success'} />
          <KpiTile label="Warnings" value={sev('warning')} tone={sev('warning') ? 'warning' : 'success'} />
          <KpiTile label="Notes" value={sev('info')} tone="info" />
          <KpiTile label="Accepted" value={scans.reduce((n, s) => n + s.security.filter(f => accepted(s, f)).length, 0)} tone="neutral" />
          <KpiTile label="Clusters checked" value={scans.length} sub={`of ${clusters.length}`} tone="primary" />
        </Box>
        <TextField
          size="small"
          fullWidth
          label="Allowed image registries (comma separated; empty = don't check)"
          placeholder="projects.registry.vmware.com, harbor.example.com/library"
          value={text}
          onChange={e => {
            setText(e.target.value);
            settingsStore.update({ baseline: { ...baseline, allowedRegistries: e.target.value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean) } });
          }}
          helperText="Kept with the fleet baseline. A registry host (harbor.example.com) or a path prefix (harbor.example.com/library)."
        />
      </SectionBox>

      {scans.length > 0 && (
        <SectionBox title="Across the fleet">
          <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: '4px', fontSize: '0.85rem', minWidth: '100%' }}>
              <thead>
                <tr>
                  <Box component="th" sx={{ textAlign: 'left', p: 1 }}>
                    Cluster
                  </Box>
                  {KINDS.map(k => (
                    <Box component="th" key={k} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>
                      {SECURITY_KIND_LABEL[k]}
                    </Box>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scans.map(s => (
                  <tr key={s.clusterKey}>
                    <Box component="td" sx={{ p: 1, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {s.clusterName}
                    </Box>
                    {KINDS.map(k => {
                      const fs = s.security.filter(f => f.kind === k && !accepted(s, f));
                      const n = fs.reduce((a, f) => a + f.objects.length, 0);
                      const worst = fs.some(f => f.severity === 'critical') ? 'error' : fs.some(f => f.severity === 'warning') ? 'warning' : fs.length ? 'info' : 'success';
                      return (
                        <Box
                          component="td"
                          key={k}
                          title={fs.map(f => f.title).join('\n') || 'Nothing found'}
                          sx={{ p: 1, textAlign: 'center', borderRadius: 1, bgcolor: 'action.hover', borderBottom: '3px solid', borderBottomColor: `${worst}.main` }}
                        >
                          {n || '✓'}
                        </Box>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Box>
          </Box>
        </SectionBox>
      )}

      {scans.map(s => {
        const c = byCluster.get(s.clusterKey);
        const writeOk = !!c && canWrite(c.supervisorId);
        const list = [...s.security].sort(
          (a, b) => ['critical', 'warning', 'info'].indexOf(a.severity) - ['critical', 'warning', 'info'].indexOf(b.severity)
        );
        return (
          <SectionBox key={s.clusterKey} title={s.clusterName}>
            {s.errors.length > 0 && (
              <Alert severity="info" sx={{ mb: 1 }}>
                Partly checked: {s.errors.slice(0, 3).join('; ')}
              </Alert>
            )}
            {list.length === 0 ? (
              <Typography color="text.secondary">Nothing found.</Typography>
            ) : (
              <SimpleTable
                columns={[
                  {
                    label: 'Severity',
                    getter: (f: SecurityFinding) => {
                      const a = accepted(s, f);
                      return a ? (
                        <StatusLabel status="">{`Accepted until ${a.until.slice(0, 10)}`}</StatusLabel>
                      ) : (
                        <StatusLabel status={f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warning' : ''}>{f.severity}</StatusLabel>
                      );
                    },
                  },
                  { label: 'Finding', getter: (f: SecurityFinding) => f.title },
                  { label: 'Why it matters', getter: (f: SecurityFinding) => f.detail },
                  {
                    label: 'Where',
                    getter: (f: SecurityFinding) => (
                      <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                        {f.objects.slice(0, 4).join(', ')}
                        {f.objects.length > 4 ? ` +${f.objects.length - 4} more` : ''}
                      </Typography>
                    ),
                  },
                  {
                    label: '',
                    getter: (f: SecurityFinding) => {
                      const a = accepted(s, f);
                      return a ? (
                        <Button size="small" onClick={() => removeSilence(a.id)} title={a.reason}>
                          Un-accept
                        </Button>
                      ) : (
                        <Button size="small" onClick={() => setSilencing({ issueId: securityIssueId(s.clusterKey, f), label: `${f.title} in ${s.clusterName}` })}>
                          Accept…
                        </Button>
                      );
                    },
                  },
                ]}
                data={list}
              />
            )}
            {s.namespaces.length > 0 && (
              <Box sx={{ mt: 2 }}>
                <Typography sx={{ fontWeight: 600, mb: 1 }}>Namespaces</Typography>
                <SimpleTable
                  columns={[
                    { label: 'Namespace', getter: (n: NamespacePosture) => n.name },
                    {
                      label: 'Pod Security',
                      getter: (n: NamespacePosture) =>
                        n.enforce ? (
                          <StatusLabel status={n.enforce === 'privileged' ? 'error' : 'success'}>{`enforce ${n.enforce}`}</StatusLabel>
                        ) : n.warn ? (
                          <StatusLabel status="warning">{`warn ${n.warn}`}</StatusLabel>
                        ) : (
                          <StatusLabel status="warning">not set</StatusLabel>
                        ),
                    },
                    { label: 'Pods', getter: (n: NamespacePosture) => n.pods },
                    {
                      label: 'Would break',
                      getter: (n: NamespacePosture) => `baseline ${n.refused.baseline.length} · restricted ${n.refused.restricted.length}`,
                    },
                    { label: 'Network policies', getter: (n: NamespacePosture) => (n.netpols ? n.netpols : <StatusLabel status="warning">none</StatusLabel>) },
                    { label: 'Exposed', getter: (n: NamespacePosture) => n.exposed.join(', ') || '—' },
                    {
                      label: 'Actions',
                      getter: (n: NamespacePosture) =>
                        writeOk ? (
                          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                            <Button size="small" onClick={() => setPosture({ scan: s, ns: n })}>
                              Pod Security…
                            </Button>
                            {!n.netpols && (
                              <>
                                <Button size="small" onClick={() => setDeny({ scan: s, ns: n, variant: 'other-namespaces' })}>
                                  Isolate
                                </Button>
                                <Button size="small" onClick={() => setDeny({ scan: s, ns: n, variant: 'all' })}>
                                  Deny all
                                </Button>
                              </>
                            )}
                          </Box>
                        ) : (
                          '—'
                        ),
                    },
                  ]}
                  data={s.namespaces}
                />
              </Box>
            )}
            {c && (
              <Button size="small" sx={{ mt: 1 }} component={Link} to={clusterDeepLink(c, { hash: 'checks' })}>
                Best-practice checks for {c.name}
              </Button>
            )}
          </SectionBox>
        );
      })}

      {silencing && <SilenceDialog match={{ issueId: silencing.issueId }} label={silencing.label} onClose={() => setSilencing(null)} />}
      {posture && (
        <PostureDialog
          cluster={posture.scan.clusterName}
          ns={posture.ns}
          contextName={posture.scan.contextName}
          onClose={() => setPosture(null)}
          onDone={() => refresh()}
        />
      )}
      {deny && (
        <ActionDialog
          plan={defaultDenyPlan(deny.scan.clusterName, deny.ns, deny.variant)}
          writer={headlampWriter(deny.scan.contextName)}
          onClose={() => setDeny(null)}
          onApplied={() => refresh()}
        />
      )}
    </>
  );
}

/* ---------------- Showback ---------------- */

export function ShowbackPage() {
  const { results, inventory } = useFleetData();
  if (!results) return <Loader title="Loading" />;
  const rows = showback(results, inventory);
  const total = showbackTotals(rows);
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  return (
    <SectionBox
      title="Showback"
      headerProps={{
        actions: [
          <Button key="csv" size="small" variant="outlined" onClick={() => download(`vks-showback-${stamp}.csv`, showbackCsv(rows, now), 'text/csv')}>
            CSV
          </Button>,
          <Button key="md" size="small" variant="outlined" onClick={() => download(`vks-showback-${stamp}.md`, showbackMarkdown(rows, now), 'text/markdown')}>
            Markdown
          </Button>,
        ],
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        What each org holds right now: cluster nodes and VM Service VMs by VM class size, storage quota use and volumes,
        load balancers and public addresses. Export monthly for chargeback; history over time needs the companion service
        (on the roadmap).
      </Typography>
      {inventory === null && <Loader title="Reading VMs and storage" />}
      <SimpleTable
        columns={[
          { label: 'Org', getter: (r: ShowbackRow) => (r === total ? <b>Total</b> : r.tenantName) },
          { label: 'Namespaces', getter: (r: ShowbackRow) => r.namespaces },
          { label: 'Clusters', getter: (r: ShowbackRow) => r.clusters },
          { label: 'Nodes', getter: (r: ShowbackRow) => r.nodes },
          { label: 'VMs', getter: (r: ShowbackRow) => r.vms },
          { label: 'vCPU', getter: (r: ShowbackRow) => r.vcpu },
          { label: 'Memory', getter: (r: ShowbackRow) => formatBytes(r.memoryBytes) },
          { label: 'Storage (quota)', getter: (r: ShowbackRow) => (r.storageLimit ? `${formatBytes(r.storageUsed)} of ${formatBytes(r.storageLimit)}` : formatBytes(r.storageUsed)) },
          { label: 'Volumes', getter: (r: ShowbackRow) => formatBytes(r.volumesBytes) },
          { label: 'Load balancers', getter: (r: ShowbackRow) => r.loadBalancers },
          { label: 'Public IPs', getter: (r: ShowbackRow) => r.publicIPs },
        ]}
        data={rows.length > 1 ? [...rows, total] : rows}
      />
    </SectionBox>
  );
}
