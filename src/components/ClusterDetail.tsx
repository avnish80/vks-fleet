import {
  Loader,
  NameValueTable,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Typography } from '@mui/material';
import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { FLEET_PATH } from '../routes';
import { usePluginConfig } from '../settings/store';
import { ClusterCondition, clusterKey, supervisorLabel } from '../types';
import { useFleet } from '../useFleet';
import { HealthLabel, replicas, SupervisorBanners } from './common';

function conditionStatus(c: ClusterCondition): 'success' | 'warning' | 'error' | '' {
  if (c.status === 'True') return 'success';
  if (c.status === 'False') return c.severity === 'Error' ? 'error' : 'warning';
  return '';
}

export function ClusterDetail() {
  const params = useParams<{ supervisor: string; namespace: string; name: string }>();
  const config = usePluginConfig();
  const supervisor = config.supervisors.find(s => s.id === params.supervisor);

  // Only read the Supervisor this cluster lives on.
  const scoped = React.useMemo(() => (supervisor ? [supervisor] : []), [supervisor]);
  const { results } = useFleet(scoped, config.refreshSeconds);

  const back = (
    <Box sx={{ mb: 2 }}>
      <Link to={FLEET_PATH}>Back to fleet</Link>
    </Box>
  );

  if (!supervisor) {
    return (
      <SectionBox title={params.name}>
        {back}
        <Typography>
          This link points at Supervisor "{params.supervisor}", which isn't configured here. Add it in the
          plugin settings with that Supervisor ID.
        </Typography>
      </SectionBox>
    );
  }

  if (results === null) {
    return <Loader title={`Loading ${params.name}`} />;
  }

  const key = clusterKey(params.supervisor, params.namespace, params.name);
  const cluster = results.flatMap(r => r.clusters).find(c => c.key === key);

  if (!cluster) {
    return (
      <SectionBox title={params.name}>
        {back}
        <SupervisorBanners results={results} />
        <Typography>
          Cluster {params.name} wasn't found in namespace {params.namespace} on {supervisorLabel(supervisor)}.
          It may have been deleted, or your account may not have access to that namespace.
        </Typography>
      </SectionBox>
    );
  }

  return (
    <>
      <SectionBox title={cluster.name}>
        {back}
        <SupervisorBanners results={results} />
        <NameValueTable
          rows={[
            { name: 'Status', value: <HealthLabel cluster={cluster} /> },
            { name: 'Tenant', value: cluster.tenantMapped ? cluster.tenant : `${cluster.tenant} (no tenant label)` },
            { name: 'Supervisor', value: supervisorLabel(supervisor) },
            { name: 'Namespace', value: cluster.namespace },
            { name: 'Phase', value: cluster.phase },
            { name: 'Kubernetes (desired)', value: cluster.kubernetesVersion ?? '—' },
            { name: 'Kubernetes (control plane)', value: cluster.controlPlaneVersion ?? '—' },
            { name: 'Class', value: cluster.clusterClass ?? '—' },
            { name: 'Control plane ready', value: replicas(cluster.controlPlane) },
            { name: 'Workers ready', value: replicas(cluster.workers) },
            { name: 'Created', value: cluster.createdAt ? new Date(cluster.createdAt).toLocaleString() : '—' },
          ]}
        />
      </SectionBox>

      <SectionBox title="Conditions">
        {cluster.conditions.length === 0 ? (
          <Typography>The Supervisor hasn't reported any conditions for this cluster yet.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Condition', getter: (c: ClusterCondition) => c.type },
              {
                label: 'Status',
                getter: (c: ClusterCondition) => <StatusLabel status={conditionStatus(c)}>{c.status}</StatusLabel>,
              },
              { label: 'Reason', getter: (c: ClusterCondition) => c.reason ?? '—' },
              { label: 'Message', getter: (c: ClusterCondition) => c.message ?? '—' },
              {
                label: 'Last change',
                getter: (c: ClusterCondition) =>
                  c.lastTransitionTime ? new Date(c.lastTransitionTime).toLocaleString() : '—',
              },
            ]}
            data={cluster.conditions}
          />
        )}
      </SectionBox>
    </>
  );
}
