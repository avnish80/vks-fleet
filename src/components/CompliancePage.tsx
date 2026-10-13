import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { ClusterScan } from '../clusterScan';
import { ControlResult, ControlStatus, complianceIssueId, GENERIC_CIS_NOTICE, scoreResults } from '../compliance';
import { useScannerReports } from '../useScannerReports';
import { PolicyResult, TrivyCompliance } from '../scanners';
import { complianceCsv, complianceDrift, complianceMarkdown, complianceOscal, isWaived, snapshot } from '../complianceReport';
import { useFleetData } from '../fleetContext';
import { download } from '../report';
import { activeSilences } from '../silences';
import { useClusterScans } from '../useClusterScans';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';
import { complianceStore, useComplianceStore } from './complianceStore';
import { NoClusters } from './EmptyState';
import { SignInHelper } from './SignInHelper';
import { IsolationSection } from './IsolationSection';
import { ClusterSections, PagedTable } from './scale';
import { removeSilence, SilenceDialog } from './SilenceDialog';

const STATUS: Record<ControlStatus, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  pass: { text: 'Pass', status: 'success' },
  fail: { text: 'Fail', status: 'error' },
  review: { text: 'Review', status: 'warning' },
  unknown: { text: 'Not readable', status: '' },
};
const OWNER: Record<ControlResult['owner'], string> = { vks: 'VKS', you: 'Cluster owner', shared: 'Shared' };

interface FleetFailing {
  id: string;
  title: string;
  owner: ControlResult['owner'];
  remediation: string;
  clusters: string[];
}
const ORDER: Record<ControlStatus, number> = { fail: 0, review: 1, unknown: 2, pass: 3 };

export function CompliancePage() {
  const { config, results } = useFleetData();
  /** The generic CIS benchmark checks: off unless switched on in the settings. */
  const cis = config.cisBenchmark === true;
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const scans = useClusterScans(targets, config.baseline?.allowedRegistries ?? []);
  const scanner = useScannerReports(targets);
  const store = useComplianceStore() ?? {};
  const [owner, setOwner] = React.useState<'all' | 'you' | 'vks'>('all');
  const [level, setLevel] = React.useState<1 | 2>(2);
  const [onlyFailing, setOnlyFailing] = React.useState(false);
  const [waiving, setWaiving] = React.useState<{ issueId: string; label: string } | null>(null);

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Compliance" what="compliance information" />;
  if (cis && targets.length > 0 && scans === null) return <Loader title="Running the checks" />;
  const list: ClusterScan[] = cis ? scans ?? [] : [];
  const sectionOf = (r: ControlResult) => r.section;
  const silences = activeSilences(config.silences);
  const baselines = store.baselines ?? {};
  const keep = (r: ControlResult) =>
    (owner === 'all' || (owner === 'you' ? r.owner !== 'vks' : r.owner !== 'you')) && r.level <= level && (!onlyFailing || r.status === 'fail');
  const fleetFailing: FleetFailing[] = (() => {
    const m = new Map<string, FleetFailing>();
    for (const s of list)
      for (const r of s.compliance)
        if (r.status === 'fail' && !isWaived(silences, s.clusterKey, r.id)) {
          const cur = m.get(r.id) ?? { id: r.id, title: r.title, owner: r.owner, remediation: r.remediation, clusters: [] };
          cur.clusters.push(s.clusterName);
          m.set(r.id, cur);
        }
    return Array.from(m.values()).sort((a, b) => b.clusters.length - a.clusters.length || a.id.localeCompare(b.id));
  })();
  const effective = (s: ClusterScan) => s.compliance.map(r => (r.status === 'fail' && isWaived(silences, s.clusterKey, r.id) ? { ...r, status: 'pass' as ControlStatus } : r));
  const fleet = scoreResults(list.flatMap(s => effective(s).filter(r => r.level <= level)));
  const failing = list.reduce((n, s) => n + s.compliance.filter(r => r.status === 'fail' && !isWaived(silences, s.clusterKey, r.id)).length, 0);
  const waived = list.reduce((n, s) => n + s.compliance.filter(r => r.status === 'fail' && isWaived(silences, s.clusterKey, r.id)).length, 0);
  const regressions = list.reduce((n, s) => n + complianceDrift(baselines[s.clusterKey], s.compliance).filter(d => d.worse).length, 0);
  const present = new Set(list.flatMap(s => s.compliance.map(sectionOf)));
  const sections = Array.from(present);
  const totalControls = list[0]?.compliance.length ?? 0;
  const benchmarksUsed = Array.from(new Set(list.map(s => s.benchmark).filter(Boolean))).sort().map(v => `v${v}`).join(', ') || 'v2.0';
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Compliance"
        headerProps={{
          actions: cis
            ? [
                <Button key="md" size="small" variant="outlined" disabled={!list.length} onClick={() => download(`vks-generic-cis-${stamp}.md`, complianceMarkdown(list, silences), 'text/markdown')}>
                  Evidence (Markdown)
                </Button>,
                <Button key="csv" size="small" variant="outlined" disabled={!list.length} onClick={() => download(`vks-generic-cis-${stamp}.csv`, complianceCsv(list, silences), 'text/csv')}>
                  CSV
                </Button>,
                <Button key="oscal" size="small" variant="outlined" disabled={!list.length} onClick={() => download(`vks-generic-cis-${stamp}.oscal.json`, complianceOscal(list, silences), 'application/json')}>
                  OSCAL
                </Button>,
              ]
            : [],
        }}
      >
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        {!cis ? (
          <>
            <Typography variant="body2" sx={{ mb: 1 }}>
              Tenant isolation and the results of your own policies, below. No benchmark is scored here: <b>VMware does not publish or support a CIS benchmark for VKS</b>, and a generic one flags
              settings that VKS manages, so it would give the wrong impression of a cluster.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Generic CIS Kubernetes Benchmark checks are available as a reference: switch them on in Settings → Plugins → vks-fleet.
            </Typography>
          </>
        ) : (
          <>
            <Alert severity="warning" sx={{ mb: 2 }}>
              {GENERIC_CIS_NOTICE} Switched on in the plugin settings.
            </Alert>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {totalControls} checks aligned with the CIS Kubernetes Benchmark ({benchmarksUsed}: each cluster against the version written for its Kubernetes), evaluated through the Kubernetes API:
              control-plane flags (from the static pods), each kubelet's live configuration, RBAC, Pod Security, network policies, service accounts and workloads. Each control says who owns it:{' '}
              <b>VKS</b> (platform configuration, not yours to change) or <b>you</b> (how the cluster is used). File permissions on the nodes are not visible through the API and are listed for review,
              never counted as passed.
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2, mb: 2 }}>
              <KpiTile label="Generic CIS result" value={fleet.scored ? `${fleet.pct}%` : '—'} sub={`${fleet.scored} of ${fleet.total} checks scored`} tone={fleet.pct >= 90 ? 'success' : fleet.pct >= 70 ? 'warning' : 'error'} meter={{ value: fleet.pct, max: 100 }} />
              <KpiTile label="Failing" value={failing} sub="not waived" tone={failing ? 'error' : 'success'} />
              <KpiTile label="Waived" value={waived} sub="accepted risks" tone="neutral" />
              <KpiTile label="Regressions" value={regressions} sub="since the baseline" tone={regressions ? 'warning' : 'success'} />
              <KpiTile label="To review" value={fleet.review} sub="need a person" tone="info" />
            </Box>
            <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <TextField select size="small" label="Owner" value={owner} onChange={e => setOwner(e.target.value as 'all' | 'you' | 'vks')} sx={{ minWidth: 200 }}>
                <MenuItem value="all">Everything</MenuItem>
                <MenuItem value="you">Yours (cluster owner, shared)</MenuItem>
                <MenuItem value="vks">VKS-managed (platform)</MenuItem>
              </TextField>
              <TextField select size="small" label="Level" value={level} onChange={e => setLevel(Number(e.target.value) as 1 | 2)} sx={{ minWidth: 140 }}>
                <MenuItem value={1}>Level 1</MenuItem>
                <MenuItem value={2}>Levels 1 and 2</MenuItem>
              </TextField>
              <TextField select size="small" label="Show" value={onlyFailing ? 'failing' : 'all'} onChange={e => setOnlyFailing(e.target.value === 'failing')} sx={{ minWidth: 160 }}>
                <MenuItem value="all">All controls</MenuItem>
                <MenuItem value="failing">Failing only</MenuItem>
              </TextField>
            </Box>
          </>
        )}
      </SectionBox>

      <IsolationSection />

      {list.length > 0 && (
        <SectionBox title="Generic CIS checks by section">
          <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: '4px', fontSize: '0.85rem', minWidth: '100%' }}>
              <thead>
                <tr>
                  <Box component="th" sx={{ textAlign: 'left', p: 1 }}>
                    Cluster
                  </Box>
                  {sections.map(sec => (
                    <Box component="th" key={sec} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>
                      {sec}
                    </Box>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map(s => (
                  <tr key={s.clusterKey}>
                    <Box component="td" sx={{ p: 1, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <a href={`#${encodeURIComponent(s.clusterKey)}`}>{s.clusterName}</a>
                    </Box>
                    {sections.map(sec => {
                      const sc = scoreResults(effective(s).filter(r => sectionOf(r) === sec && keep(r)));
                      const scored = sc.pass + sc.fail;
                      return (
                        <Box
                          component="td"
                          key={sec}
                          title={`${sc.pass} pass, ${sc.fail} fail, ${sc.review} review, ${sc.unknown} not readable`}
                          sx={{ p: 1, textAlign: 'center', borderRadius: 1, bgcolor: 'action.hover', borderBottom: '3px solid', borderBottomColor: scored === 0 ? 'divider' : sc.fail ? 'error.main' : 'success.main' }}
                        >
                          {scored ? `${sc.pct}%` : '—'}
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

      {list.length > 1 && fleetFailing.length > 0 && (
        <SectionBox title="Generic CIS checks failing across the fleet">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            A control that fails in most clusters is one problem to fix once (a template, a package default, a policy), not one per cluster.
          </Typography>
          <PagedTable
            pageSize={10}
            filterText={(r: FleetFailing) => `${r.id} ${r.title} ${r.owner}`}
            columns={[
              { label: 'Failing in', getter: (r: FleetFailing) => <StatusLabel status={r.clusters.length > list.length / 2 ? 'error' : 'warning'}>{`${r.clusters.length} of ${list.length}`}</StatusLabel> },
              { label: 'Control', getter: (r: FleetFailing) => <><b>{r.id}</b> {r.title}</> },
              { label: 'Owner', getter: (r: FleetFailing) => OWNER[r.owner] },
              { label: 'Clusters', getter: (r: FleetFailing) => <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{r.clusters.join(', ')}</Typography> },
              { label: 'Remediation', getter: (r: FleetFailing) => r.remediation },
            ]}
            data={fleetFailing}
          />
        </SectionBox>
      )}

      {cis && (
      <SectionBox title={`Generic CIS checks by cluster (${list.length})`}>
        <ClusterSections
          openFirst={list.length <= 3}
          sections={list.map(s => {
            const drift = complianceDrift(baselines[s.clusterKey], s.compliance);
            const rows = [...s.compliance.filter(keep)].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
            const sc = scoreResults(effective(s));
            const fails = s.compliance.filter(r => r.status === 'fail' && !isWaived(silences, s.clusterKey, r.id)).length;
            const review = s.compliance.filter(r => r.status === 'review').length;
            const table = (limit?: number) => (
              <SimpleTable
                columns={[
                  {
                    label: 'Result',
                    getter: (r: ControlResult) => {
                      const w = r.status === 'fail' ? isWaived(silences, s.clusterKey, r.id) : undefined;
                      return w ? <StatusLabel status="">{`Waived to ${w.until.slice(0, 10)}`}</StatusLabel> : <StatusLabel status={STATUS[r.status].status}>{STATUS[r.status].text}</StatusLabel>;
                    },
                  },
                  { label: 'Control', getter: (r: ControlResult) => <><b>{r.id}</b> {r.title}</> },
                  { label: 'Ref', getter: (r: ControlResult) => `${r.ref} · L${r.level}` },
                  { label: 'Owner', getter: (r: ControlResult) => OWNER[r.owner] },
                  { label: 'Evidence', getter: (r: ControlResult) => <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{r.evidence}</Typography> },
                  { label: 'Remediation', getter: (r: ControlResult) => (r.status === 'pass' ? '—' : r.remediation) },
                  {
                    label: '',
                    getter: (r: ControlResult) => {
                      if (r.status !== 'fail') return '';
                      const w = isWaived(silences, s.clusterKey, r.id);
                      return w ? (
                        <Button size="small" title={w.reason} onClick={() => removeSilence(w.id)}>
                          Un-waive
                        </Button>
                      ) : (
                        <Button size="small" onClick={() => setWaiving({ issueId: complianceIssueId(s.clusterKey, r.id), label: `${r.id} in ${s.clusterName}` })}>
                          Waive…
                        </Button>
                      );
                    },
                  },
                ]}
                data={limit ? rows.slice(0, limit) : rows}
              />
            );
            return {
              key: s.clusterKey,
              title: s.clusterName,
              subtitle: sc.scored ? `${sc.pct}% (${sc.scored} of ${sc.total} scored)` : 'not scored',
              weight: fails * 10 + review,
              count: rows.length,
              chips: (
                <>
                  <StatusLabel status={fails ? 'error' : 'success'}>{`${fails} failing`}</StatusLabel>
                  {review > 0 && <StatusLabel status="warning">{`${review} to review`}</StatusLabel>}
                  {drift.some(d => d.worse) && <StatusLabel status="warning">drift</StatusLabel>}
                </>
              ),
              renderPreview: (limit: number) => (
                <Box id={encodeURIComponent(s.clusterKey)} sx={{ scrollMarginTop: 72 }}>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                    <Button size="small" onClick={() => complianceStore.update({ baselines: { ...baselines, [s.clusterKey]: snapshot(s.compliance) } })}>
                      {baselines[s.clusterKey] ? 'Save as new baseline' : 'Save as baseline'}
                    </Button>
                  </Box>
                  {s.errors.length > 0 && (
                    <Alert severity="info" sx={{ mb: 1 }}>
                      Partly checked: {s.errors.slice(0, 3).join('; ')}
                    </Alert>
                  )}
                  {baselines[s.clusterKey] ? (
                    drift.length ? (
                      <Alert severity={drift.some(d => d.worse) ? 'warning' : 'success'} sx={{ mb: 1 }}>
                        Since the baseline of {new Date(baselines[s.clusterKey].at).toLocaleString()}:{' '}
                        {drift.map(d => `${d.id} ${d.from} → ${d.to}`).join('; ')}
                      </Alert>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        No change since the baseline of {new Date(baselines[s.clusterKey].at).toLocaleString()}.
                      </Typography>
                    )
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Save a baseline to be told when a control changes (drift).
                    </Typography>
                  )}
                  {table(limit)}
                </Box>
              ),
              renderAll: () => table(),
            };
          })}
        />
      </SectionBox>
      )}

      {cis && (scanner ?? []).some(r => r.compliance.length) && (
        <SectionBox title="Trivy Operator compliance reports (generic benchmarks)">
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (x: TrivyCompliance & { cluster: string }) => x.cluster },
              { label: 'Report', getter: (x: TrivyCompliance & { cluster: string }) => x.title || x.id },
              {
                label: 'Result',
                getter: (x: TrivyCompliance & { cluster: string }) => (
                  <StatusLabel status={x.fail ? 'error' : 'success'}>{`${x.pass} pass, ${x.fail} fail`}</StatusLabel>
                ),
              },
              {
                label: 'Failing controls',
                getter: (x: TrivyCompliance & { cluster: string }) =>
                  x.failing
                    .slice(0, 5)
                    .map(f => `${f.id} ${f.name} (${f.totalFail})`)
                    .join('; ') || '—',
              },
            ]}
            data={(scanner ?? []).flatMap(r => r.compliance.map(c => ({ ...c, cluster: r.clusterName })))}
          />
        </SectionBox>
      )}

      <Box id="policy" sx={{ scrollMarginTop: 72 }} />
      {(scanner ?? []).some(r => r.policyEngine) && (
        <SectionBox title="Policy results (Kyverno and other policy engines)">
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
            {(scanner ?? [])
              .filter(r => r.policyEngine)
              .map(r => (
                <StatusLabel key={r.clusterKey} status={r.policySummary.fail + r.policySummary.error ? 'error' : 'success'}>
                  {`${r.clusterName}: ${r.policySummary.pass} pass, ${r.policySummary.fail} fail, ${r.policySummary.warn} warn`}
                </StatusLabel>
              ))}
          </Box>
          {(scanner ?? []).flatMap(r => r.policy).length === 0 ? (
            <Typography color="text.secondary">No failing or warning policy results.</Typography>
          ) : (
            <SimpleTable
              columns={[
                { label: 'Cluster', getter: (x: PolicyResult & { cluster: string }) => x.cluster },
                {
                  label: 'Result',
                  getter: (x: PolicyResult & { cluster: string }) => <StatusLabel status={x.result === 'warn' ? 'warning' : 'error'}>{x.result}</StatusLabel>,
                },
                { label: 'Policy', getter: (x: PolicyResult & { cluster: string }) => `${x.policy}${x.rule ? ` / ${x.rule}` : ''}` },
                { label: 'Resource', getter: (x: PolicyResult & { cluster: string }) => x.resource ?? '—' },
                { label: 'Message', getter: (x: PolicyResult & { cluster: string }) => x.message ?? '—' },
              ]}
              data={(scanner ?? []).flatMap(r => r.policy.map(p => ({ ...p, cluster: r.clusterName }))).slice(0, 200)}
            />
          )}
        </SectionBox>
      )}

      {waiving && <SilenceDialog match={{ issueId: waiving.issueId }} label={waiving.label} onClose={() => setWaiving(null)} />}
    </>
  );
}
