/**
 * Security overview: how secure the fleet is, in one place. Everything here is
 * a summary of the Posture, Compliance and Vulnerabilities tabs, and opens
 * them; nothing new is scanned.
 */
import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Paper, Typography } from '@mui/material';
import React from 'react';
import { Link, useHistory } from 'react-router-dom';
import { useFleetData } from '../fleetContext';
import { shortener } from '../names';
import { download } from '../report';
import { clusterPath, COMPLIANCE_ROUTE, SECURITY_ROUTE, VULNS_ROUTE } from '../routes';
import { seriesLine, scoreSeries, sinceLast, sinceLastText, TREND_DAYS } from '../scoreHistory';
import { acceptedRisks, evidencePack, FailingControl, failingControls, securityRows, SecurityRow, securityScore } from '../securityOverview';
import { activeSilences } from '../silences';
import { useClusterScans } from '../useClusterScans';
import { useNodeScans } from '../useNodeScans';
import { useScannerReports } from '../useScannerReports';
import { useWorkloadHealth } from '../useWorkload';
import { ChartStyles, KpiTile } from './charts';
import { NoClusters } from './EmptyState';
import { card, scoreColour } from './FleetHero';
import { useScoreHistory } from './scoreHistoryStore';
import { SignInHelper } from './SignInHelper';

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
  const nodeScans = useNodeScans(targets, 0);
  const reports = useScannerReports(targets);
  const silences = activeSilences(config.silences);
  const input = { scans: scans ?? [], reports: reports ?? undefined, nodeScans, silences, now: new Date() };
  const score = scans?.length ? securityScore(input) : undefined;
  // Its own history, beside the fleet score's: one point a day in this browser.
  const { today, points, stored } = useScoreHistory(`security|${org}`, scans !== null && targets.length > 0, score?.pct, {});

  if (results === null) return <Loader title="Loading clusters" />;
  if (clusters.length === 0) return <NoClusters title="Security overview" what="security information" />;
  if (targets.length > 0 && scans === null) return <Loader title="Checking the clusters" />;

  const rows = securityRows(input);
  const failing = failingControls(input);
  const accepted = acceptedRisks(input);
  const short = shortener(clusters.map(c => c.name));
  const clusterOf = new Map(clusters.map(c => [c.key, c]));
  const scanned = (reports ?? []).filter(r => r.trivy);
  const critical = rows.reduce((n, r) => n + (r.vulns?.critical ?? 0), 0);
  const privileged = rows.reduce((n, r) => n + r.privilegedNamespaces, 0);
  const since = score ? sinceLastText(sinceLast(stored, today, score.pct)) : undefined;
  const { line, last } = points.length >= 2 ? seriesLine(scoreSeries(points), today, 170, 44) : { line: '', last: undefined };
  const colour = scoreColour(score?.pct);
  const stamp = new Date().toISOString().slice(0, 10);
  const worst = rows[0];

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
              title="One document: the summary, each cluster, what fails across the fleet, accepted risks, posture findings, vulnerabilities and the compliance evidence"
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
            <Paper variant="outlined" sx={{ ...card, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 3, rowGap: 1 }}>
              <Typography sx={{ fontSize: '2.6rem', fontWeight: 800, lineHeight: 1, color: colour, fontVariantNumeric: 'tabular-nums' }}>{score ? `${score.pct}%` : '—'}</Typography>
              <Box sx={{ flex: '1 1 340px', minWidth: 0 }}>
                <Typography sx={{ fontSize: '1.15rem', fontWeight: 800 }}>
                  {score ? `${score.pass} of ${score.scored} security checks pass across ${rows.length} cluster${rows.length === 1 ? '' : 's'}` : 'No security check could be scored yet'}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {score ? `Security score ${score.pct}%${since ? `, ${since}` : ''}. ` : ''}
                  {worst && rows.length > 1 && worst.compliance.scored ? `Lowest: ${short(worst.clusterName)} at ${worst.compliance.pct}%. ` : ''}
                  The score is the CIS-aligned compliance result, with accepted controls counted as passing; vulnerabilities and posture are shown beside it, not blended in. Not a certified CIS assessment.
                </Typography>
              </Box>
              {line ? (
                <Box sx={{ textAlign: 'right' }}>
                  <svg viewBox="0 0 170 44" width={170} height={44} role="img" aria-label={`Security score over ${points.length} days: from ${points[0].s} to ${points[points.length - 1].s}`} style={{ display: 'block' }}>
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

            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2 }}>
              <KpiTile
                label="Failing controls"
                value={failing.length}
                sub={failing.length ? `${rows.reduce((n, r) => n + r.failing, 0)} across clusters, not accepted` : 'none open'}
                tone={failing.length ? 'error' : 'success'}
                onClick={() => history.push(COMPLIANCE_ROUTE)}
                hint="Open Compliance"
              />
              <KpiTile
                label="Critical vulnerabilities"
                value={scanned.length ? critical : '—'}
                sub={scanned.length ? `from Trivy in ${scanned.length} of ${rows.length} cluster${rows.length === 1 ? '' : 's'}` : 'no scanner (Trivy) in any cluster'}
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
            One row per signed-in cluster, the lowest compliance first.
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
              {
                label: 'Compliance',
                getter: (r: SecurityRow) => (r.compliance.scored ? <StatusLabel status={pctStatus(r.compliance.pct)}>{`${r.compliance.pct}%`}</StatusLabel> : '—'),
              },
              { label: 'Failing controls', getter: (r: SecurityRow) => <StatusLabel status={countStatus(r.failing, 5)}>{String(r.failing)}</StatusLabel> },
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
                getter: (r: SecurityRow) => (r.vulns ? <StatusLabel status={r.vulns.critical ? 'error' : 'success'}>{`${r.vulns.critical}${r.vulns.high ? ` (+${r.vulns.high} high)` : ''}`}</StatusLabel> : <span title="No Trivy Operator in this cluster">no scanner</span>),
              },
              {
                label: 'Node scan',
                getter: (r: SecurityRow) =>
                  r.nodeScanDays === undefined ? (
                    <span title="File-permission controls need a node-level scan (kube-bench); run one from Compliance">never</span>
                  ) : (
                    <StatusLabel status={r.nodeScanDays > 30 ? 'warning' : 'success'}>{r.nodeScanDays === 0 ? 'today' : `${r.nodeScanDays} days ago`}</StatusLabel>
                  ),
              },
              { label: 'Accepted', getter: (r: SecurityRow) => String(r.accepted) },
            ]}
            data={rows}
          />
        </SectionBox>
      )}

      {rows.length > 0 && (
        <SectionBox
          title="Fix once"
          headerProps={{
            actions: [
              <Button key="all" size="small" variant="outlined" component={Link} to={COMPLIANCE_ROUTE}>
                All controls
              </Button>,
            ],
          }}
        >
          {failing.length === 0 ? (
            <Typography sx={{ color: 'success.main', fontWeight: 700 }}>No control is failing in any cluster.</Typography>
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
    </>
  );
}
