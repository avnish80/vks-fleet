import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, FormControlLabel, Switch, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { compareVersions, packageDrift, PackageInstallInfo, PackageState, shortPackage } from '../packages';
import { clusterDeepLink } from '../routes';
import { usePluginConfig } from '../settings/store';
import { FleetCluster } from '../types';
import { useFleet } from '../useFleet';
import { usePackages } from '../usePackages';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile, useTone } from './charts';

const STATE: Record<PackageState, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  ok: { text: 'Reconciled', status: 'success' },
  failed: { text: 'Failed', status: 'error' },
  reconciling: { text: 'Reconciling', status: '' },
  paused: { text: 'Paused', status: 'warning' },
  unknown: { text: 'Unknown', status: '' },
};

export function PackageStateLabel({ state }: { state: PackageState }) {
  return <StatusLabel status={STATE[state].status}>{STATE[state].text}</StatusLabel>;
}

export function pkgiPath(contextName: string, p: PackageInstallInfo): string {
  return `/c/${encodeURIComponent(contextName)}/customresources/packageinstalls.packaging.carvel.dev/${encodeURIComponent(
    p.namespace
  )}/${encodeURIComponent(p.name)}`;
}

type Row = PackageInstallInfo & { cluster: FleetCluster; contextName: string };

export function PackagesPage() {
  const config = usePluginConfig();
  const { results } = useFleet(config.supervisors, config.refreshSeconds);
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; contextName: string } => !!t.contextName);
  const packages = usePackages(targets);
  const tone = useTone();
  const [onlyDiff, setOnlyDiff] = React.useState(true);

  if (results === null) return <Loader title="Loading clusters" />;

  const byKey = new Map(clusters.map(c => [c.key, c]));
  const all = packages ? Array.from(packages.values()) : [];
  const rows: Row[] = all.flatMap(cp =>
    cp.items.map(p => ({ ...p, cluster: byKey.get(cp.clusterKey)!, contextName: cp.contextName }))
  );
  const failing = rows.filter(r => r.state === 'failed');
  const updates = rows.filter(r => r.update);
  const drift = packageDrift(all);
  const drifting = drift.filter(d => d.distinct > 1);
  const columns = all.map(cp => byKey.get(cp.clusterKey)).filter((c): c is FleetCluster => !!c);
  const notSignedIn = clusters.filter(c => !targets.some(t => t.key === c.key));
  const unreadable = all.filter(cp => cp.error);

  return (
    <>
      <ChartStyles />
      <SectionBox title="Packages">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Carvel packages installed in each signed-in cluster (the CNI, CSI, sign-in and any standard packages you added),
          whether they reconciled, newer versions in the cluster's repositories, and where versions differ across the fleet.
        </Typography>
        {packages === null && targets.length > 0 ? (
          <Loader title="Reading packages" />
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 2 }}>
            <KpiTile label="Installed" value={rows.length} sub={`across ${columns.length} cluster${columns.length === 1 ? '' : 's'}`} tone="primary" />
            <KpiTile label="Failing" value={failing.length} sub={failing.length ? 'need attention' : 'all reconciled'} tone={failing.length ? 'error' : 'success'} />
            <KpiTile label="Updates" value={updates.length} sub="newer versions available" tone="info" />
            <KpiTile label="Drifting" value={drifting.length} sub="packages at different versions" tone={drifting.length ? 'warning' : 'success'} />
          </Box>
        )}
        {notSignedIn.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            Not signed in, so not included: {notSignedIn.map(c => c.name).join(', ')}.
          </Typography>
        )}
        {unreadable.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Couldn't read packages in: {unreadable.map(cp => `${byKey.get(cp.clusterKey)?.name} (${cp.error})`).join('; ')}.
          </Typography>
        )}
      </SectionBox>

      {failing.length > 0 && (
        <SectionBox title="Failing packages">
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (r: Row) => <Link to={clusterDeepLink(r.cluster, { hash: 'packages' })}>{r.cluster.name}</Link> },
              { label: 'Package', getter: (r: Row) => <Link to={pkgiPath(r.contextName, r)}>{shortPackage(r.refName)}</Link> },
              { label: 'Version', getter: (r: Row) => r.version ?? '—' },
              { label: 'Error', getter: (r: Row) => r.message ?? '—' },
            ]}
            data={failing}
          />
        </SectionBox>
      )}

      {columns.length > 0 && (
        <SectionBox title="Versions across the fleet">
          <FormControlLabel
            control={<Switch checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />}
            label="Only packages whose versions differ"
          />
          <Box sx={{ overflowX: 'auto', mt: 1 }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <Box component="th" sx={{ textAlign: 'left', p: 1, position: 'sticky', left: 0, bgcolor: 'background.paper' }}>
                    Package
                  </Box>
                  {columns.map(c => (
                    <Box component="th" key={c.key} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>
                      <Link to={clusterDeepLink(c, { hash: 'packages' })}>{c.name}</Link>
                    </Box>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(onlyDiff ? drifting : drift).map(d => (
                  <Box component="tr" key={d.refName} sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
                    <Box component="td" sx={{ p: 1, fontWeight: 600, position: 'sticky', left: 0, bgcolor: 'background.paper', whiteSpace: 'nowrap' }}>
                      {shortPackage(d.refName)}
                    </Box>
                    {columns.map(c => {
                      const v = d.versions.get(c.key);
                      const newest = v && compareVersions(v, d.newest) === 0;
                      return (
                        <Box component="td" key={c.key} sx={{ p: 1, whiteSpace: 'nowrap' }}>
                          {v ? (
                            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: tone(newest ? 'success' : 'warning') }} />
                              {v}
                            </Box>
                          ) : (
                            <Typography variant="body2" color="text.secondary" component="span">
                              {d.versions.has(c.key) ? 'installing' : 'not installed'}
                            </Typography>
                          )}
                        </Box>
                      );
                    })}
                  </Box>
                ))}
              </tbody>
            </Box>
          </Box>
          {onlyDiff && drifting.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Every package is at the same version wherever it's installed.
            </Typography>
          )}
        </SectionBox>
      )}

      {updates.length > 0 && (
        <SectionBox title="Updates available">
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (r: Row) => r.cluster.name },
              { label: 'Package', getter: (r: Row) => <Link to={pkgiPath(r.contextName, r)}>{shortPackage(r.refName)}</Link> },
              { label: 'Installed', getter: (r: Row) => r.version ?? '—' },
              { label: 'Newest available', getter: (r: Row) => r.update },
            ]}
            data={updates}
          />
        </SectionBox>
      )}
    </>
  );
}
