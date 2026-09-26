import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, FormControlLabel, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { AppGroup, ClusterScan, GitOpsApp, groupApps, SecurityFinding } from '../clusterScan';
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
function useScans(): { scans: ClusterScan[] | null; clusters: FleetCluster[]; notSignedIn: FleetCluster[]; loading: boolean } {
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
  const { scans, clusters, notSignedIn, loading } = useScans();
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

export function SecurityPage() {
  const { config } = useFleetData();
  const { scans, clusters, notSignedIn, loading } = useScans();
  const baseline = config.baseline!;
  const [text, setText] = React.useState(baseline.allowedRegistries.join(', '));
  if (loading || !scans) return <Loader title="Checking security posture" />;
  const findings = scans.flatMap(s => s.security);
  const byCluster = new Map(clusters.map(c => [c.key, c]));
  const sev = (s: SecurityFinding['severity']) => findings.filter(f => f.severity === s).length;
  return (
    <>
      <ChartStyles />
      <SectionBox title="Security posture">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A quick check of each signed-in cluster: Pod Security levels, privileged or host-level pods, cluster-admin grants to
          people or apps, images from registries outside your list or on "latest", and cert-manager certificates. It's a
          first look, not a full audit (CIS benchmarks and image scanning need dedicated tools).
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 2, mb: 2 }}>
          <KpiTile label="Critical" value={sev('critical')} tone={sev('critical') ? 'error' : 'success'} />
          <KpiTile label="Warnings" value={sev('warning')} tone={sev('warning') ? 'warning' : 'success'} />
          <KpiTile label="Notes" value={sev('info')} tone="info" />
          <KpiTile label="Clusters checked" value={scans.length} sub={notSignedIn.length ? `${notSignedIn.length} not signed in` : 'all signed in'} tone="primary" />
        </Box>
        {(
          <TextField
            size="small"
            fullWidth
            label="Allowed image registries (comma separated; empty = don't check)"
            placeholder="projects.registry.vmware.com, harbor.example.com/library"
            value={text}
            onChange={e => {
              setText(e.target.value);
              settingsStore.update({
                baseline: { ...baseline, allowedRegistries: e.target.value.split(/[\s,]+/).map(x => x.trim()).filter(Boolean) },
              });
            }}
            helperText="Kept with the fleet baseline. A registry host (harbor.example.com) or a path prefix (harbor.example.com/library)."
          />
        )}
        <SignInNote notSignedIn={notSignedIn} />
      </SectionBox>
      {scans.map(s => {
        const c = byCluster.get(s.clusterKey);
        const list = s.security.sort((a, b) => ['critical', 'warning', 'info'].indexOf(a.severity) - ['critical', 'warning', 'info'].indexOf(b.severity));
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
                    getter: (f: SecurityFinding) => (
                      <StatusLabel status={f.severity === 'critical' ? 'error' : f.severity === 'warning' ? 'warning' : ''}>{f.severity}</StatusLabel>
                    ),
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
                ]}
                data={list}
              />
            )}
            {c && (
              <Button size="small" sx={{ mt: 1 }} component={Link} to={clusterDeepLink(c, { hash: 'checks' })}>
                Best-practice checks for {c.name}
              </Button>
            )}
          </SectionBox>
        );
      })}
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
