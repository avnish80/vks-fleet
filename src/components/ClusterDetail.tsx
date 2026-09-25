import {
  Loader,
  NameValueTable,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { pausePlan, replacePlan, upgradeProgress } from '../actions';
import { headlampWriter } from '../api/headlampClient';
import { formatDuration } from '../capi/v1beta1';
import { serverHost } from '../contexts';
import { AddonInfo } from '../extras';
import { scorecard } from '../checks';
import { buildIssues } from '../issues';
import { formatBytes } from '../quantity';
import { FLEET_PATH, headlampClusterObjectPath, headlampClusterPath, headlampPodsPath, machinePath } from '../routes';
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
  QuotaItem,
  SandboxFailure,
  supervisorLabel,
  WorkloadHealth,
} from '../types';
import { useClusterExtras } from '../useClusterExtras';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog, ScaleDialog, TimeoutDialog, UpgradeDialog } from './ActionDialog';
import { BarList, ChartStyles } from './charts';
import { ChecksPanel } from './ChecksPanel';
import { IssuesList } from './IssuesList';
import {
  capacityText,
  HealthLabel,
  LoginHint,
  replicas,
  SupervisorBanners,
  WorkloadCell,
} from './common';

type OpenAction =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'upgrade' }
  | { kind: 'scale'; pool: NodePool }
  | { kind: 'timeouts'; pool: NodePool; context?: string }
  | { kind: 'replace'; machine: MachineInfo };

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

function certText(c: FleetCluster): string {
  if (!c.certificatesExpiry) return '—';
  const days = Math.floor((new Date(c.certificatesExpiry).getTime() - Date.now()) / 86400000);
  const rotation = c.certificateRotation
    ? c.certificateRotation.enabled
      ? `automatic rotation on${
          c.certificateRotation.renewalDaysBeforeExpiry
            ? `, ${c.certificateRotation.renewalDaysBeforeExpiry} days before expiry`
            : ''
        }`
      : 'automatic rotation off'
    : 'rotation setting unknown';
  return `${new Date(c.certificatesExpiry).toLocaleDateString()} (in ${days} days; ${rotation})`;
}

function repairText(c: FleetCluster): string {
  if (!c.healthCheck) return 'No health checks found';
  const hc = c.healthCheck;
  return `${hc.healthy} of ${hc.expected} nodes healthy; ${hc.remediationAllowed ? 'repair active' : 'repair stopped'}`;
}

function vmText(m: MachineInfo): string {
  if (!m.vm) return '—';
  const size =
    m.vm.cpus !== undefined && m.vm.memoryBytes !== undefined
      ? ` (${m.vm.cpus} vCPU, ${formatBytes(m.vm.memoryBytes)})`
      : '';
  return `${m.vm.className ?? '—'}${size}`;
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
      {health.sandboxFailures.length > 0 && (
        <>
          <Typography variant="h6">Pod network setup failures in the last hour</Typography>
          <SimpleTable
            columns={[
              { label: 'Node', getter: (f: SandboxFailure) => f.node },
              { label: 'Pods', getter: (f: SandboxFailure) => f.pods },
              { label: 'Attempts', getter: (f: SandboxFailure) => f.attempts },
              { label: 'Latest error', getter: (f: SandboxFailure) => f.error },
            ]}
            data={health.sandboxFailures}
          />
        </>
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
  const { results, refresh } = useFleet(scoped, config.refreshSeconds);
  const writer = React.useMemo(
    () => (supervisor ? headlampWriter(supervisor.headlampCluster) : null),
    [supervisor?.headlampCluster]
  );
  const [action, setAction] = React.useState<OpenAction | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
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
  const fleetZones = new Set(
    results.flatMap(r => r.clusters.flatMap(c => c.machines.map(m => m.failureDomain))).filter(Boolean)
  ).size;
  const clusterIssues = buildIssues(results, workload.byKey).filter(
    i => i.clusterKey === cluster.key || (!i.clusterKey && i.namespace === cluster.namespace && i.supervisorId === cluster.supervisorId)
  );
  const card = scorecard(cluster, health, fleetZones);
  const clusterMap = new Map([[cluster.key, cluster]]);
  const supervisorNames = new Map([[supervisor.id, supervisorLabel(supervisor)]]);
  const vksNamespace = results.flatMap(r => r.services ?? []).find(s => s.namespace.startsWith('svc-tkg-'))?.namespace;
  const supervisorHost = serverHost(workload.contexts.find(c => c.name === supervisor.headlampCluster)?.server);
  const addons: AddonInfo[] =
    extras?.addons.length
      ? extras.addons
      : cluster.cni
      ? [{ role: 'Networking (CNI)', name: cluster.cni }]
      : [];

  const closeAction = () => setAction(null);
  const applied = (message: string) => {
    setNotice(message);
    refresh();
  };
  const available = results.find(r => r.supervisor.id === cluster.supervisorId)?.releases ?? [];
  const progress = upgradeProgress(cluster);
  const rolling =
    !!progress &&
    (cluster.upgrading ||
      progress.controlPlane.updated < progress.controlPlane.total ||
      progress.pools.some(p => p.updated < p.total));
  const actionButtons = [
    <Button key="upgrade" size="small" variant="contained" onClick={() => setAction({ kind: 'upgrade' })}>
      Upgrade
    </Button>,
    <Button
      key="pause"
      size="small"
      variant="outlined"
      onClick={() => setAction(cluster.paused ? { kind: 'resume' } : { kind: 'pause' })}
    >
      {cluster.paused ? 'Resume' : 'Pause'}
    </Button>,
  ];

  return (
    <>
      <SectionBox title={cluster.name} headerProps={{ actions: actionButtons }}>
        {back}
        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        <SupervisorBanners results={results} />
        {clusterIssues.length > 0 && (
          <Box sx={{ mb: 2 }}>
            <IssuesList issues={clusterIssues} clusters={clusterMap} supervisorNames={supervisorNames} showCluster={false} />
          </Box>
        )}
        <NameValueTable
          rows={[
            { name: 'Status', value: <HealthLabel cluster={cluster} /> },
            ...(cluster.paused ? [{ name: 'Paused', value: 'Yes: changes and repairs are not applied' }] : []),
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
                : available.length
                ? `No newer release found (${available.length} releases read from the Supervisor)`
                : "Couldn't read the Supervisor's releases",
            },
            {
              name: 'Class',
              value: cluster.classUpdate
                ? `${cluster.clusterClass} (newer: ${cluster.classUpdate})`
                : cluster.clusterClass ?? '—',
            },
            { name: 'Operating system', value: cluster.osImage ?? '—' },
            { name: 'VM class', value: cluster.vmClass ?? '—' },
            { name: 'Storage class', value: cluster.storageClass ?? '—' },
            {
              name: 'API endpoint',
              value: cluster.endpoint ? `https://${cluster.endpoint.host}:${cluster.endpoint.port}` : '—',
            },
            { name: 'Pod network', value: cluster.network?.pods.join(', ') || '—' },
            { name: 'Service network', value: cluster.network?.services.join(', ') || '—' },
            { name: 'Certificates expire', value: certText(cluster) },
            { name: 'Automatic node repair', value: repairText(cluster) },
            {
              name: 'Node capacity',
              value: cluster.capacity
                ? `${capacityText(cluster.capacity)} across ${cluster.capacity.nodesCounted} node${
                    cluster.capacity.nodesCounted === 1 ? '' : 's'
                  }`
                : '—',
            },
            { name: 'Control plane ready', value: replicas(cluster.controlPlane) },
            { name: 'Workers ready', value: replicas(cluster.workers) },
            { name: 'Created', value: when(cluster.createdAt) },
          ]}
        />
      </SectionBox>

      {rolling && progress && (
        <SectionBox title={`Upgrade to ${cluster.kubernetesVersion} in progress`}>
          <ChartStyles />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Nodes already running the new version. The control plane goes first, then each node pool one node at a
            time. This page refreshes on its own.
          </Typography>
          <BarList
            max={1}
            rows={[progress.controlPlane, ...progress.pools]
              .filter(p => p.total > 0)
              .map(p => ({
                key: p.name,
                label: p.name,
                parts: [{ label: 'Upgraded', value: p.total ? p.updated / p.total : 0, tone: p.updated === p.total ? 'success' : 'info' }],
                valueText: `${p.updated} of ${p.total}`,
              }))}
          />
        </SectionBox>
      )}

      <Box id="checks">
        <ChecksPanel card={card} />
      </Box>

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
              {
                label: 'Timeouts',
                getter: (p: NodePool) =>
                  p.nodeDrainTimeout || p.nodeVolumeDetachTimeout
                    ? [
                        p.nodeDrainTimeout ? `drain ${p.nodeDrainTimeout}` : '',
                        p.nodeVolumeDetachTimeout ? `volumes ${p.nodeVolumeDetachTimeout}` : '',
                      ]
                        .filter(Boolean)
                        .join(', ')
                    : 'None',
              },
              {
                label: 'Actions',
                getter: (p: NodePool) => (
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button size="small" onClick={() => setAction({ kind: 'scale', pool: p })}>
                      Scale
                    </Button>
                    <Button size="small" onClick={() => setAction({ kind: 'timeouts', pool: p })}>
                      Timeouts
                    </Button>
                  </Box>
                ),
              },
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
              {
                label: 'Node',
                getter: (m: MachineInfo) => <Link to={machinePath(cluster, m.name)}>{m.nodeName ?? m.name}</Link>,
              },
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
              {
                label: 'VM',
                getter: (m: MachineInfo) => (
                  <Box>
                    {m.vm?.powerState && (
                      <StatusLabel status={/^poweredon$/i.test(m.vm.powerState) ? 'success' : 'error'}>
                        {m.vm.powerState}
                      </StatusLabel>
                    )}
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {vmText(m)}
                    </Typography>
                  </Box>
                ),
              },
              { label: 'Version', getter: (m: MachineInfo) => m.version ?? '—' },
              { label: 'IP', getter: (m: MachineInfo) => m.internalIP ?? '—' },
              { label: 'Zone', getter: (m: MachineInfo) => m.failureDomain ?? m.vm?.zone ?? '—' },
              { label: 'Age', getter: (m: MachineInfo) => ageOf(m.createdAt) },
              {
                label: 'Actions',
                getter: (m: MachineInfo) =>
                  m.deletingSince ? (
                    (() => {
                      const pool = cluster.nodePools.find(p => p.name === m.pool);
                      return pool ? (
                        <Button
                          size="small"
                          color="warning"
                          onClick={() =>
                            setAction({
                              kind: 'timeouts',
                              pool,
                              context: `${m.nodeName ?? m.name} is stuck deleting. Its machine page shows which stage it's stuck in.`,
                            })
                          }
                        >
                          Unblock deletion
                        </Button>
                      ) : (
                        '—'
                      );
                    })()
                  ) : (
                    <Button size="small" onClick={() => setAction({ kind: 'replace', machine: m })}>
                      Replace
                    </Button>
                  ),
              },
            ]}
            data={cluster.machines}
          />
        )}
      </SectionBox>

      <SectionBox title="Namespace quota">
        {!cluster.quota || cluster.quota.length === 0 ? (
          <Typography>No quota is set on namespace {cluster.namespace}, or it isn't readable.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Resource', getter: (q: QuotaItem) => q.resource },
              { label: 'Used', getter: (q: QuotaItem) => q.used },
              { label: 'Limit', getter: (q: QuotaItem) => q.hard },
              {
                label: 'Usage',
                getter: (q: QuotaItem) =>
                  q.ratio === undefined ? (
                    '—'
                  ) : (
                    <StatusLabel status={q.ratio >= 0.95 ? 'error' : q.ratio >= 0.8 ? 'warning' : 'success'}>
                      {`${Math.round(q.ratio * 100)}%`}
                    </StatusLabel>
                  ),
              },
            ]}
            data={cluster.quota}
          />
        )}
      </SectionBox>

      <SectionBox title="Troubleshoot">
        <Box component="ul" sx={{ m: 0, pl: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <li>
            <Link to={headlampClusterObjectPath(supervisor.headlampCluster, cluster.namespace, cluster.name)}>
              Open the Cluster object in Headlamp
            </Link>{' '}
            to view or edit its YAML on the Supervisor.
          </li>
          <li>
            <Link to={headlampPodsPath(supervisor.headlampCluster, cluster.namespace)}>
              Open pods in namespace {cluster.namespace}
            </Link>{' '}
            on the Supervisor.
          </li>
          {vksNamespace && (
            <li>
              <Link to={headlampPodsPath(supervisor.headlampCluster, vksNamespace)}>
                Open the VKS controller pods
              </Link>{' '}
              ({vksNamespace}) and check their logs for this cluster's name.
            </li>
          )}
        </Box>
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

      {writer && action?.kind === 'upgrade' && (
        <UpgradeDialog
          cluster={cluster}
          available={available}
          contextName={health?.contextName}
          writer={writer}
          onClose={closeAction}
          onApplied={applied}
        />
      )}
      {writer && action?.kind === 'pause' && (
        <ActionDialog plan={pausePlan(cluster, true)} writer={writer} onClose={closeAction} onApplied={applied} />
      )}
      {writer && action?.kind === 'resume' && (
        <ActionDialog plan={pausePlan(cluster, false)} writer={writer} onClose={closeAction} onApplied={applied} />
      )}
      {writer && action?.kind === 'scale' && (
        <ScaleDialog cluster={cluster} pool={action.pool} writer={writer} onClose={closeAction} onApplied={applied} />
      )}
      {writer && action?.kind === 'timeouts' && (
        <TimeoutDialog
          cluster={cluster}
          pool={action.pool}
          context={action.context}
          writer={writer}
          onClose={closeAction}
          onApplied={applied}
        />
      )}
      {writer && action?.kind === 'replace' && (
        <ActionDialog
          plan={replacePlan(cluster, action.machine)}
          writer={writer}
          onClose={closeAction}
          onApplied={applied}
        />
      )}

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
