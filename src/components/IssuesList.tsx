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
import { Link } from 'react-router-dom';
import { diagnosisMarkdown } from '../issues';
import { FleetCluster, Issue } from '../types';
import { useTone } from './charts';
import { SeverityLabel } from './common';

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

function IssueCard({
  issue,
  cluster,
  supervisorName,
  showCluster,
}: {
  issue: Issue;
  cluster?: FleetCluster;
  supervisorName?: string;
  showCluster: boolean;
}) {
  const tone = useTone();
  const [copied, setCopied] = React.useState<'idle' | 'done' | 'manual'>('idle');
  const text = React.useMemo(() => diagnosisMarkdown(issue, cluster, supervisorName), [issue, cluster, supervisorName]);
  const edge = issue.severity === 'critical' ? tone('error') : issue.severity === 'warning' ? tone('warning') : tone('neutral');

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
        p: 2,
        pl: 2.5,
        borderRadius: 2,
        position: 'relative',
        overflow: 'hidden',
        '&::before': { content: '""', position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: edge },
      }}
    >
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <SeverityLabel severity={issue.severity} />
        <Box sx={{ flex: 1, minWidth: 240 }}>
          <Typography sx={{ fontWeight: 600 }}>{issue.title}</Typography>
          {showCluster && (issue.clusterName || supervisorName) && (
            <Typography variant="body2" color="text.secondary">
              {issue.clusterName ? `${issue.clusterName}${issue.tenantName ? `, tenant ${issue.tenantName}` : ''}` : `Supervisor ${supervisorName}`}
            </Typography>
          )}
        </Box>
        <Button size="small" variant="outlined" onClick={copy}>
          {copied === 'done' ? 'Copied' : 'Copy diagnosis'}
        </Button>
      </Box>

      <Box sx={{ mt: 1.5, display: 'grid', gap: 1 }}>
        <Typography variant="body2">
          <Box component="span" sx={{ color: 'text.secondary' }}>
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
        <Typography variant="body2">
          <Box component="span" sx={{ color: 'text.secondary' }}>
            What to do:{' '}
          </Box>
          {issue.fix}
        </Typography>
        {issue.links.length > 0 && (
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            {issue.links.map(l => (
              <Link key={l.path} to={l.path}>
                {l.label}
              </Link>
            ))}
          </Box>
        )}
      </Box>

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
    </Paper>
  );
}

export function IssuesList({
  issues,
  clusters,
  supervisorNames,
  showCluster = true,
  limit = 12,
}: {
  issues: Issue[];
  clusters: Map<string, FleetCluster>;
  supervisorNames: Map<string, string>;
  showCluster?: boolean;
  limit?: number;
}) {
  const [all, setAll] = React.useState(false);
  const shown = all ? issues : issues.slice(0, limit);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {shown.map(i => (
        <IssueCard
          key={i.id}
          issue={i}
          cluster={i.clusterKey ? clusters.get(i.clusterKey) : undefined}
          supervisorName={supervisorNames.get(i.supervisorId)}
          showCluster={showCluster}
        />
      ))}
      {issues.length > limit && (
        <Box>
          <Button size="small" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${issues.length}`}
          </Button>
        </Box>
      )}
    </Box>
  );
}
