import { SectionBox, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Typography } from '@mui/material';
import React, { ReactNode } from 'react';
import { Link, useHistory } from 'react-router-dom';
import { namespacePath } from '../inventoryIssues';
import { shortener, shortNode } from '../names';
import { DriftRow, shortPackage } from '../packages';
import { clusterDeepLink, clusterPath, machinePath, PACKAGES_PATH } from '../routes';
import { versionSpread } from '../summary';
import { fleetTimeline } from '../timeline';
import { BackupStatus, FleetCluster, Issue, SubnetInfo } from '../types';
import { BarList, ChartCard, ChartStyles, Tone } from './charts';
import { ActivityHeatmap } from './Timeline';

export interface ScoreRow {
  cluster: FleetCluster;
  /** Best-practice checks score. */
  score?: number;
  /** Baseline compliance, with the cluster's profile. */
  baseline?: number;
  backup?: BackupStatus;
  issues: Issue[];
}

type Cell = { text: string; tone: 'success' | 'warning' | 'error' | ''; title?: string; link?: string };

const pctTone = (p?: number): Cell['tone'] => (p === undefined ? '' : p >= 90 ? 'success' : p >= 70 ? 'warning' : 'error');

function cells(r: ScoreRow, now: number): Record<string, Cell> {
  const c = r.cluster;
  const certDays = c.certificatesExpiry ? Math.floor((new Date(c.certificatesExpiry).getTime() - now) / 86400e3) : undefined;
  const t = r.backup?.lastSuccess?.completed;
  const hours = t ? Math.round((now - new Date(t).getTime()) / 3600e3) : undefined;
  const ready = c.machines.filter(m => m.ready && !m.deletingSince).length;
  const crit = r.issues.filter(i => i.severity === 'critical').length;
  const warn = r.issues.filter(i => i.severity === 'warning').length;
  return {
    health: { text: c.health, tone: c.health === 'healthy' ? 'success' : c.health === 'degraded' || c.health === 'provisioning' ? 'warning' : c.health === 'unknown' ? '' : 'error' },
    score: { text: r.score === undefined ? '—' : String(r.score), tone: pctTone(r.score) },
    baseline: { text: r.baseline === undefined ? '—' : `${r.baseline}%`, tone: pctTone(r.baseline), link: '/vks-fleet/baseline' },
    backup: !r.backup
      ? { text: '—', tone: '', title: 'Sign in to the cluster to read Velero' }
      : r.backup.missing
      ? { text: 'no Velero', tone: 'warning' }
      : hours === undefined
      ? { text: 'never', tone: 'error' }
      : { text: `${hours}h ago`, tone: hours > 26 ? 'error' : hours > 12 ? 'warning' : 'success' },
    certs: { text: certDays === undefined ? '—' : `${certDays}d`, tone: certDays === undefined ? '' : certDays < 30 ? 'error' : certDays < 60 ? 'warning' : 'success', title: 'Days left on control-plane certificates' },
    version: {
      text: `${(c.kubernetesVersion ?? '?').replace(/\+.*/, '')}${c.minorsBehind ? ` (${c.minorsBehind} behind)` : ''}`,
      tone: c.minorsBehind ? (c.minorsBehind > 1 ? 'error' : 'warning') : 'success',
      title: c.kubernetesVersion,
    },
    nodes: { text: `${ready}/${c.machines.length}`, tone: ready < c.machines.length ? 'warning' : 'success' },
    issues: { text: crit ? `${crit} critical${warn ? `, ${warn} warn` : ''}` : warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'none', tone: crit ? 'error' : warn ? 'warning' : 'success' },
  };
}

const COLUMNS: Array<{ key: string; label: string }> = [
  { key: 'health', label: 'Health' },
  { key: 'issues', label: 'Issues' },
  { key: 'score', label: 'Score' },
  { key: 'baseline', label: 'Baseline' },
  { key: 'backup', label: 'Backup' },
  { key: 'certs', label: 'Certificates' },
  { key: 'version', label: 'Version' },
  { key: 'nodes', label: 'Nodes' },
];

/** One row per cluster, worst first: everything that used to be six separate cards. */
export function ClusterScorecard({ rows, orgs }: { rows: ScoreRow[]; orgs: boolean }) {
  const [all, setAll] = React.useState(false);
  const now = Date.now();
  const short = shortener(rows.map(r => r.cluster.name));
  const worst = (r: ScoreRow) => {
    const h = { healthy: 0, provisioning: 1, deleting: 1, unknown: 1, degraded: 2 } as Record<string, number>;
    return (h[r.cluster.health] ?? 3) * 1000 + r.issues.filter(i => i.severity === 'critical').length * 100 + r.issues.filter(i => i.severity === 'warning').length * 10 + (100 - (r.score ?? 100)) / 10;
  };
  const sorted = [...rows].sort((a, b) => worst(b) - worst(a) || a.cluster.name.localeCompare(b.cluster.name));
  const shown = all ? sorted : sorted.slice(0, 10);
  const hasBaseline = rows.some(r => r.baseline !== undefined);
  const cols = COLUMNS.filter(c => c.key !== 'baseline' || hasBaseline);
  return (
    <Box>
      <Box sx={{ overflowX: 'auto' }}>
        <Box component="table" sx={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 4px', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <Box component="th" sx={{ textAlign: 'left', px: 1, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 0.5, color: 'text.secondary' }}>
                Cluster
              </Box>
              {orgs && (
                <Box component="th" sx={{ textAlign: 'left', px: 1, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 0.5, color: 'text.secondary' }}>
                  Org
                </Box>
              )}
              {cols.map(c => (
                <Box component="th" key={c.key} sx={{ textAlign: 'left', px: 1, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: 0.5, color: 'text.secondary', whiteSpace: 'nowrap' }}>
                  {c.label}
                </Box>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map(r => {
              const cs = cells(r, now);
              return (
                <Box component="tr" key={r.cluster.key} sx={{ '& > td': { bgcolor: 'action.hover', py: 0.75, px: 1 }, '& > td:first-of-type': { borderRadius: '8px 0 0 8px' }, '& > td:last-of-type': { borderRadius: '0 8px 8px 0' } }}>
                  <td>
                    <Link to={clusterPath(r.cluster)} title={r.cluster.name} style={{ fontWeight: 700 }}>
                      {short(r.cluster.name)}
                    </Link>
                  </td>
                  {orgs && <td>{r.cluster.tenantName}</td>}
                  {cols.map(c => (
                    <td key={c.key} title={cs[c.key].title}>
                      <StatusLabel status={cs[c.key].tone}>{cs[c.key].text}</StatusLabel>
                    </td>
                  ))}
                </Box>
              );
            })}
          </tbody>
        </Box>
      </Box>
      {sorted.length > 10 && (
        <Button size="small" onClick={() => setAll(!all)} sx={{ mt: 0.5 }}>
          {all ? 'Show the 10 that need most attention' : `Show all ${sorted.length}`}
        </Button>
      )}
    </Box>
  );
}

/** The fleet page below the hero: the scorecard, a line of facts, cards only where there's something to show, and activity. */
export function FleetDetails({
  rows,
  busiest,
  subnets,
  packageDrift,
  supervisors,
  onSupervisor,
}: {
  rows: ScoreRow[];
  busiest?: Array<{ cluster: FleetCluster; node: string; cpuPct: number; memPct: number }>;
  subnets?: SubnetInfo[];
  packageDrift?: DriftRow[];
  supervisors?: Array<{ id: string; name: string; clusters: FleetCluster[] }>;
  onSupervisor?: (id: string) => void;
}) {
  const history = useHistory();
  const clusters = rows.map(r => r.cluster);
  const short = shortener(clusters.map(c => c.name));
  const versions = versionSpread(clusters);
  const orgs = new Set(clusters.map(c => c.tenantId)).size;
  const now = new Date();
  const facts: string[] = [];
  if (packageDrift && !packageDrift.length) facts.push('packages at the same version everywhere');
  const cards: ReactNode[] = [];
  if (versions.length > 1) {
    cards.push(
      <ChartCard key="versions" title="Kubernetes versions" caption="Clusters per version">
        <BarList rows={versions.map(v => ({ key: v.version, label: v.version, parts: [{ label: 'Clusters', value: v.count, tone: 'primary' as Tone }], valueText: String(v.count) }))} />
      </ChartCard>
    );
  }
  if (busiest?.length) {
    cards.push(
      <ChartCard key="busiest" title="Busiest nodes" caption="Higher of CPU and memory against allocatable. Click to open.">
        <BarList
          max={100}
          rows={busiest.slice(0, 6).map(b => {
            const pct = Math.max(b.cpuPct, b.memPct);
            const m = b.cluster.machines.find(x => x.nodeName === b.node || x.name === b.node);
            return {
              key: `${b.cluster.key}/${b.node}`,
              label: (
                <span title={b.node}>
                  <b>{short(b.cluster.name)}</b> {shortNode(b.cluster.name, b.node)}
                </span>
              ),
              parts: [{ label: pct === b.memPct ? 'Memory' : 'CPU', value: Math.min(pct, 100), tone: (pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'success') as Tone }],
              valueText: `${pct}% ${pct === b.memPct ? 'mem' : 'CPU'}`,
              onClick: () => history.push(m ? machinePath(b.cluster, m.name) : clusterDeepLink(b.cluster, { hash: 'utilisation' })),
            };
          })}
        />
      </ChartCard>
    );
  }
  const fullSubnets = (subnets ?? []).filter(s => s.used / s.capacity >= 0.05 || (subnets ?? []).length <= 6);
  if (fullSubnets.length) {
    cards.push(
      <ChartCard key="subnets" title="Subnet usage" caption="Addresses in use, fullest first. Click to open the namespace's network.">
        <BarList
          max={100}
          rows={[...fullSubnets]
            .sort((a, b) => b.used / b.capacity - a.used / a.capacity)
            .slice(0, 6)
            .map(s => {
              const pct = Math.round((s.used / s.capacity) * 100);
              return {
                key: `${s.namespace}/${s.kind}/${s.name}`,
                label: (
                  <span title={`${s.namespace}: ${s.name} (${s.cidrs.join(', ')})`}>
                    <b>{s.name}</b>{' '}
                    <Box component="span" sx={{ color: 'text.secondary' }}>
                      {s.namespace}
                    </Box>
                  </span>
                ),
                parts: [{ label: 'Used', value: pct, tone: (pct >= 95 ? 'error' : pct >= 85 ? 'warning' : 'success') as Tone }],
                valueText: `${pct}%`,
                onClick: () => history.push(namespacePath(s.supervisorId, s.namespace, 'network')),
              };
            })}
        />
      </ChartCard>
    );
  }
  if (packageDrift?.length) {
    cards.push(
      <ChartCard key="drift" title="Packages at different versions" caption="Across the clusters that have them. Click to open Packages.">
        <BarList
          rows={packageDrift.slice(0, 6).map(d => ({
            key: d.refName,
            label: <Link to={PACKAGES_PATH}>{shortPackage(d.refName)}</Link>,
            parts: [{ label: 'Versions', value: d.distinct, tone: 'warning' as Tone }],
            valueText: `${d.distinct} versions`,
            onClick: () => history.push(PACKAGES_PATH),
          }))}
        />
      </ChartCard>
    );
  }
  if (supervisors && supervisors.length > 1) {
    cards.push(
      <ChartCard key="sv" title="Clusters by Supervisor" caption={onSupervisor ? 'Click to show only its clusters' : undefined}>
        <BarList rows={supervisors.map(s => ({ key: s.id, label: s.name, parts: [{ label: 'Clusters', value: s.clusters.length, tone: 'primary' as Tone }], valueText: String(s.clusters.length), onClick: onSupervisor ? () => onSupervisor(s.id) : undefined }))} />
      </ChartCard>
    );
  }
  return (
    <>
      <ChartStyles />
      <Box id="scorecard" sx={{ scrollMarginTop: 72 }} />
      <SectionBox title="Clusters at a glance">
        <ClusterScorecard rows={rows} orgs={orgs > 1} />
        {facts.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {facts.join(' · ')}.
          </Typography>
        )}
      </SectionBox>
      {cards.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 2, px: 2, mb: 2 }}>
          {cards}
        </Box>
      )}
      <Box sx={{ px: 2, mb: 2 }}>
        <ChartCard title="Activity in the last 7 days" caption="Nodes added and deleted, condition and spec changes, and actions taken through this plugin. Click a day for what happened." minHeight={100}>
          <ActivityHeatmap lanes={fleetTimeline(clusters, now)} clusters={clusters} now={now} />
        </ChartCard>
      </Box>
    </>
  );
}
