import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';
import { useFleetData } from '../fleetContext';
import { download } from '../report';
import { FleetCve, FleetImage, fleetImages, Sev, topCves } from '../scanners';
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
  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Vulnerabilities" what="vulnerability information" />;
  if (targets.length > 0 && reports === null) return <Loader title="Reading scanner reports" />;
  const list = reports ?? [];
  const withTrivy = list.filter(r => r.trivy);
  const without = list.filter(r => !r.trivy);
  const cves = topCves(withTrivy);
  const images = fleetImages(withTrivy);
  const sum = (k: Sev) => images.reduce((n, i) => n + i.counts[k], 0);
  const fixableCritical = cves.filter(c => c.severity === 'CRITICAL' && c.fixed).length;
  const secrets = withTrivy.flatMap(r => r.exposedSecrets.map(x => ({ ...x, cluster: r.clusterName })));
  const audits = withTrivy.flatMap(r => r.audits.map(a => ({ ...a, cluster: r.clusterName })));
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
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2 }}>
            <KpiTile label="Critical" value={sum('CRITICAL')} sub={`${fixableCritical} distinct CVEs fixable`} tone={sum('CRITICAL') ? 'error' : 'success'} />
            <KpiTile label="High" value={sum('HIGH')} tone={sum('HIGH') ? 'warning' : 'success'} />
            <KpiTile label="Images scanned" value={images.length} sub={`in ${withTrivy.length} cluster${withTrivy.length === 1 ? '' : 's'}`} tone="primary" />
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

      {cves.length > 0 && (
        <SectionBox title="Top vulnerabilities across the fleet">
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
