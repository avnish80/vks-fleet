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
import { formatDuration } from '../capi/v1beta1';
import { serverHost } from '../contexts';
import { AddonInfo } from '../extras';
import { FLEET_PATH, headlampClusterPath } from '../routes';
import { usePluginConfig } from '../settings/store';
import {
  ClusterCondition,
  clusterKey,
  DeploymentIssue,
  EventInfo,
  FleetCluster,
  MachineInfo,
  NodePool,
  PodIssue,
  supervisorLabel,
  WorkloadHealth,
} from '../types';
import { useClusterExtras } from '../useClusterExtras';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';
import { HealthLabel, replicas, SupervisorBanners, WorkloadCell } from './common';

type LabelStatus = 'success' | 'warning' | 'error' | '';

function conditionStatus(c: ClusterCondition): LabelStatus {
  if (c.status === 'True') return 'success';
  if (c.status === 'False') return c.severity === 'Error' ? 'error' : 'warning';
  return '';
}

function phaseStatus(m: MachineInfo): LabelStatus {
  if (m.deletingSince) return 'warning';
  if (m.phase === 'Running') return m.ready === false ? 'warning' : 'success';
  if (m.phase === 'Failed') return 'error';
  return '';
}

function when(ts?: string): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function ageOf(ts?: string): string {
  return ts ? formatDuration(Date.now() - new Date(ts).getTime()) : '—';
}

function poolSize(p: NodePool): string {
  const desired = p.desired ?? (p.autoscaler ? 'auto' : '?');
  return `${p.ready} / ${desired}`;
}

function autoscaling(p: NodePool): string {
  if (!p.autoscaler) return 'Off';
  return `${p.autoscaler.min ?? '?'} to ${p.autoscaler.max ?? '?'} nodes`;
}

function Code({ children }: { children: string }) {
  return (
    <Box
      component="pre"
      sx={{ p: 1.5, m: 0, overflowX: 'auto', fontSize: '0.85rem', bgcolor: 'action.hover', borderRadius: 1 }}
    >
      {children}
    </Box>
  );
}

function LoginHint({ cluster, supervisorHost }: { cluster: FleetCluster; supervisorHost?: string }) {
  return (
    <Box>
      <Typography sx={{ mb: 1 }}>
        Headlamp isn't signed in to this cluster yet. Sign in with your own account on the machine running
        Headlamp, then reload Headlamp's kubeconfig (for the container setup: docker restart headlamp).
      </Typography>
      <Code>
        {`kubectl vsphere login --server=${supervisorHost ?? '<supervisor>'} \\
  --vsphere-username <you@domain> --insecure-skip-tls-verify \\
  --tanzu-kubernetes-cluster-namespace ${cluster.namespace} \\
  --tanzu-kubernetes-cluster-name ${cluster.name}`}
      </Code>
    </Box>
  );
}

function InsideCluster({
  cluster,
  health,
  supervisorHost,
}: {
  cluster: FleetCluster;
  health?: WorkloadHealth;
  supervisorHost?: string;
}) {
  if (!health) return <Typography>Checking…</Typography>;
  if (health.status === 'no-context') return <LoginHint cluster={cluster} supervisorHost={supervisorHost} />;
  if (health.status !== 'ok' && health.status !== 'issues') {
    return (
      <Box>
        <WorkloadCell health={health} />
        {health.error && <Typography sx={{ mt: 1 }}>{health.error}</Typography>}
        {health.status === 'expired' && <LoginHint cluster={cluster} supervisorHost={supervisorHost} />}
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <NameValueTable
        rows={[
          { name: 'Status', value: <WorkloadCell health={health} /> },
          {
            name: 'Open',
            value: health.contextName ? (
              <Link to={headlampClusterPath(health.contextName)}>
                Open {health.contextName} in Headlamp (workloads, logs, shell, events, YAML)
              </Link>
            ) : (
              '—'
            ),
          },
          { name: 'API server version', value: health.serverVersion ?? '—' },
          { name: 'Nodes ready', value: health.nodes ? `${health.nodes.ready} / ${health.nodes.total}` : '—' },
          {
            name: 'Pods',
            value:
              health.podCount === undefined
                ? '—'
                : `${health.podCount}${health.podsTruncated ? '+' : ''} total, ${health.podIssueCount} with problems`,
          },
          { name: 'Warnings in the last hour', value: String(health.recentWarningCount) },
        ]}
      />
      {health.partial.length > 0 && (
        <Typography variant="body2">Couldn't read: {health.partial.join('; ')}</Typography>
      )}
      {health.podIssues.length > 0 && (
        <>
          <Typography variant="h6">Pods with problems</Typography>
          <SimpleTable
            columns={[
              { label: 'Namespace', getter: (p: PodIssue) => p.namespace },
              { label: 'Pod', getter: (p: PodIssue) => p.name },
              { label: 'Reason', getter: (p: PodIssue) => <StatusLabel status="warning">{p.reason}</StatusLabel> },
            ]}
            data={health.podIssues}
          />
        </>
      )}
      {health.deploymentIssues.length > 0 && (
        <>
          <Typography variant="h6">Deployments not fully available</Typography>
          <SimpleTable
            columns={[
              { label: 'Namespace', getter: (d: DeploymentIssue) => d.namespace },
              { label: 'Deployment', getter: (d: DeploymentIssue) => d.name },
              { label: 'Available', getter: (d: DeploymentIssue) => `${d.available} / ${d.desired}` },
            ]}
            data={health.deploymentIssues}
          />
        </>
      )}
      {health.recentWarnings.length > 0 && (
        <>
          <Typography variant="h6">Recent warnings</Typography>
          <EventsTable events={health.recentWarnings} showNamespace />
        </>
      )}
    </Box>
  );
}

function EventsTable({ events, showNamespace = false }: { events: EventInfo[]; showNamespace?: boolean }) {
  return (
    <SimpleTable
      columns={[
        {
          label: 'Type',
          getter: (e: EventInfo) => (
            <StatusLabel status={e.type === 'Warning' ? 'warning' : ''}>{e.type ?? '—'}</StatusLabel>
          ),
        },
        ...(showNamespace ? [{ label: 'Namespace', getter: (e: EventInfo) => e.namespace ?? '—' }] : []),
        { label: 'Object', getter: (e: EventInfo) => e.object || '—' },
        { label: 'Reason', getter: (e: EventInfo) => e.reason ?? '—' },
        { label: 'Message', getter: (e: EventInfo) => e.message ?? '—' },
        { label: 'Count', getter: (e: EventInfo) => e.count ?? 1 },
        { label: 'Last seen', getter: (e: EventInfo) => when(e.lastSeen) },
      ]}
      data={events}
    />
  );
}

export function ClusterDetail() {
  const params = useParams<{ supervisor: string; namespace: string; name: string }>();
  const config = usePluginConfig();
  const supervisor = config.supervisors.find(s => s.id === params.supervisor);

  // Only read the Supervisor this cluster lives on.
  const scoped = React.useMemo(() => (supervisor ? [supervisor] : []), [supervisor]);
  const { results } = useFleet(scoped, config.refreshSeconds);
  const key = clusterKey(params.supervisor, params.namespace, params.name);
  const cluster = results?.flatMap(r => r.clusters).find(c => c.key === key);

  const single = React.useMemo(() => (cluster ? [cluster] : []), [cluster]);
  const workload = useWorkloadHealth(single, config.refreshSeconds);
  const extras = useClusterExtras(supervisor, params.namespace, params.name, config.refreshSeconds);

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

  const health = workload.byKey.get(cluster.key);
  const supervisorHost = serverHost(workload.contexts.find(c => c.name === supervisor.headlampCluster)?.server);
  const addons: AddonInfo[] =
    extras?.addons.length
      ? extras.addons
      : cluster.cni
      ? [{ role: 'Networking (CNI)', name: cluster.cni }]
      : [];

  return (
    <>
      <SectionBox title={cluster.name}>
        {back}
        <SupervisorBanners results={results} />
        <NameValueTable
          rows={[
            { name: 'Status', value: <HealthLabel cluster={cluster} /> },
            ...(cluster.issues.length
              ? [
                  {
                    name: 'Issues',
                    value: (
                      <Box component="ul" sx={{ m: 0, pl: 2 }}>
                        {cluster.issues.map(i => (
                          <li key={i}>{i}</li>
                        ))}
                      </Box>
                    ),
                  },
                ]
              : []),
            {
              name: 'Tenant',
              value: cluster.tenantNamed ? `${cluster.tenantName} (${cluster.tenantId})` : cluster.tenantId,
            },
            { name: 'Supervisor', value: supervisorLabel(supervisor) },
            { name: 'Namespace', value: cluster.namespace },
            { name: 'Phase', value: cluster.phase },
            { name: 'Kubernetes (desired)', value: cluster.kubernetesVersion ?? '—' },
            { name: 'Kubernetes (control plane)', value: cluster.controlPlaneVersion ?? '—' },
            {
              name: 'Upgrade',
              value: cluster.upgrading
                ? 'In progress'
                : cluster.availableUpgrade
                ? `${cluster.availableUpgrade.version} available (${cluster.availableUpgrade.kind} upgrade)`
                : 'No newer release found',
            },
            { name: 'Class', value: cluster.clusterClass ?? '—' },
            { name: 'Operating system', value: cluster.osImage ?? '—' },
            { name: 'VM class', value: cluster.vmClass ?? '—' },
            { name: 'Storage class', value: cluster.storageClass ?? '—' },
            {
              name: 'API endpoint',
              value: cluster.endpoint ? `https://${cluster.endpoint.host}:${cluster.endpoint.port}` : '—',
            },
            { name: 'Pod network', value: cluster.network?.pods.join(', ') || '—' },
            { name: 'Service network', value: cluster.network?.services.join(', ') || '—' },
            { name: 'Control plane ready', value: replicas(cluster.controlPlane) },
            { name: 'Workers ready', value: replicas(cluster.workers) },
            { name: 'Created', value: when(cluster.createdAt) },
          ]}
        />
      </SectionBox>

      <SectionBox title="Inside the cluster">
        <InsideCluster cluster={cluster} health={health} supervisorHost={supervisorHost} />
      </SectionBox>

      <SectionBox title="Node pools">
        {cluster.nodePools.length === 0 ? (
          <Typography>No node pools reported.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Pool', getter: (p: NodePool) => p.name },
              { label: 'Ready', getter: (p: NodePool) => poolSize(p) },
              { label: 'VM class', getter: (p: NodePool) => p.vmClass ?? '—' },
              { label: 'Storage class', getter: (p: NodePool) => p.storageClass ?? '—' },
              { label: 'Zone', getter: (p: NodePool) => p.failureDomain ?? '—' },
              { label: 'Autoscaling', getter: (p: NodePool) => autoscaling(p) },
            ]}
            data={cluster.nodePools}
          />
        )}
      </SectionBox>

      <SectionBox title="Machines">
        {cluster.machines.length === 0 ? (
          <Typography>No machines reported.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Node', getter: (m: MachineInfo) => m.nodeName ?? m.name },
              {
                label: 'Role',
                getter: (m: MachineInfo) => (m.role === 'control-plane' ? 'Control plane' : m.pool ?? 'Worker'),
              },
              {
                label: 'Phase',
                getter: (m: MachineInfo) => (
                  <Box>
                    <StatusLabel status={phaseStatus(m)}>{m.phase}</StatusLabel>
                    {m.deletingSince && (
                      <Typography variant="body2" sx={{ mt: 0.5 }}>
                        Deleting for {ageOf(m.deletingSince)}
                      </Typography>
                    )}
                  </Box>
                ),
              },
              { label: 'Version', getter: (m: MachineInfo) => m.version ?? '—' },
              { label: 'IP', getter: (m: MachineInfo) => m.internalIP ?? '—' },
              { label: 'Zone', getter: (m: MachineInfo) => m.failureDomain ?? '—' },
              { label: 'OS', getter: (m: MachineInfo) => m.osImage ?? '—' },
              { label: 'Age', getter: (m: MachineInfo) => ageOf(m.createdAt) },
            ]}
            data={cluster.machines}
          />
        )}
      </SectionBox>

      <SectionBox title="Add-ons">
        {addons.length === 0 ? (
          <Typography>{extras ? 'No add-ons reported.' : 'Loading…'}</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Role', getter: (a: AddonInfo) => a.role },
              { label: 'Package', getter: (a: AddonInfo) => a.name },
            ]}
            data={addons}
          />
        )}
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
              { label: 'Last change', getter: (c: ClusterCondition) => when(c.lastTransitionTime) },
            ]}
            data={cluster.conditions}
          />
        )}
      </SectionBox>

      <SectionBox title="Supervisor events">
        {extras?.warnings.length ? (
          <Typography variant="body2" sx={{ mb: 1 }}>
            {extras.warnings.join(' ')}
          </Typography>
        ) : null}
        {!extras ? (
          <Typography>Loading…</Typography>
        ) : extras.events.length === 0 ? (
          <Typography>No recent events for this cluster or its machines.</Typography>
        ) : (
          <EventsTable events={extras.events} />
        )}
      </SectionBox>

      {extras?.raw !== undefined && (
        <SectionBox title="Cluster object">
          <details>
            <summary>Show the Cluster object as JSON</summary>
            <Box
              component="pre"
              sx={{ mt: 1, p: 1.5, maxHeight: 480, overflow: 'auto', fontSize: '0.8rem', bgcolor: 'action.hover' }}
            >
              {JSON.stringify(extras.raw, null, 2)}
            </Box>
          </details>
        </SectionBox>
      )}
    </>
  );
}
