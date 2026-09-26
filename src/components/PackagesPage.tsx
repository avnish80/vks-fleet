import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, FormControlLabel, MenuItem, Switch, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { ActionPlan } from '../actions';
import { headlampWriter } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { packageKickPlan, packagePausePlan, packageVersionPlan } from '../guestActions';
import {
  CatalogItem,
  ClusterPackages,
  compareVersions,
  packageDrift,
  PackageInstallInfo,
  PackageState,
  RepositoryInfo,
  shortPackage,
} from '../packages';
import { clusterDeepLink } from '../routes';
import { FleetCluster } from '../types';
import { usePackages } from '../usePackages';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog } from './ActionDialog';
import { BatchActionDialog, BatchItem } from './BatchActionDialog';
import { ChartStyles, KpiTile, useTone } from './charts';
import { SignInHelper } from './SignInHelper';

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

function UpdateCell({ row, onPlan }: { row: Row; onPlan: (p: ActionPlan) => void }) {
  const newer = (row.versions ?? []).filter(v => !row.version || compareVersions(v, row.version) > 0);
  const [v, setV] = React.useState(newer[0] ?? '');
  if (row.managedByVks) return <Typography variant="body2" color="text.secondary">With the cluster upgrade</Typography>;
  if (!newer.length) return <Typography variant="body2" color="text.secondary">Up to date</Typography>;
  return (
    <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
      <TextField select size="small" value={v} onChange={e => setV(e.target.value)} sx={{ minWidth: 170 }}>
        {newer.map(x => (
          <MenuItem key={x} value={x}>
            {x}
          </MenuItem>
        ))}
      </TextField>
      <Button size="small" onClick={() => onPlan(packageVersionPlan(row.cluster.name, row, v))}>
        Update
      </Button>
    </Box>
  );
}

export function PackagesPage() {
  const { config, results, canWrite, refresh } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; contextName: string } => !!t.contextName);
  const packages = usePackages(targets, 120);
  const tone = useTone();
  const [onlyDiff, setOnlyDiff] = React.useState(true);
  const [plan, setPlan] = React.useState<{ plan: ActionPlan; contextName: string } | null>(null);
  const [batch, setBatch] = React.useState<{ title: string; items: BatchItem[] } | null>(null);
  const [fleetVersion, setFleetVersion] = React.useState<Record<string, string>>({});

  if (results === null) return <Loader title="Loading clusters" />;

  const byKey = new Map(clusters.map(c => [c.key, c]));
  const all: ClusterPackages[] = packages ? Array.from(packages.values()) : [];
  const rows: Row[] = all.flatMap(cp => cp.items.map(p => ({ ...p, cluster: byKey.get(cp.clusterKey)!, contextName: cp.contextName })));
  const failing = rows.filter(r => r.state === 'failed');
  const updates = rows.filter(r => r.update && !r.managedByVks);
  const drift = packageDrift(all);
  const drifting = drift.filter(d => d.distinct > 1);
  const columns = all.map(cp => byKey.get(cp.clusterKey)).filter((c): c is FleetCluster => !!c);
  const repos: Array<RepositoryInfo & { cluster: string }> = all.flatMap(cp =>
    (cp.repositories ?? []).map(r => ({ ...r, cluster: byKey.get(cp.clusterKey)?.name ?? '' }))
  );
  const catalogByRef = new Map<string, CatalogItem & { installedIn: string[]; availableIn: string[] }>();
  for (const cp of all) {
    const name = byKey.get(cp.clusterKey)?.name ?? '';
    for (const c of cp.catalog ?? []) {
      const cur = catalogByRef.get(c.refName) ?? { ...c, installedIn: [], availableIn: [] };
      cur.availableIn.push(name);
      if (c.installed) cur.installedIn.push(name);
      if (c.versions.length > cur.versions.length) cur.versions = c.versions;
      catalogByRef.set(c.refName, cur);
    }
  }
  const catalogRows = Array.from(catalogByRef.values()).sort(
    (a, b) => Number(b.installedIn.length > 0) - Number(a.installedIn.length > 0) || a.displayName.localeCompare(b.displayName)
  );
  const writable = (r: Row) => canWrite(r.cluster.supervisorId) && !r.managedByVks;

  const fleetUpdate = (refName: string, version: string) => {
    const items: BatchItem[] = rows
      .filter(r => r.refName === refName)
      .map(r => ({ label: r.cluster.name, plan: packageVersionPlan(r.cluster.name, r, version), writer: headlampWriter(r.contextName) }));
    setBatch({ title: `Update ${shortPackage(refName)} to ${version} across the fleet`, items });
  };

  return (
    <>
      <ChartStyles />
      <SectionBox title="Packages">
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Carvel packages in each signed-in cluster. Packages VKS installs itself (CNI, CSI, sign-in…) are marked and change
          with the cluster's Kubernetes release; the rest can be updated, paused or reconciled here, per cluster or across the
          fleet.
        </Typography>
        {packages === null && targets.length > 0 ? (
          <Loader title="Reading packages" />
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2 }}>
            <KpiTile label="Installed" value={rows.length} sub={`${rows.filter(r => r.managedByVks).length} managed by VKS`} tone="primary" />
            <KpiTile label="Failing" value={failing.length} tone={failing.length ? 'error' : 'success'} />
            <KpiTile label="Updates" value={updates.length} sub="for packages you manage" tone="info" />
            <KpiTile label="Drifting" value={drifting.length} tone={drifting.length ? 'warning' : 'success'} />
            <KpiTile
              label="Repositories"
              value={repos.length}
              sub={repos.some(r => r.state === 'failed') ? `${repos.filter(r => r.state === 'failed').length} failing` : 'all synced'}
              tone={repos.some(r => r.state === 'failed') ? 'error' : 'success'}
            />
          </Box>
        )}
      </SectionBox>

      {columns.map(c => {
        const cp = all.find(x => x.clusterKey === c.key)!;
        const list = rows.filter(r => r.cluster.key === c.key);
        return (
          <SectionBox key={c.key} title={`${c.name}: installed`}>
            {cp.error ? (
              <Typography color="text.secondary">Couldn't read packages: {cp.error}</Typography>
            ) : (
              <SimpleTable
                columns={[
                  { label: 'Package', getter: (r: Row) => <Link to={pkgiPath(r.contextName, r)}>{shortPackage(r.refName)}</Link> },
                  { label: 'Version', getter: (r: Row) => r.version ?? '—' },
                  {
                    label: 'Status',
                    getter: (r: Row) => (r.paused ? <StatusLabel status="warning">Paused</StatusLabel> : <PackageStateLabel state={r.state} />),
                  },
                  { label: 'Managed by', getter: (r: Row) => (r.managedByVks ? 'VKS' : 'You') },
                  {
                    label: 'Update',
                    getter: (r: Row) =>
                      writable(r) ? <UpdateCell row={r} onPlan={p => setPlan({ plan: p, contextName: r.contextName })} /> : r.update ?? '—',
                  },
                  {
                    label: 'Actions',
                    getter: (r: Row) =>
                      writable(r) ? (
                        <Box sx={{ display: 'flex', gap: 0.5 }}>
                          <Button size="small" onClick={() => setPlan({ plan: packagePausePlan(c.name, r, !r.paused), contextName: r.contextName })}>
                            {r.paused ? 'Resume' : 'Pause'}
                          </Button>
                          {!r.paused && (
                            <Button size="small" onClick={() => setPlan({ plan: packageKickPlan(c.name, r), contextName: r.contextName })}>
                              Reconcile now
                            </Button>
                          )}
                        </Box>
                      ) : (
                        '—'
                      ),
                  },
                  { label: 'Message', getter: (r: Row) => (r.state === 'failed' ? r.message ?? '—' : r.syncPeriod ? `sync every ${r.syncPeriod}` : '—') },
                ]}
                data={list}
              />
            )}
          </SectionBox>
        );
      })}

      {columns.length > 0 && (
        <SectionBox title="Versions across the fleet">
          <FormControlLabel control={<Switch checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} />} label="Only packages whose versions differ" />
          <Box sx={{ overflowX: 'auto', mt: 1 }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', minWidth: '100%', fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <Box component="th" sx={{ textAlign: 'left', p: 1 }}>
                    Package
                  </Box>
                  {columns.map(c => (
                    <Box component="th" key={c.key} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>
                      <Link to={clusterDeepLink(c, { hash: 'packages' })}>{c.name}</Link>
                    </Box>
                  ))}
                  <Box component="th" sx={{ textAlign: 'left', p: 1 }}>
                    Everywhere
                  </Box>
                </tr>
              </thead>
              <tbody>
                {(onlyDiff ? drifting : drift).map(d => {
                  const installs = rows.filter(r => r.refName === d.refName);
                  const managed = installs.some(r => r.managedByVks);
                  const choices = Array.from(new Set(installs.flatMap(r => r.versions ?? []))).sort((a, b) => compareVersions(b, a));
                  const chosen = fleetVersion[d.refName] ?? choices[0] ?? '';
                  return (
                    <Box component="tr" key={d.refName} sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
                      <Box component="td" sx={{ p: 1, fontWeight: 600, whiteSpace: 'nowrap' }}>
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
                      <Box component="td" sx={{ p: 1 }}>
                        {managed ? (
                          <Typography variant="body2" color="text.secondary">
                            Managed by VKS
                          </Typography>
                        ) : choices.length && installs.some(r => canWrite(r.cluster.supervisorId)) ? (
                          <Box sx={{ display: 'flex', gap: 0.5 }}>
                            <TextField
                              select
                              size="small"
                              value={chosen}
                              onChange={e => setFleetVersion({ ...fleetVersion, [d.refName]: e.target.value })}
                              sx={{ minWidth: 150 }}
                            >
                              {choices.map(x => (
                                <MenuItem key={x} value={x}>
                                  {x}
                                </MenuItem>
                              ))}
                            </TextField>
                            <Button size="small" onClick={() => fleetUpdate(d.refName, chosen)}>
                              Update all
                            </Button>
                          </Box>
                        ) : (
                          '—'
                        )}
                      </Box>
                    </Box>
                  );
                })}
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

      {repos.length > 0 && (
        <SectionBox title="Package repositories">
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (r: (typeof repos)[number]) => r.cluster },
              { label: 'Repository', getter: (r: (typeof repos)[number]) => `${r.namespace}/${r.name}` },
              {
                label: 'Source',
                getter: (r: (typeof repos)[number]) => (
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                    {r.url ?? '—'}
                  </Typography>
                ),
              },
              { label: 'State', getter: (r: (typeof repos)[number]) => <PackageStateLabel state={r.state} /> },
              { label: 'Message', getter: (r: (typeof repos)[number]) => (r.state === 'ok' ? '—' : r.message ?? '—') },
            ]}
            data={repos}
          />
        </SectionBox>
      )}

      {catalogRows.length > 0 && (
        <SectionBox title="Catalog">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            What the clusters' repositories offer. Installing from here is on the roadmap; for now use kctrl or a PackageInstall.
          </Typography>
          <SimpleTable
            columns={[
              { label: 'Package', getter: (c: (typeof catalogRows)[number]) => <b>{c.displayName}</b> },
              { label: 'Description', getter: (c: (typeof catalogRows)[number]) => c.description ?? '—' },
              { label: 'Newest', getter: (c: (typeof catalogRows)[number]) => c.versions[0] ?? '—' },
              { label: 'Installed in', getter: (c: (typeof catalogRows)[number]) => c.installedIn.join(', ') || '—' },
              { label: 'Available in', getter: (c: (typeof catalogRows)[number]) => c.availableIn.join(', ') },
            ]}
            data={catalogRows}
          />
        </SectionBox>
      )}

      {plan && <ActionDialog plan={plan.plan} writer={headlampWriter(plan.contextName)} onClose={() => setPlan(null)} onApplied={() => refresh()} />}
      {batch && <BatchActionDialog title={batch.title} items={batch.items} onClose={() => setBatch(null)} onDone={() => refresh()} />}
    </>
  );
}
