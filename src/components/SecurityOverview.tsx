/**
 * Security overview: how secure the fleet is, in one place. Everything here is
 * a summary of the Posture, Compliance and Vulnerabilities tabs, and opens
 * them; nothing new is scanned.
 */
import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link, useHistory } from 'react-router-dom';
import { useFleetData } from '../fleetContext';
import { shortener } from '../names';
import { download } from '../report';
import { clusterPath, COMPLIANCE_ROUTE, SECURITY_ROUTE, VULNS_ROUTE } from '../routes';
import { seriesLine, scoreSeries, sinceLast, sinceLastText, TREND_DAYS } from '../scoreHistory';
import { cisCoverage } from '../benchmark';
import { GENERIC_CIS_NOTICE } from '../compliance';
import { acceptedRisks, evidencePack, FailingControl, failingControls, securityRows, SecurityRow, securityScore, vulnCounts } from '../securityOverview';
import { activeSilences } from '../silences';
import { useClusterScans } from '../useClusterScans';
import { useScannerReports } from '../useScannerReports';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';
import { NoClusters } from './EmptyState';
import { card, scoreColour } from './FleetHero';
import { useScoreHistory } from './scoreHistoryStore';
import { SignInHelper } from './SignInHelper';

interface Method {
  figure: string;
  from: string;
  needs: string;
  limits: string;
}

/** Where each figure on this page comes from, what it needs, and what it can't see. */
const METHODS: Method[] = [
  {
    figure: 'Pod Security, privileged pods, cluster-admin grants',
    from: "The cluster's API: namespace labels, the cluster default (probed with a dry run), running pods, role bindings",
    needs: 'Nothing installed. A sign-in to the cluster that can read them',
    limits: 'What an admission webhook or policy engine would refuse beyond Pod Security',
  },
  {
    figure: 'Vulnerabilities',
    from: 'The reports Trivy Operator writes into the cluster; each image counted once, yours apart from VKS-managed ones',
    needs: 'Trivy Operator installed in the cluster',
    limits: 'Images Trivy has not scanned yet, and anything in a cluster without it ("not measured", never zero)',
  },
  {
    figure: 'Policy results (Compliance tab)',
    from: 'PolicyReports in the cluster',
    needs: 'A policy engine that writes them, such as Kyverno (optional)',
    limits: 'Policies you have not written',
  },
];

/** The extra row when the generic CIS benchmark checks are switched on. */
const CIS_METHOD: Method = {
  figure: 'Generic CIS result',
  from: "Each cluster's Kubernetes API: control-plane flags from the static pods, every kubelet's live configuration, RBAC, namespaces and workloads",
  needs: 'Nothing installed. Switched on in the plugin settings',
  limits: 'File permissions on the nodes, the recommendations that need a person, and which settings VKS supports changing',
};

type Status = 'success' | 'warning' | 'error' | '';
const pctStatus = (p: number): Status => (p >= 90 ? 'success' : p >= 70 ? 'warning' : 'error');
const countStatus = (n: number, bad = 1): Status => (n >= bad ? 'error' : n > 0 ? 'warning' : 'success');
const OWNER: Record<FailingControl['owner'], string> = { vks: 'VKS', you: 'Cluster owner', shared: 'Shared' };

export function SecurityOverviewPage() {
  const { config, results, org } = useFleetData();
  const history = useHistory();
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const targets = clusters
    .map(c => ({ key: c.key, name: c.name, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { key: string; name: string; contextName: string } => !!t.contextName);
  const scans = useClusterScans(targets, config.baseline?.allowedRegistries ?? []);
  /** The generic CIS benchmark checks: off unless switched on in the settings. */
  const cis = config.cisBenchmark === true;
  const reports = useScannerReports(targets);
  const silences = activeSilences(config.silences);
  const input = { scans: scans ?? [], reports: reports ?? undefined, cis, silences, now: new Date() };
  const score = scans?.length ? securityScore(input) : undefined;
  // Its own history, beside the fleet score's: one point a day in this browser.
  const { today, points, stored } = useScoreHistory(`security|${org}`, cis && scans !== null && targets.length > 0, score?.pct, {});

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Security overview" what="security information" />;
  if (targets.length > 0 && scans === null) return <Loader title="Checking the clusters" />;

  const rows = securityRows(input);
  const failing = failingControls(input);
  const accepted = acceptedRisks(input);
  const short = shortener(clusters.map(c => c.name));
  const clusterOf = new Map(clusters.map(c => [c.key, c]));
  const scanned = (reports ?? []).filter(r => r.trivy);
  // Each image once across the fleet, your own apart from the ones VKS ships: the Vulnerabilities tab's counting.
  const vulns = vulnCounts(scanned);
  const critical = vulns.critical;
  const beyond = rows.filter(r => r.benchmarkBeyond);
  const cover = cisCoverage();
  const privileged = rows.reduce((n, r) => n + r.privilegedNamespaces, 0);
  const since = score ? sinceLastText(sinceLast(stored, today, score.pct)) : undefined;
  const { line, last } = points.length >= 2 ? seriesLine(scoreSeries(points), today, 170, 44) : { line: '', last: undefined };
  const colour = scoreColour(score?.pct);
  const stamp = new Date().toISOString().slice(0, 10);
  const worst = rows[0];
  const privilegedPods = rows.reduce((n, r) => n + r.privilegedPods, 0);
  const adminGrants = rows.reduce((n, r) => n + r.adminGrants, 0);
  const openTotal = privileged + privilegedPods + adminGrants + (scanned.length ? critical : 0);

  return (
    <>
      <ChartStyles />
      <SectionBox
        title="Security overview"
        headerProps={{
          actions: [
            <Button
              key="pack"
              size="small"
              variant="outlined"
              disabled={!rows.length}
              title="One document: how it is measured, the summary, each cluster, accepted risks, posture findings and vulnerabilities"
              onClick={() => download(`vks-security-evidence-${stamp}.md`, evidencePack(input), 'text/markdown')}
            >
              Evidence pack (Markdown)
            </Button>,
          ],
        }}
      >
        <SignInHelper clusters={clusters} health={workload.byKey} supervisors={config.supervisors} />
        {rows.length === 0 ? (
          <Typography>Sign in to a cluster to see its security here: the checks read each cluster's own API.</Typography>
        ) : (
          <Box sx={{ display: 'grid', gap: 2 }}>
            {cis ? (
              <>
                <Alert severity="warning">{GENERIC_CIS_NOTICE} Switched on in the plugin settings.</Alert>
                <Paper variant="outlined" sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, rowGap: 1 }}>
                  <Typography sx={{ fontSize: '2.6rem', fontWeight: 800, lineHeight: 1, color: colour, fontVariantNumeric: 'tabular-nums' }}>{score ? `${score.pct}%` : '—'}</Typography>
                  <Box sx={{ flex: '1 1 340px', minWidth: 0 }}>
                    <Typography sx={{ fontSize: '1.15rem', fontWeight: 800 }}>
                      {score ? `${score.pass} of ${score.scored} generic CIS checks pass across ${rows.length} cluster${rows.length === 1 ? '' : 's'}` : 'No generic CIS check could be scored yet'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {score ? `Generic CIS result ${score.pct}%${since ? `, ${since}` : ''}. ` : ''}
                      {worst && rows.length > 1 && worst.compliance?.scored ? `Lowest: ${short(worst.clusterName)} at ${worst.compliance.pct}%. ` : ''}
                      Accepted controls count as passing; vulnerabilities and posture are shown beside it, not blended in.
                    </Typography>
                  </Box>
                  {line ? (
                    <Box sx={{ textAlign: 'right' }}>
                      <svg viewBox="0 0 170 44" width={170} height={44} role="img" aria-label={`Generic CIS result over ${points.length} days: from ${points[0].s} to ${points[points.length - 1].s}`} style={{ display: 'block' }}>
                        <polyline points={line} fill="none" stroke={colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                        {last && <circle cx={last.x} cy={last.y} r={3.5} fill={colour} />}
                      </svg>
                      <Typography variant="caption" color="text.secondary" title="One point a day, kept in this browser only.">
                        {points.length >= TREND_DAYS ? `${TREND_DAYS}-day trend` : `Trend over ${points.length} days`} · from {points[0].s}%
                      </Typography>
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                      Trend starts today (kept in this browser)
                    </Typography>
                  )}
                </Paper>
              </>
            ) : (
              <Paper variant="outlined" sx={{ ...card }}>
                <Typography sx={{ fontSize: '1.15rem', fontWeight: 800 }}>
                  {openTotal === 0
                    ? `Nothing open across ${rows.length} cluster${rows.length === 1 ? '' : 's'}`
                    : `${[privileged && `${privileged} privileged namespace${privileged === 1 ? '' : 's'}`, privilegedPods && `${privilegedPods} privileged pod${privilegedPods === 1 ? '' : 's'}`, adminGrants && `${adminGrants} cluster-admin grant${adminGrants === 1 ? '' : 's'}`, scanned.length && critical ? `${critical} critical vulnerabilit${critical === 1 ? 'y' : 'ies'}` : 0].filter(Boolean).join(', ')} across ${rows.length} cluster${rows.length === 1 ? '' : 's'}`}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  What is open in the clusters you are signed in to: Pod Security, privileged workloads, cluster-admin access and image vulnerabilities. There is no single score and no benchmark
                  here: VMware does not publish or support a CIS benchmark for VKS. See how it is measured, below.
                </Typography>
              </Paper>
            )}

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2 }}>
              {cis ? (
                <KpiTile
                  label="Generic CIS checks failing"
                  value={failing.length}
                  sub={failing.length ? `${rows.reduce((n, r) => n + (r.failing ?? 0), 0)} across clusters, not accepted` : 'none open'}
                  tone={failing.length ? 'error' : 'success'}
                  onClick={() => history.push(COMPLIANCE_ROUTE)}
                  hint="Open Compliance"
                />
              ) : (
                <KpiTile
                  label="Privileged pods and admin grants"
                  value={privilegedPods + adminGrants}
                  sub={`${privilegedPods} privileged or host-level pod${privilegedPods === 1 ? '' : 's'}, ${adminGrants} cluster-admin grant${adminGrants === 1 ? '' : 's'}, not accepted`}
                  tone={privilegedPods + adminGrants ? 'warning' : 'success'}
                  onClick={() => history.push(SECURITY_ROUTE)}
                  hint="Open Posture"
                />
              )}
              <KpiTile
                label="Critical vulnerabilities"
                value={scanned.length ? critical : '—'}
                sub={
                  scanned.length
                    ? `in your images, each image counted once; Trivy in ${scanned.length} of ${rows.length} cluster${rows.length === 1 ? '' : 's'}${vulns.vksCritical ? `. ${vulns.vksCritical} more in VKS-managed images, which VKS rebuilds` : ''}`
                    : 'not measured: no cluster has Trivy Operator'
                }
                tone={!scanned.length ? 'neutral' : critical ? 'error' : 'success'}
                onClick={() => history.push(VULNS_ROUTE)}
                hint="Open Vulnerabilities"
              />
              <KpiTile
                label="Privileged namespaces"
                value={privileged}
                sub={`of ${rows.reduce((n, r) => n + r.namespaces, 0)} user namespaces: Pod Security lets any pod take over its node`}
                tone={privileged ? 'warning' : 'success'}
                onClick={() => history.push(SECURITY_ROUTE)}
                hint="Open Posture"
              />
              <KpiTile
                label="Accepted risks"
                value={accepted.count}
                sub={accepted.next ? `the first acceptance ends in ${accepted.next.days} day${accepted.next.days === 1 ? '' : 's'}` : 'nothing waived or accepted'}
                tone="neutral"
                hint={accepted.next ? `Ends first: ${accepted.next.label} (${accepted.next.until.slice(0, 10)}). Accepted risks are counted apart from open ones, and come back when their acceptance ends.` : undefined}
              />
            </Box>
          </Box>
        )}
      </SectionBox>

      {rows.length > 0 && (
        <SectionBox title="Clusters">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            One row per signed-in cluster, {cis ? 'the lowest generic CIS result first' : 'the one with the most open first'}.{beyond.length ? ` * Kubernetes newer than the newest CIS benchmark covers (v2.0 is written for 1.34 to 1.35): measured against it all the same.` : ''}
          </Typography>
          <SimpleTable
            columns={[
              {
                label: 'Cluster',
                getter: (r: SecurityRow) => {
                  const c = clusterOf.get(r.clusterKey);
                  return c ? (
                    <Link to={clusterPath(c)} title={r.clusterName}>
                      {short(r.clusterName)}
                    </Link>
                  ) : (
                    short(r.clusterName)
                  );
                },
              },
              ...(cis
                ? [
              {
                label: 'Benchmark',
                getter: (r: SecurityRow) =>
                  r.benchmark ? (
                    <span title={r.benchmarkBeyond ? `This cluster's Kubernetes is newer than CIS v${r.benchmark} covers; it is the newest benchmark there is.` : `The generic CIS Kubernetes Benchmark written for this cluster's Kubernetes version. Not a VKS benchmark.`}>
                      CIS {r.benchmark}
                      {r.benchmarkBeyond ? ' *' : ''}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              {
                label: 'Generic CIS result',
                getter: (r: SecurityRow) => (r.compliance?.scored ? <StatusLabel status={pctStatus(r.compliance.pct)}>{`${r.compliance.pct}%`}</StatusLabel> : '—'),
              },
              { label: 'Failing', getter: (r: SecurityRow) => <StatusLabel status={countStatus(r.failing ?? 0, 5)}>{String(r.failing ?? 0)}</StatusLabel> },
                  ]
                : []),
              {
                label: 'Pod Security',
                getter: (r: SecurityRow) => (
                  <StatusLabel status={r.privilegedNamespaces ? 'warning' : r.psaDefault ? 'success' : ''}>
                    {`${r.psaDefault ? `default ${r.psaDefault}` : 'default not known'}${r.privilegedNamespaces ? `, ${r.privilegedNamespaces} of ${r.namespaces} privileged` : ''}`}
                  </StatusLabel>
                ),
              },
              { label: 'Privileged pods', getter: (r: SecurityRow) => <StatusLabel status={r.privilegedPods ? 'warning' : 'success'}>{String(r.privilegedPods)}</StatusLabel> },
              { label: 'cluster-admin grants', getter: (r: SecurityRow) => <StatusLabel status={r.adminGrants ? 'warning' : 'success'}>{String(r.adminGrants)}</StatusLabel> },
              {
                label: 'Critical CVEs',
                getter: (r: SecurityRow) =>
                  r.vulns ? (
                    <span title={`In your images, each image counted once: ${r.vulns.critical} critical, ${r.vulns.high} high. In VKS-managed images (rebuilt by VKS): ${r.vulns.vksCritical} critical, ${r.vulns.vksHigh} high.`}>
                      <StatusLabel status={r.vulns.critical ? 'error' : 'success'}>{`${r.vulns.critical} yours`}</StatusLabel>
                      {r.vulns.vksCritical ? ` +${r.vulns.vksCritical} VKS` : ''}
                    </span>
                  ) : (
                    <span title="Not measured: Trivy Operator isn't installed in this cluster">not measured</span>
                  ),
              },
              { label: 'Accepted', getter: (r: SecurityRow) => String(r.accepted) },
              {
                label: 'Measured with',
                getter: (r: SecurityRow) => {
                  const missing = [!r.sources.scanner && 'Trivy Operator', !r.sources.policyEngine && 'a policy engine'].filter(Boolean);
                  return (
                    <span title={missing.length ? `Not measured here: ${missing.join(', ')}. See how it is measured, below.` : 'Every source is present.'}>
                      {['API', r.sources.scanner && 'Trivy', r.sources.policyEngine && 'policies'].filter(Boolean).join(', ')}
                    </span>
                  );
                },
              },
            ]}
            data={rows}
          />
        </SectionBox>
      )}

      {cis && rows.length > 0 && (
        <SectionBox
          title="Generic CIS checks: fix once"
          headerProps={{
            actions: [
              <Button key="all" size="small" variant="outlined" component={Link} to={COMPLIANCE_ROUTE}>
                All controls
              </Button>,
            ],
          }}
        >
          {failing.length === 0 ? (
            <Typography sx={{ color: 'success.main', fontWeight: 700 }}>No generic CIS check is failing in any cluster.</Typography>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                The controls failing in the most clusters: each is one thing to put right once. The owner says who can: you (how the cluster is used) or VKS (platform configuration, not yours to
                change).
              </Typography>
              <SimpleTable
                columns={[
                  {
                    label: 'Control',
                    getter: (f: FailingControl) => (
                      <span title={f.ref}>
                        <b>{f.title}</b>
                      </span>
                    ),
                  },
                  { label: 'Owner', getter: (f: FailingControl) => OWNER[f.owner] },
                  {
                    label: 'Clusters',
                    getter: (f: FailingControl) => (
                      <span title={f.clusters.join(', ')}>
                        {f.clusters.length === rows.length && rows.length > 1 ? `all ${rows.length}` : f.clusters.length}
                        {f.clusters.length <= 3 ? `: ${f.clusters.map(short).join(', ')}` : ''}
                      </span>
                    ),
                  },
                  { label: 'How to fix', getter: (f: FailingControl) => f.remediation },
                ]}
                data={failing.slice(0, 8)}
              />
              {failing.length > 8 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  And {failing.length - 8} more on <Link to={COMPLIANCE_ROUTE}>Compliance</Link>.
                </Typography>
              )}
            </>
          )}
        </SectionBox>
      )}
      {rows.length > 0 && (
        <SectionBox title="How this is measured">
          {cis ? (
            <Typography variant="body2" sx={{ mb: 1 }}>
              {GENERIC_CIS_NOTICE} Each cluster is aligned with the benchmark written for its Kubernetes version: v2.0 for 1.34 to 1.35 (and, marked, for anything newer), v1.12 for 1.32 to 1.33,
              v1.11 for 1.29 to 1.31. Of the {cover.total} recommendations in v2.0, <b>{cover.assessed}</b> are assessed automatically and {cover.manual} are listed for a person to review; the rest
              are named in the evidence pack. The checks' wording is this plugin's own.
            </Typography>
          ) : (
            <Typography variant="body2" sx={{ mb: 1 }}>
              Everything here is read from the clusters you are signed in to; nothing new is scanned. <b>No benchmark is scored:</b> VMware does not publish or support a CIS benchmark for VKS, and
              a generic one flags settings that VKS manages. Generic CIS checks can be switched on as a reference in Settings → Plugins → vks-fleet.
            </Typography>
          )}
          <SimpleTable
            columns={[
              { label: 'Figure', getter: (m: Method) => <b>{m.figure}</b> },
              { label: 'Where it comes from', getter: (m: Method) => m.from },
              { label: 'Needs in the cluster', getter: (m: Method) => m.needs },
              { label: "What it doesn't show", getter: (m: Method) => m.limits },
            ]}
            data={cis ? [CIS_METHOD, ...METHODS] : METHODS}
          />
          {cis && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              The trend is kept in this browser only.
            </Typography>
          )}
        </SectionBox>
      )}
    </>
  );
}
