import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Typography } from '@mui/material';
import React from 'react';
import { FleetCluster, Health, ReplicaCount, SupervisorResult, supervisorLabel, WorkloadHealth } from '../types';

type LabelStatus = 'success' | 'warning' | 'error' | '';

const HEALTH: Record<Health, { text: string; status: LabelStatus }> = {
  healthy: { text: 'Healthy', status: 'success' },
  degraded: { text: 'Degraded', status: 'warning' },
  failed: { text: 'Failed', status: 'error' },
  provisioning: { text: 'Provisioning', status: '' },
  deleting: { text: 'Deleting', status: '' },
  unknown: { text: 'Unknown', status: 'warning' },
};

export function HealthLabel({ cluster }: { cluster: FleetCluster }) {
  const h = HEALTH[cluster.health];
  return (
    <Box component="span" sx={{ display: 'inline-flex', flexWrap: 'wrap', gap: 1 }}>
      <StatusLabel status={h.status}>{h.text}</StatusLabel>
      {cluster.upgrading && <StatusLabel status="warning">Upgrading</StatusLabel>}
    </Box>
  );
}

export function IssuesText({ cluster }: { cluster: FleetCluster }) {
  if (cluster.issues.length === 0) return null;
  return (
    <Typography variant="body2" sx={{ mt: 0.5 }}>
      {cluster.issues[0]}
      {cluster.issues.length > 1 ? ` (and ${cluster.issues.length - 1} more)` : ''}
    </Typography>
  );
}

export function VersionCell({ cluster }: { cluster: FleetCluster }) {
  return (
    <Box>
      <div>{cluster.kubernetesVersion ?? '—'}</div>
      {cluster.availableUpgrade && !cluster.upgrading && (
        <Typography variant="body2">
          {cluster.availableUpgrade.version} available
        </Typography>
      )}
    </Box>
  );
}

export function replicas(r?: ReplicaCount): string {
  return r ? `${r.ready} / ${r.desired}` : '—';
}

export function nodesText(c: FleetCluster): string {
  const parts: string[] = [];
  if (c.controlPlane) parts.push(`${c.controlPlane.ready}/${c.controlPlane.desired} control plane`);
  if (c.workers) parts.push(`${c.workers.ready}/${c.workers.desired} workers`);
  return parts.length ? parts.join(', ') : '—';
}

export function TenantText({ cluster }: { cluster: Pick<FleetCluster, 'tenantName' | 'tenantId' | 'tenantNamed'> }) {
  return <span title={cluster.tenantId}>{cluster.tenantName}</span>;
}

/** One-cell summary of what's happening inside the workload cluster. */
export function WorkloadCell({ health }: { health?: WorkloadHealth }) {
  if (!health) return <Typography variant="body2">Checking…</Typography>;
  switch (health.status) {
    case 'no-context':
      return <Typography variant="body2">Not signed in</Typography>;
    case 'expired':
      return <StatusLabel status="warning">Sign-in expired</StatusLabel>;
    case 'no-access':
      return <Typography variant="body2">No access</Typography>;
    case 'unreachable':
      return <StatusLabel status="error">Unreachable</StatusLabel>;
  }
  const problems: string[] = [];
  if (health.nodes && health.nodes.ready < health.nodes.total) {
    const n = health.nodes.total - health.nodes.ready;
    problems.push(`${n} node${n === 1 ? '' : 's'} not ready`);
  }
  if (health.podIssueCount) {
    problems.push(`${health.podIssueCount} pod${health.podIssueCount === 1 ? '' : 's'} failing`);
  }
  if (health.deploymentIssues.length) {
    const n = health.deploymentIssues.length;
    problems.push(`${n} deployment${n === 1 ? '' : 's'} unavailable`);
  }
  const partialNote = health.partial.length > 0 && (
    <Typography variant="body2" sx={{ mt: 0.5 }}>
      Some details not readable
    </Typography>
  );
  if (problems.length === 0) {
    return (
      <Box>
        <StatusLabel status="success">OK</StatusLabel>
        {health.nodes && (
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {health.nodes.ready}/{health.nodes.total} nodes ready
          </Typography>
        )}
        {partialNote}
      </Box>
    );
  }
  return (
    <Box>
      <StatusLabel status="warning">Issues</StatusLabel>
      <Typography variant="body2" sx={{ mt: 0.5 }}>
        {problems.join(', ')}
      </Typography>
      {partialNote}
    </Box>
  );
}

/** One banner per Supervisor with a problem. The rest of the fleet keeps rendering. */
export function SupervisorBanners({ results }: { results: SupervisorResult[] }) {
  const problems = results.filter(r => r.error || r.warnings.length > 0);
  if (problems.length === 0) {
    return null;
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
      {problems.map(r =>
        r.error ? (
          <Alert key={r.supervisor.id} severity="error">
            Couldn't load clusters from {supervisorLabel(r.supervisor)}. {r.error}
          </Alert>
        ) : (
          <Alert key={r.supervisor.id} severity="warning">
            Some data from {supervisorLabel(r.supervisor)} is incomplete.
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {r.warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </Box>
          </Alert>
        )
      )}
    </Box>
  );
}
