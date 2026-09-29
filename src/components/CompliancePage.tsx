import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { ClusterScan } from '../clusterScan';
import { ControlResult, ControlStatus, complianceIssueId, Framework, NSA_ORDER, scoreResults } from '../compliance';
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
import { NodeScanDialog } from './NodeScanDialog';
import { ClusterSections, PagedTable } from './scale';
import { BenchTest, isForeignBenchmark, latest, mergeNodeScan, NodeScanRun } from '../nodeScan';
import { useNodeScans } from '../useNodeScans';
import { removeSilence, SilenceDialog } from './SilenceDialog';

const STATUS: Record<ControlStatus, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
  pass: { text: 'Pass', status: 'success' },
  fail: { text: 'Fail', status: 'error' },
  review: { text: 'Review', status: 'warning' },
  unknown: { text: 'Not readable', status: '' },
  'node-scan': { text: 'Needs node scan', status: '' },
};
const OWNER: Record<ControlResult['owner'], string> = { vks: 'VKS', you: 'Cluster owner', shared: 'Shared' };

interface FleetFailing {
  id: string;
  title: string;
  owner: ControlResult['owner'];
  remediation: string;
  clusters: string[];
}
const ORDER: Record<ControlStatus, number> = { fail: 0, review: 1, pass: 2, na: 3 } as any;

export function CompliancePage() {
  const { config, results, canWrite } = useFleetData();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const scans = useClusterScans(targets, config.baseline?.allowedRegistries ?? []);
  const [scanVersion, setScanVersion] = React.useState(0);
  const nodeScans = useNodeScans(targets, scanVersion);
  const [scanning, setScanning] = React.useState<{ cluster: string; contextName: string } | null>(null);
  const [showAllTests, setShowAllTests] = React.useState<Record<string, boolean>>({});
  const [framework, setFramework] = React.useState<Framework>('cis');
  const scanner = useScannerReports(targets);
  const store = useComplianceStore() ?? {};
  const [owner, setOwner] = React.useState<'all' | 'you' | 'vks'>('all');
  const [level, setLevel] = React.useState<1 | 2>(2);
  const [onlyFailing, setOnlyFailing] = React.useState(false);
  const [waiving, setWaiving] = React.useState<{ issueId: string; label: string } | null>(null);

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Compliance" what="compliance information" />;
  if (targets.length > 0 && scans === null) return <Loader title="Running the checks" />;
  // Node scans (kube-bench) fill in the file-permission controls the API can't see.
  const list: ClusterScan[] = (scans ?? []).map(s => ({
    ...s,
    compliance: mergeNodeScan(s.compliance, nodeScans.get(s.clusterKey) ?? []).filter(r => (r.frameworks ?? ['cis']).includes(framework)),
  }));
  const sectionOf = (r: ControlResult) => (framework === 'nsa' ? r.nsa ?? 'Other' : r.section);
  const clusterOf = new Map(clusters.map(c => [c.key, c]));
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
  const sections = framework === 'nsa' ? NSA_ORDER.filter(x => present.has(x)) : Array.from(present);
  const totalControls = list[0]?.compliance.length ?? 0;
  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Compliance"
        headerProps={{
          actions: [
            <Button key="md" size="small" variant="outlined" disabled={!list.length} onClick={() => download(`vks-compliance-${stamp}.md`, complianceMarkdown(list, silences), 'text/markdown')}>
              Evidence (Markdown)
            </Button>,
            <Button key="csv" size="small" variant="outlined" disabled={!list.length} onClick={() => download(`vks-compliance-${stamp}.csv`, complianceCsv(list, silences), 'text/csv')}>
              CSV
            </Button>,
            <Button
              key="oscal"
              size="small"
              variant="outlined"
              disabled={!list.length}
              onClick={() => download(`vks-compliance-${framework}-${stamp}.oscal.json`, complianceOscal(list, silences, framework), 'application/json')}
            >
              OSCAL
            </Button>,
          ],
        }}
      >
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {totalControls} checks {framework === 'nsa' ? 'mapped to the NSA/CISA Kubernetes Hardening Guidance' : 'aligned with the CIS Kubernetes Benchmark'}, evaluated through the Kubernetes API: control-plane flags
          (from the static pods), each kubelet's live configuration, RBAC, Pod Security, network policies, service accounts and
          workloads. Each control says who owns it: <b>VKS</b> (platform configuration) or <b>you</b> (how the cluster is used).
          File-permission controls need a node-level scan and are never counted as passed. Not a certified CIS assessment.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 2, mb: 2 }}>
          <KpiTile label="Fleet score" value={fleet.scored ? `${fleet.pct}%` : '—'} sub={`${fleet.scored} of ${fleet.total} checks scored`} tone={fleet.pct >= 90 ? 'success' : fleet.pct >= 70 ? 'warning' : 'error'} meter={{ value: fleet.pct, max: 100 }} />
          <KpiTile label="Failing" value={failing} sub="not waived" tone={failing ? 'error' : 'success'} />
          <KpiTile label="Waived" value={waived} sub="accepted risks" tone="neutral" />
          <KpiTile label="Regressions" value={regressions} sub="since the baseline" tone={regressions ? 'warning' : 'success'} />
          <KpiTile label="To review" value={fleet.review} sub="need a person" tone="info" />
        </Box>
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField select size="small" label="Framework" value={framework} onChange={e => setFramework(e.target.value as Framework)} sx={{ minWidth: 220 }}>
            <MenuItem value="cis">CIS-aligned</MenuItem>
            <MenuItem value="nsa">NSA/CISA hardening</MenuItem>
          </TextField>
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
      </SectionBox>

      <IsolationSection />

      {list.length > 0 && (
        <SectionBox title="By section">
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
                          title={`${sc.pass} pass, ${sc.fail} fail, ${sc.review} review, ${sc.nodeScan} need a node scan, ${sc.unknown} not readable`}
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
        <SectionBox title="Failing across the fleet">
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

      <SectionBox title={`By cluster (${list.length})`}>
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
                  { label: 'Ref', getter: (r: ControlResult) => (framework === 'nsa' ? r.nsa ?? '—' : `${r.ref} · L${r.level}`) },
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
                    {clusterOf.get(s.clusterKey) && canWrite(clusterOf.get(s.clusterKey)!.supervisorId) && (
                      <Button size="small" variant="outlined" onClick={() => setScanning({ cluster: s.clusterName, contextName: s.contextName })}>
                        Run node scan…
                      </Button>
                    )}
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
                  <NodeScanResults
                    runs={nodeScans.get(s.clusterKey) ?? []}
                    showAll={!!showAllTests[s.clusterKey]}
                    toggle={() => setShowAllTests({ ...showAllTests, [s.clusterKey]: !showAllTests[s.clusterKey] })}
                  />
                </Box>
              ),
              renderAll: () => table(),
            };
          })}
        />
      </SectionBox>

      {(scanner ?? []).some(r => r.compliance.length) && (
        <SectionBox title="Trivy Operator compliance reports">
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

      {scanning && (
        <NodeScanDialog
          cluster={scanning.cluster}
          contextName={scanning.contextName}
          image={config.nodeScanImage}
          benchmark={config.nodeScanBenchmark}
          onClose={() => setScanning(null)}
          onDone={() => setScanVersion(v => v + 1)}
        />
      )}

      {waiving && <SilenceDialog match={{ issueId: waiving.issueId }} label={waiving.label} onClose={() => setWaiving(null)} />}
    </>
  );
}

const TEST_TONE: Record<BenchTest['status'], 'success' | 'error' | 'warning' | ''> = { PASS: 'success', FAIL: 'error', WARN: 'warning', INFO: '' };

/** The latest kube-bench results for a cluster (failures and warnings first). */
function NodeScanResults({ runs, showAll, toggle }: { runs: NodeScanRun[]; showAll: boolean; toggle: () => void }) {
  const cp = latest(runs, 'control-plane');
  const worker = latest(runs, 'worker');
  if (!cp && !worker) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
        No node scan yet. Run one for the file-permission checks.
      </Typography>
    );
  }
  const tests = [...(cp?.tests ?? []), ...(worker?.tests ?? [])];
  const foreign = [cp, worker].find(r => r && isForeignBenchmark(r.benchmark));
  const shown = showAll ? tests : tests.filter(t => t.status === 'FAIL' || t.status === 'WARN');
  const count = (st: BenchTest['status']) => tests.filter(t => t.status === st).length;
  return (
    <Box sx={{ mt: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
        <Typography sx={{ fontWeight: 600 }}>Node scan (kube-bench)</Typography>
        <Typography variant="body2" color="text.secondary">
          {[cp && `control plane ${new Date(cp.at).toLocaleString()}${cp.node ? ` on ${cp.node}` : ''}`, worker && `worker ${new Date(worker.at).toLocaleString()}${worker.node ? ` on ${worker.node}` : ''}`]
            .filter(Boolean)
            .join(' · ')}
          {cp?.benchmark ? ` · ${cp.benchmark}` : ''} · {count('PASS')} pass, {count('FAIL')} fail, {count('WARN')} warn
        </Typography>
        <Button size="small" onClick={toggle}>
          {showAll ? 'Only failures and warnings' : `Show all ${tests.length}`}
        </Button>
      </Box>
      {foreign && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          This scan used the <b>{foreign.benchmark}</b> benchmark: kube-bench mistook VKS for another platform (it reads the
          "+vmware" in the version). Its checks look for paths VKS nodes don't have, so the results aren't counted. Run the scan
          again with a CIS benchmark (for example cis-1.10).
        </Alert>
      )}
      <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem' }}>
        <tbody>
          {shown.map(t => (
            <Box component="tr" key={`${t.id}-${t.desc}`} sx={{ borderTop: '1px solid', borderColor: 'divider', verticalAlign: 'top' }}>
              <Box component="td" sx={{ p: 0.75, whiteSpace: 'nowrap' }}>
                <StatusLabel status={TEST_TONE[t.status]}>{t.status}</StatusLabel>
              </Box>
              <Box component="td" sx={{ p: 0.75, whiteSpace: 'nowrap', fontWeight: 600 }}>
                {t.id}
              </Box>
              <Box component="td" sx={{ p: 0.75 }}>
                {t.desc}
                {t.actual ? <Typography variant="caption" color="text.secondary" display="block">Found: {t.actual}</Typography> : null}
              </Box>
              <Box component="td" sx={{ p: 0.75, color: 'text.secondary' }}>
                {t.status === 'PASS' ? '' : t.remediation}
              </Box>
            </Box>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

