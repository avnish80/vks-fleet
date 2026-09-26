import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { ClusterScan } from '../clusterScan';
import { ControlResult, ControlStatus, CONTROL_COUNT, complianceIssueId, scoreResults } from '../compliance';
import { complianceCsv, complianceDrift, complianceMarkdown, isWaived, snapshot } from '../complianceReport';
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
import { BenchTest, latest, mergeNodeScan, NodeScanRun } from '../nodeScan';
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
  const store = useComplianceStore() ?? {};
  const [owner, setOwner] = React.useState<'all' | 'you' | 'vks'>('all');
  const [level, setLevel] = React.useState<1 | 2>(2);
  const [onlyFailing, setOnlyFailing] = React.useState(false);
  const [waiving, setWaiving] = React.useState<{ issueId: string; label: string } | null>(null);

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Compliance" what="compliance information" />;
  if (targets.length > 0 && scans === null) return <Loader title="Running the checks" />;
  // Node scans (kube-bench) fill in the file-permission controls the API can't see.
  const list: ClusterScan[] = (scans ?? []).map(s => ({ ...s, compliance: mergeNodeScan(s.compliance, nodeScans.get(s.clusterKey) ?? []) }));
  const clusterOf = new Map(clusters.map(c => [c.key, c]));
  const silences = activeSilences(config.silences);
  const baselines = store.baselines ?? {};
  const keep = (r: ControlResult) =>
    (owner === 'all' || (owner === 'you' ? r.owner !== 'vks' : r.owner !== 'you')) && r.level <= level && (!onlyFailing || r.status === 'fail');
  const effective = (s: ClusterScan) => s.compliance.map(r => (r.status === 'fail' && isWaived(silences, s.clusterKey, r.id) ? { ...r, status: 'pass' as ControlStatus } : r));
  const fleet = scoreResults(list.flatMap(s => effective(s).filter(r => r.level <= level)));
  const failing = list.reduce((n, s) => n + s.compliance.filter(r => r.status === 'fail' && !isWaived(silences, s.clusterKey, r.id)).length, 0);
  const waived = list.reduce((n, s) => n + s.compliance.filter(r => r.status === 'fail' && isWaived(silences, s.clusterKey, r.id)).length, 0);
  const regressions = list.reduce((n, s) => n + complianceDrift(baselines[s.clusterKey], s.compliance).filter(d => d.worse).length, 0);
  const sections = Array.from(new Set(list.flatMap(s => s.compliance.map(r => r.section))));
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
          ],
        }}
      >
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {CONTROL_COUNT} checks aligned with the CIS Kubernetes Benchmark, evaluated through the Kubernetes API: control-plane flags
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
                      const sc = scoreResults(effective(s).filter(r => r.section === sec && keep(r)));
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

      {list.map(s => {
        const drift = complianceDrift(baselines[s.clusterKey], s.compliance);
        const rows = s.compliance.filter(keep);
        const sc = scoreResults(effective(s));
        return (
          <Box key={s.clusterKey} id={encodeURIComponent(s.clusterKey)} sx={{ scrollMarginTop: 72 }}>
            <SectionBox
              title={`${s.clusterName}: ${sc.scored ? `${sc.pct}%` : 'not scored'} (${sc.scored} of ${sc.total} checks scored)`}
              headerProps={{
                actions: [
                  ...(clusterOf.get(s.clusterKey) && canWrite(clusterOf.get(s.clusterKey)!.supervisorId)
                    ? [
                        <Button key="scan" size="small" variant="outlined" onClick={() => setScanning({ cluster: s.clusterName, contextName: s.contextName })}>
                          Run node scan…
                        </Button>,
                      ]
                    : []),
                  <Button key="base" size="small" onClick={() => complianceStore.update({ baselines: { ...baselines, [s.clusterKey]: snapshot(s.compliance) } })}>
                    {baselines[s.clusterKey] ? 'Save as new baseline' : 'Save as baseline'}
                  </Button>,
                ],
              }}
            >
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
                data={rows}
              />
              <NodeScanResults
                runs={nodeScans.get(s.clusterKey) ?? []}
                showAll={!!showAllTests[s.clusterKey]}
                toggle={() => setShowAllTests({ ...showAllTests, [s.clusterKey]: !showAllTests[s.clusterKey] })}
              />
            </SectionBox>
          </Box>
        );
      })}

      {scanning && (
        <NodeScanDialog
          cluster={scanning.cluster}
          contextName={scanning.contextName}
          image={config.nodeScanImage}
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

