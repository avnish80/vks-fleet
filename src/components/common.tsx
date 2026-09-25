import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box } from '@mui/material';
import React from 'react';
import { FleetCluster, Health, ReplicaCount, SupervisorResult, supervisorLabel } from '../types';

const HEALTH: Record<Health, { text: string; status: 'success' | 'warning' | 'error' | '' }> = {
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
    <Box component="span" sx={{ display: 'inline-flex', gap: 1 }}>
      <StatusLabel status={h.status}>{h.text}</StatusLabel>
      {cluster.upgrading && <StatusLabel status="warning">Upgrading</StatusLabel>}
    </Box>
  );
}

export function replicas(r?: ReplicaCount): string {
  return r ? `${r.ready} / ${r.desired}` : '—';
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
