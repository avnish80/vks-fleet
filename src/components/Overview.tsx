import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { formatDuration } from '../capi/v1beta1';
import {
  bucketOf,
  certRows,
  healthSlices,
  overviewNumbers,
  recentChanges,
  tenantHealth,
} from '../overview';
import { formatBytes } from '../quantity';
import { clusterPath } from '../routes';
import { rollupByTenant, versionSpread } from '../summary';
import { FleetCluster, Health, Scorecard, Severity } from '../types';
import { BarList, ChartCard, ChartStyles, Donut, EmptyChart, KpiTile, Legend, Tone } from './charts';

const HEALTH_LABEL: Record<Health, { label: string; tone: Tone }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  failed: { label: 'Failed', tone: 'error' },
  unknown: { label: 'Unknown', tone: 'warning' },
  provisioning: { label: 'Provisioning', tone: 'info' },
  deleting: { label: 'Deleting', tone: 'neutral' },
};

function certTone(days: number): Tone {
  if (days < 7) return 'error';
  if (days < 30) return 'warning';
  return 'success';
}

export function Overview({
  clusters,
  findings,
  title,
  onTenant,
  supervisors,
  onSupervisor,
  scores,
}: {
  clusters: FleetCluster[];
  /** Issues (or findings): anything with a severity. */
  findings: Array<{ severity: Severity }>;
  /** Checks scorecards for the clusters shown. */
  scores?: Array<{ cluster: FleetCluster; card: Scorecard }>;
  title: string;
  /** Called when a tenant bar is clicked; omit to make bars inert. */
  onTenant?: (tenantId: string) => void;
  /** Per-Supervisor breakdown, shown when there's more than one. */
  supervisors?: Array<{ id: string; name: string; error?: string; clusters: FleetCluster[] }>;
  onSupervisor?: (id: string) => void;
}) {
  const now = new Date();
  const n = overviewNumbers(clusters, findings);
  const slices = healthSlices(clusters).map(s => ({ ...HEALTH_LABEL[s.health], value: s.count }));
  const tenants = tenantHealth(clusters);
  const rollups = rollupByTenant(clusters);
  const versions = versionSpread(clusters);
  const certs = certRows(clusters, now);
  const changes = recentChanges(clusters);
  const actionable = n.findings.critical + n.findings.warning;

  return (
    <SectionBox title={title}>
      <ChartStyles />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 2, mb: 2 }}>
        <KpiTile
          label="Clusters"
          value={n.clusters}
          sub={n.attention ? `${n.attention} need${n.attention === 1 ? 's' : ''} attention` : 'All healthy'}
          tone={n.attention ? 'warning' : 'success'}
          meter={{ value: n.healthy, max: n.clusters, tone: 'success' }}
        />
        <KpiTile
          label="Nodes ready"
          value={`${n.nodes.ready}/${n.nodes.total}`}
          sub={n.nodes.deleting ? `${n.nodes.deleting} being deleted` : 'Control plane and workers'}
          tone={n.nodes.ready < n.nodes.total ? 'warning' : 'success'}
          meter={{ value: n.nodes.ready, max: n.nodes.total }}
        />
        <KpiTile
          label="Node capacity"
          value={`${n.cpus} vCPU`}
          sub={`${formatBytes(n.memoryBytes)} memory`}
          tone="primary"
        />
        <KpiTile label="Tenants" value={n.tenants} sub={`${n.clusters} cluster${n.clusters === 1 ? '' : 's'} between them`} tone="info" />
        <KpiTile
          label="Issues"
          value={actionable}
          sub={
            actionable
              ? `${n.findings.critical} critical, ${n.findings.warning} warning${n.findings.warning === 1 ? '' : 's'}`
              : 'Nothing needs action'
          }
          tone={n.findings.critical ? 'error' : n.findings.warning ? 'warning' : 'success'}
        />
        <KpiTile
          label="Upgrades"
          value={n.upgradable}
          sub={n.upgrading ? `${n.upgrading} in progress` : 'Newer releases available'}
          tone="info"
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 2 }}>
        {supervisors && supervisors.length > 1 && (
          <ChartCard title="Clusters by Supervisor" caption={onSupervisor ? 'Click a Supervisor to show only its clusters' : undefined}>
            <BarList
              rows={supervisors.map(s => {
                const count = (b: 'healthy' | 'attention' | 'changing') =>
                  s.clusters.filter(c => bucketOf(c.health) === b).length;
                return {
                  key: s.id,
                  label: s.name,
                  title: s.error ? `${s.name}: ${s.error}` : undefined,
                  parts: [
                    { label: 'Healthy', value: count('healthy'), tone: 'success' as Tone },
                    { label: 'Needs attention', value: count('attention'), tone: 'warning' as Tone },
                    { label: 'Changing', value: count('changing'), tone: 'info' as Tone },
                  ],
                  valueText: s.error ? 'Unreachable' : s.clusters.length,
                  onClick: onSupervisor ? () => onSupervisor(s.id) : undefined,
                };
              })}
            />
          </ChartCard>
        )}

        <ChartCard title="Cluster health" caption="From the Supervisor's view of each cluster">
          {clusters.length ? (
            <Donut slices={slices} centre={n.clusters} centreSub={n.clusters === 1 ? 'cluster' : 'clusters'} />
          ) : (
            <EmptyChart text="No clusters yet." />
          )}
        </ChartCard>

        <ChartCard
          title="Clusters by tenant"
          caption={onTenant && tenants.length > 1 ? 'Click a tenant to show only its clusters' : undefined}
        >
          {tenants.length ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <BarList
                rows={tenants.map(t => ({
                  key: t.tenantId,
                  label: t.tenantName,
                  title: `${t.tenantName}: ${t.healthy} healthy, ${t.attention} need attention, ${t.changing} changing`,
                  parts: [
                    { label: 'Healthy', value: t.healthy, tone: 'success' },
                    { label: 'Needs attention', value: t.attention, tone: 'warning' },
                    { label: 'Changing', value: t.changing, tone: 'info' },
                  ],
                  valueText: t.total,
                  onClick: onTenant && tenants.length > 1 ? () => onTenant(t.tenantId) : undefined,
                }))}
              />
              <Legend
                items={[
                  { label: 'Healthy', tone: 'success' },
                  { label: 'Needs attention', tone: 'warning' },
                  { label: 'Provisioning or deleting', tone: 'info' },
                ]}
              />
            </Box>
          ) : (
            <EmptyChart text="No tenants yet." />
          )}
        </ChartCard>

        <ChartCard title="Kubernetes versions" caption="Desired version per cluster">
          {versions.length ? (
            <BarList
              rows={versions.map(v => ({
                key: v.version,
                label: v.version,
                parts: [{ label: 'Clusters', value: v.count, tone: 'primary' }],
                valueText: v.count,
              }))}
            />
          ) : (
            <EmptyChart text="No versions reported." />
          )}
        </ChartCard>

        <ChartCard title="Node capacity by tenant" caption="vCPU from VM class sizes; memory alongside">
          {rollups.some(r => r.cpus) ? (
            <BarList
              rows={rollups.map(r => ({
                key: r.tenantId,
                label: r.tenantName,
                parts: [{ label: 'vCPU', value: r.cpus, tone: 'primary' }],
                valueText: `${r.cpus} vCPU, ${formatBytes(r.memoryBytes)}`,
                onClick: onTenant && rollups.length > 1 ? () => onTenant(r.tenantId) : undefined,
              }))}
            />
          ) : (
            <EmptyChart text="VM sizes aren't readable yet." />
          )}
        </ChartCard>

        <ChartCard title="Certificate expiry" caption="Days left on control-plane certificates (bar scale: one year)">
          {certs.length ? (
            <BarList
              max={365}
              rows={certs.map(r => ({
                key: r.key,
                label: <Link to={clusterPath(r.cluster)}>{r.cluster.name}</Link>,
                title: `${r.cluster.name}: expires ${new Date(r.cluster.certificatesExpiry as string).toLocaleDateString()}, rotation ${
                  r.rotating ? 'on' : 'off'
                }`,
                parts: [{ label: 'Days left', value: Math.max(0, Math.min(r.daysLeft, 365)), tone: certTone(r.daysLeft) }],
                valueText: `${r.daysLeft}d${r.rotating ? '' : ' (no rotation)'}`,
              }))}
            />
          ) : (
            <EmptyChart text="No certificate dates reported." />
          )}
        </ChartCard>

        <ChartCard title="Checks score" caption="Best-practice score per cluster, lowest first">
          {scores && scores.length ? (
            <BarList
              max={100}
              rows={[...scores]
                .sort((a, b) => a.card.score - b.card.score)
                .slice(0, 8)
                .map(s => ({
                  key: s.cluster.key,
                  label: <Link to={`${clusterPath(s.cluster)}#checks`}>{s.cluster.name}</Link>,
                  title: `${s.cluster.name}: ${s.card.score}/100 over ${s.card.evaluated} of ${s.card.total} checks`,
                  parts: [{ label: 'Score', value: s.card.score, tone: s.card.score >= 80 ? 'success' : s.card.score >= 60 ? 'warning' : 'error' }],
                  valueText: s.card.score,
                }))}
            />
          ) : (
            <EmptyChart text="No clusters to score." />
          )}
        </ChartCard>

        <ChartCard title="Recent changes" caption="Actions taken through this plugin">
          {changes.length ? (
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
              {changes.map(ch => (
                <Box component="li" key={ch.cluster.key} sx={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 1.5 }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {ch.time ? `${formatDuration(now.getTime() - new Date(ch.time).getTime())} ago` : '—'}
                  </Typography>
                  <Box sx={{ minWidth: 0 }}>
                    <Link to={clusterPath(ch.cluster)}>{ch.cluster.name}</Link>
                    <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {ch.text}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>
          ) : (
            <EmptyChart text="No changes made through this plugin yet." />
          )}
        </ChartCard>
      </Box>
    </SectionBox>
  );
}
