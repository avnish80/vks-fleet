import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import { Link } from 'react-router-dom';
import { PACKAGES_PATH, UPGRADES_PATH } from '../routes';
import React from 'react';
import { useFleetData } from '../fleetContext';
import { download } from '../report';
import { FleetCve, FleetImage, fleetImages, ImageOwner, Sev, topCves, VksSourceSummary, vksSummary } from '../scanners';
import { useScannerReports } from '../useScannerReports';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';
import { NoClusters } from './EmptyState';
import { SignInHelper } from './SignInHelper';

const SEV_TONE: Record<Sev, 'error' | 'warning' | ''> = { CRITICAL: 'error', HIGH: 'warning', MEDIUM: '', LOW: '', UNKNOWN: '' };

const TRIVY_INSTALL = `helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm install trivy-operator aqua/trivy-operator -n trivy-system --create-namespace \\
  --set trivy.ignoreUnfixed=false
# air-gapped: mirror the trivy-operator and trivy images and the vulnerability DB, and set their repositories`;

export function VulnerabilitiesPage() {
  const { config, results } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const reports = useScannerReports(targets);
  const [showAll, setShowAll] = React.useState(false);
  const [view, setView] = React.useState<'you' | 'vks' | 'all' | null>(null);
  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Vulnerabilities" what="vulnerability information" />;
  if (targets.length > 0 && reports === null) return <Loader title="Reading scanner reports" />;
  const list = reports ?? [];
  const withTrivy = list.filter(r => r.trivy);
  const without = list.filter(r => !r.trivy);
  // Default to the cluster owners' own images when there are any: those are the ones they can fix.
  const hasOwn = withTrivy.some(r => r.images.some(i => i.owner === 'you'));
  const shown: 'you' | 'vks' | 'all' = view ?? (hasOwn ? 'you' : 'all');
  const ownerFilter: ImageOwner | undefined = shown === 'all' ? undefined : shown;
  const cves = topCves(withTrivy, ownerFilter);
  const images = fleetImages(withTrivy, ownerFilter);
  const vks = vksSummary(withTrivy);
  const sum = (k: Sev) => images.reduce((n, i) => n + i.counts[k], 0);
  const fixableCritical = cves.filter(c => c.severity === 'CRITICAL' && c.fixed).length;
  const secrets = withTrivy.flatMap(r => r.exposedSecrets.map(x => ({ ...x, cluster: r.clusterName })));
  const audits = withTrivy.flatMap(r => r.audits.filter(a => !ownerFilter || a.owner === ownerFilter).map(a => ({ ...a, cluster: r.clusterName })));
  const viewLabel = shown === 'you' ? 'your images' : shown === 'vks' ? 'VKS-managed images' : 'all images';
  const stamp = new Date().toISOString().slice(0, 10);
  const csv = () =>
    ['cve,severity,fixed_version,clusters,images,workloads,title']
      .concat(cves.map(c => [c.id, c.severity, c.fixed ?? '', c.clusters.size, c.images.size, c.workloads.size, `"${(c.title ?? '').replace(/"/g, '""')}"`].join(',')))
      .join('\n');

  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Vulnerabilities"
        headerProps={{
          actions: [
            <Button key="csv" size="small" variant="outlined" disabled={!cves.length} onClick={() => download(`vks-cves-${stamp}.csv`, csv(), 'text/csv')}>
              Export CSV
            </Button>,
          ],
        }}
      >
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Image vulnerabilities, misconfigurations and secrets baked into images, from the reports <b>Trivy Operator</b> writes into
          each cluster. The plugin only reads them; install Trivy Operator in the clusters you want covered.
        </Typography>
        {withTrivy.length > 0 && (
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', mb: 2 }}>
            <TextField select size="small" label="Show" value={shown} onChange={e => setView(e.target.value as 'you' | 'vks' | 'all')} sx={{ minWidth: 260 }}>
              <MenuItem value="you">Your images (you fix these)</MenuItem>
              <MenuItem value="vks">VKS-managed images</MenuItem>
              <MenuItem value="all">Everything</MenuItem>
            </TextField>
            <Typography variant="body2" color="text.secondary">
              VKS-managed images (from VKS releases and standard packages, or in platform namespaces) are rebuilt by VKS; yours are
              rebuilt by your teams.
            </Typography>
          </Box>
        )}
        {withTrivy.length > 0 && (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2 }}>
            <KpiTile label="Critical" value={sum('CRITICAL')} sub={`${viewLabel}; ${fixableCritical} distinct CVEs fixable`} tone={sum('CRITICAL') ? 'error' : 'success'} />
            <KpiTile label="High" value={sum('HIGH')} sub={viewLabel} tone={sum('HIGH') ? 'warning' : 'success'} />
            <KpiTile label="Images" value={images.length} sub={`${viewLabel}, in ${withTrivy.length} cluster${withTrivy.length === 1 ? '' : 's'}`} tone="primary" />
            <KpiTile label="Secrets in images" value={secrets.length} tone={secrets.length ? 'error' : 'success'} />
            <KpiTile label="Misconfigured workloads" value={audits.length} tone={audits.length ? 'warning' : 'success'} />
          </Box>
        )}
        {without.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Trivy Operator isn't installed in: {without.map(r => r.clusterName).join(', ')}. To cover them:
            </Typography>
            <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: '0.78rem', whiteSpace: 'pre-wrap' }}>
              {TRIVY_INSTALL}
            </Box>
          </Alert>
        )}
      </SectionBox>

      {vks.length > 0 && <VksSummarySection vks={vks} />}

      {shown === 'you' && hasOwn === false && withTrivy.length > 0 && (
        <SectionBox title="Your images">
          <Typography color="text.secondary">No images of yours have been scanned yet: everything scanned so far is VKS-managed.</Typography>
        </SectionBox>
      )}

      {cves.length > 0 && (
        <SectionBox title={`Top vulnerabilities (${viewLabel})`}>
          <SimpleTable
            columns={[
              {
                label: 'CVE',
                getter: (c: FleetCve) =>
                  c.link ? (
                    <a href={c.link} target="_blank" rel="noopener noreferrer">
                      {c.id}
                    </a>
                  ) : (
                    c.id
                  ),
              },
              { label: 'Severity', getter: (c: FleetCve) => <StatusLabel status={SEV_TONE[c.severity]}>{c.severity}</StatusLabel> },
              { label: 'Fix', getter: (c: FleetCve) => (c.fixed ? <StatusLabel status="success">{c.fixed}</StatusLabel> : 'none yet') },
              { label: 'Clusters', getter: (c: FleetCve) => Array.from(c.clusters).join(', ') },
              { label: 'Images', getter: (c: FleetCve) => c.images.size },
              { label: 'Workloads', getter: (c: FleetCve) => c.workloads.size },
              { label: 'What', getter: (c: FleetCve) => c.title ?? '—' },
            ]}
            data={showAll ? cves : cves.slice(0, 25)}
          />
          {cves.length > 25 && (
            <Button size="small" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show the top 25' : `Show all ${cves.length}`}
            </Button>
          )}
        </SectionBox>
      )}

      {images.length > 0 && (
        <SectionBox title="Images">
          <SimpleTable
            columns={[
              { label: 'Image', getter: (i: FleetImage) => <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{i.image}</Typography> },
              { label: 'Owner', getter: (i: FleetImage) => (i.owner === 'vks' ? `VKS (${i.source ?? 'platform'})` : 'Yours') },
              {
                label: 'Critical / high / medium',
                getter: (i: FleetImage) => (
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <StatusLabel status={i.counts.CRITICAL ? 'error' : 'success'}>{String(i.counts.CRITICAL)}</StatusLabel>
                    <StatusLabel status={i.counts.HIGH ? 'warning' : 'success'}>{String(i.counts.HIGH)}</StatusLabel>
                    <StatusLabel status="">{String(i.counts.MEDIUM)}</StatusLabel>
                  </Box>
                ),
              },
              { label: 'Fixable', getter: (i: FleetImage) => i.fixable },
              { label: 'Clusters', getter: (i: FleetImage) => Array.from(i.clusters).join(', ') },
              { label: 'Used by', getter: (i: FleetImage) => Array.from(i.workloads).slice(0, 3).join('; ') + (i.workloads.size > 3 ? ` +${i.workloads.size - 3}` : '') },
            ]}
            data={images.slice(0, 100)}
          />
        </SectionBox>
      )}

      {secrets.length > 0 && (
        <SectionBox title="Secrets baked into images">
          <Alert severity="error" sx={{ mb: 1 }}>
            Anyone who can pull these images can read what's inside. Rotate the credentials, then rebuild without them.
          </Alert>
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (x: (typeof secrets)[number]) => x.cluster },
              { label: 'Image', getter: (x: (typeof secrets)[number]) => x.image },
              { label: 'Workload', getter: (x: (typeof secrets)[number]) => x.workload },
              { label: 'Findings', getter: (x: (typeof secrets)[number]) => x.count },
            ]}
            data={secrets}
          />
        </SectionBox>
      )}

      {audits.length > 0 && (
        <SectionBox title="Workload configuration (Trivy config audits)">
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (a: (typeof audits)[number]) => a.cluster },
              { label: 'Workload', getter: (a: (typeof audits)[number]) => `${a.namespace}/${a.workload}` },
              {
                label: 'Failed checks',
                getter: (a: (typeof audits)[number]) =>
                  a.failed
                    .slice(0, 4)
                    .map(f => `${f.id} ${f.title}`)
                    .join('; ') + (a.failed.length > 4 ? ` +${a.failed.length - 4}` : ''),
              },
              {
                label: 'Worst',
                getter: (a: (typeof audits)[number]) => {
                  const w = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as Sev[]).find(s => a.failed.some(f => f.severity === s)) ?? 'UNKNOWN';
                  return <StatusLabel status={SEV_TONE[w]}>{w}</StatusLabel>;
                },
              },
            ]}
            data={audits.slice(0, 100)}
          />
        </SectionBox>
      )}
    </>
  );
}

/** VKS-managed images, grouped by where they come from, with what to do about them. */
function VksSummarySection({ vks }: { vks: VksSourceSummary[] }) {
  return (
    <SectionBox
      title="VKS-managed images"
      headerProps={{
        actions: [
          <Button key="pk" size="small" variant="outlined" component={Link} to={PACKAGES_PATH}>
            Packages
          </Button>,
          <Button key="up" size="small" variant="outlined" component={Link} to={UPGRADES_PATH}>
            Upgrades
          </Button>,
        ],
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        These come from VKS releases and standard packages; they're fixed by a newer package version or VKS release, not by
        rebuilding. Check the Packages page for a newer version in your repositories. A CVE in a library an image contains
        (curl, for example) matters only if the component uses the affected feature.
      </Typography>
      <SimpleTable
        columns={[
          { label: 'Source', getter: (v: VksSourceSummary) => <b>{v.source}</b> },
          { label: 'Images', getter: (v: VksSourceSummary) => v.images },
          { label: 'Critical', getter: (v: VksSourceSummary) => <StatusLabel status={v.critical ? 'error' : 'success'}>{String(v.critical)}</StatusLabel> },
          { label: 'High', getter: (v: VksSourceSummary) => <StatusLabel status={v.high ? 'warning' : 'success'}>{String(v.high)}</StatusLabel> },
          { label: 'Fix published upstream', getter: (v: VksSourceSummary) => (v.fixable ? `${v.fixable} findings` : 'none yet') },
          { label: 'Where', getter: (v: VksSourceSummary) => `${Array.from(v.clusters).join(', ')}: ${Array.from(v.namespaces).join(', ')}` },
        ]}
        data={vks}
      />
    </SectionBox>
  );
}

