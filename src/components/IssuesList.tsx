import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { issueFix } from '../fixes';
import { leadsSomewhere } from '../links';
import { diagnosisMarkdown } from '../issues';
import { FleetCluster, Issue, RunbookStep } from '../types';
import { SilenceDialog } from './SilenceDialog';
import { useTone } from './charts';
import { SeverityLabel } from './common';

/** "Go to Packages"; long labels and ones that already say it become "Go to it". */
export function goTo(label: string): string {
  return /^go to /i.test(label) || label.length > 24 ? 'Go to it' : `Go to ${label}`;
}

function chips(label: string, items: string[], max = 4) {
  if (!items.length) return null;
  const shown = items.slice(0, max).join(', ');
  return (
    <Typography variant="body2">
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}:{' '}
      </Box>
      {shown}
      {items.length > max ? ` and ${items.length - max} more` : ''}
    </Typography>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      size="small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        } catch {
          // Clipboard blocked: the command is on screen to select by hand.
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Numbered steps with ready-to-run commands. */
export function Runbook({ steps }: { steps: RunbookStep[] }) {
  const all = steps.flatMap(s => s.commands ?? []).join('\n\n');
  return (
    <Box sx={{ mt: 1 }}>
      <Box component="ol" sx={{ m: 0, pl: 3, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        {steps.map((st, i) => (
          <li key={i}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {st.title}
            </Typography>
            {(st.commands ?? []).map((cmd, j) => (
              <Box
                key={j}
                sx={{ mt: 0.5, display: 'flex', alignItems: 'flex-start', gap: 1, bgcolor: 'action.hover', borderRadius: 1, p: 1 }}
              >
                <Box component="pre" sx={{ m: 0, flex: 1, overflowX: 'auto', fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {cmd}
                </Box>
                <CopyButton text={cmd} />
              </Box>
            ))}
            {st.note && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                {st.note}
              </Typography>
            )}
          </li>
        ))}
      </Box>
      {all && (
        <Box sx={{ mt: 1 }}>
          <CopyButton text={all} label="Copy all commands" />
        </Box>
      )}
    </Box>
  );
}

function IssueCard({
  issue,
  cluster,
  supervisorName,
  showCluster,
  simulate = false,
  defaultOpen = false,
}: {
  issue: Issue;
  cluster?: FleetCluster;
  supervisorName?: string;
  showCluster: boolean;
  simulate?: boolean;
  defaultOpen?: boolean;
}) {
  const tone = useTone();
  const [open, setOpen] = React.useState(defaultOpen);
  const fix = issue.severity === 'info' ? undefined : issueFix(issue, cluster);
  const fixed = simulate && !!fix;
  const [copied, setCopied] = React.useState<'idle' | 'done' | 'manual'>('idle');
  const [showRunbook, setShowRunbook] = React.useState(false);
  const [silencing, setSilencing] = React.useState(false);
  const text = React.useMemo(() => diagnosisMarkdown(issue, cluster, supervisorName), [issue, cluster, supervisorName]);
  const here = useLocation().pathname;
  const candidate = issue.primary ?? issue.links[0];
  // A link to this very page (with no section to jump to) would do nothing: leave it out.
  const primary = candidate && leadsSomewhere(candidate.path, here) ? candidate : undefined;
  const others = issue.links.filter(l => l.path !== candidate?.path && leadsSomewhere(l.path, here));
  const edge = fixed ? tone('info') : issue.severity === 'critical' ? tone('error') : issue.severity === 'warning' ? tone('warning') : tone('neutral');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
      window.setTimeout(() => setCopied('idle'), 2500);
    } catch {
      setCopied('manual');
    }
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        p: open ? 2 : 1.25,
        pl: 2.5,
        opacity: fixed ? 0.75 : 1,
        borderRadius: 2,
        position: 'relative',
        overflow: 'hidden',
        '&::before': { content: '""', position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: edge },
      }}
    >
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: open ? 'flex-start' : 'center', flexWrap: 'wrap' }}>
        <SeverityLabel severity={issue.severity} />
        <Box sx={{ flex: 1, minWidth: 240, textDecoration: fixed ? 'line-through' : 'none' }}>
          {primary ? (
            <Link to={primary.path} title={`Go to: ${primary.label}`} style={{ fontWeight: 600, textDecoration: 'none' }}>
              {issue.title} ›
            </Link>
          ) : (
            <Typography sx={{ fontWeight: 600 }}>{issue.title}</Typography>
          )}
          {showCluster && (issue.clusterName || supervisorName) && (
            <Typography variant="body2" color="text.secondary">
              {issue.clusterName ? `${issue.clusterName}${issue.tenantName ? `, tenant ${issue.tenantName}` : ''}` : `Supervisor ${supervisorName}`}
            </Typography>
          )}
        </Box>
        {issue.severity !== 'info' && (
          <Box component="span" sx={{ px: 1, py: '1px', borderRadius: 5, border: '1px solid', borderColor: fixed ? 'info.main' : fix ? 'text.primary' : 'warning.main', color: fixed ? 'info.main' : 'text.primary', fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
            {fixed ? 'Fixed in simulation' : fix ? 'Fix ready' : 'Needs a decision'}
          </Box>
        )}
        {fix ? (
          <Button size="small" variant="contained" component={Link} to={fix.path} title="Opens the action with its checks and a dry run; nothing changes until you confirm">
            {fix.label}…
          </Button>
        ) : (
          primary && (
            <Button size="small" variant="contained" component={Link} to={primary.path}>
              {goTo(primary.label)}
            </Button>
          )
        )}
        <Button size="small" variant="outlined" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : 'Details'}
        </Button>
      </Box>

      {open && (
      <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {fix && primary && (
          <Button size="small" variant="outlined" component={Link} to={primary.path}>
            {goTo(primary.label)}
          </Button>
        )}
        {issue.clusterKey && (
          <Button
            size="small"
            component={Link}
            to={`/vks-fleet/investigate?cluster=${encodeURIComponent(issue.clusterKey)}${issue.affected.nodes[0] ? `&node=${encodeURIComponent(issue.affected.nodes[0])}` : ''}`}
            title="What happened in this cluster as one story, and the layers under its nodes"
          >
            Investigate
          </Button>
        )}
        <Button size="small" onClick={() => setSilencing(true)}>
          Silence…
        </Button>
        <Button size="small" variant="outlined" onClick={copy}>
          {copied === 'done' ? 'Copied' : 'Copy diagnosis'}
        </Button>
      </Box>
      )}

      {open && (
      <Box sx={{ mt: 1.5, display: 'grid', gap: 1 }}>
        <Typography variant="body2">
          <Box component="span" sx={{ fontWeight: 700 }}>
            Cause:{' '}
          </Box>
          {issue.cause}
        </Typography>
        {issue.evidence.length > 0 && (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {issue.evidence.map(e => (
              <li key={e}>
                <Typography variant="body2">{e}</Typography>
              </li>
            ))}
          </Box>
        )}
        {chips('Nodes', issue.affected.nodes)}
        {chips('Pods', issue.affected.pods)}
        {issue.affected.clusters.length > 1 && chips('Clusters', issue.affected.clusters)}
        {issue.affected.tenants.length > 1 && chips('Tenants', issue.affected.tenants)}
        <Box sx={{ borderLeft: 3, borderColor: 'primary.main', pl: 1.25, py: 0.5, bgcolor: 'action.hover', borderRadius: 1 }}>
          <Typography variant="body2">
            <Box component="span" sx={{ fontWeight: 700 }}>
              What to do:{' '}
            </Box>
            {issue.fix}
          </Typography>
        </Box>
        {issue.runbook && issue.runbook.length > 0 && (
          <Box>
            <Button size="small" onClick={() => setShowRunbook(!showRunbook)}>
              {showRunbook ? 'Hide runbook' : `Runbook: ${issue.runbook.length} steps with commands`}
            </Button>
            {showRunbook && <Runbook steps={issue.runbook} />}
          </Box>
        )}
        {others.length > 0 && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {others.map(l => (
              <Link key={l.path} to={l.path}>
                {l.label}
              </Link>
            ))}
          </Box>
        )}
      </Box>
      )}

      {copied === 'manual' && (
        <Dialog open onClose={() => setCopied('idle')} maxWidth="md" fullWidth>
          <DialogTitle>Diagnosis</DialogTitle>
          <DialogContent>
            <Alert severity="info" sx={{ mb: 2 }}>
              The browser didn't allow copying automatically. Select the text below and copy it.
            </Alert>
            <TextField value={text} multiline fullWidth minRows={12} InputProps={{ readOnly: true }} />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCopied('idle')}>Close</Button>
          </DialogActions>
        </Dialog>
      )}
      {silencing && <SilenceDialog match={{ issueId: issue.id }} label={issue.title} onClose={() => setSilencing(false)} />}
    </Paper>
  );
}

export function IssuesList({
  issues,
  clusters,
  supervisorNames,
  showCluster = true,
  limit = 12,
  simulate = false,
}: {
  issues: Issue[];
  clusters: Map<string, FleetCluster>;
  supervisorNames: Map<string, string>;
  showCluster?: boolean;
  limit?: number;
  /** Show issues the plugin can fix as fixed (the fleet page's Simulate fixes). */
  simulate?: boolean;
}) {
  const [count, setCount] = React.useState(limit);
  const [q, setQ] = React.useState('');
  const needle = q.trim().toLowerCase();
  const matching = needle ? issues.filter(i => `${i.title} ${i.clusterName ?? ''} ${i.tenantName ?? ''} ${i.severity}`.toLowerCase().includes(needle)) : issues;
  const shown = matching.slice(0, count);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {issues.length > limit && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <TextField size="small" placeholder="Filter issues (title, cluster, org, severity)…" value={q} onChange={e => { setQ(e.target.value); setCount(limit); }} sx={{ width: 360 }} />
          <Typography variant="caption" color="text.secondary">
            {matching.length === issues.length ? `${issues.length} issues` : `${matching.length} of ${issues.length}`}
          </Typography>
        </Box>
      )}
      {shown.map(i => (
        <IssueCard
          key={i.id}
          issue={i}
          cluster={i.clusterKey ? clusters.get(i.clusterKey) : undefined}
          supervisorName={supervisorNames.get(i.supervisorId)}
          showCluster={showCluster}
          simulate={simulate}
          defaultOpen={issues.length === 1}
        />
      ))}
      {matching.length > count && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" onClick={() => setCount(count + limit)}>
            Show {Math.min(limit, matching.length - count)} more ({matching.length - count} left)
          </Button>
          <Button size="small" onClick={() => setCount(matching.length)}>
            Show all
          </Button>
        </Box>
      )}
    </Box>
  );
}
