import {
  Loader,
  NameValueTable,
  SectionBox,
  SimpleTable,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Typography } from '@mui/material';
import { useFleetData } from '../fleetContext';
import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { replacePlan } from '../actions';
import { headlampClient, supervisorClient, supervisorWriter } from '../api/headlampClient';
import { formatDuration } from '../capi/v1beta1';
import { serverHost } from '../contexts';
import { deletionStage, fetchMachineDetail, fetchNodeView, machineStatusNotes, NodePod } from '../machine';
import { formatBytes } from '../quantity';
import { clusterPath, headlampNodePath, headlampPodPath } from '../routes';
import { ClusterCondition, clusterKey, EventInfo } from '../types';
import { usePolling } from '../usePolling';
import { useWorkloadHealth } from '../useWorkload';
import { ActionDialog, TimeoutDialog } from './ActionDialog';
import { LoginHint, SupervisorBanners } from './common';

type LabelStatus = 'success' | 'warning' | 'error' | '';

function when(ts?: string): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function since(ts?: string): string {
  return ts ? `${formatDuration(Date.now() - new Date(ts).getTime())} ago` : '—';
}

function condStatus(c: ClusterCondition, positive = true): LabelStatus {
  const good = positive ? c.status === 'True' : c.status === 'False';
  if (good) return 'success';
  if (c.status === 'Unknown') return '';
  return c.severity === 'Error' ? 'error' : 'warning';
}

/** Conditions where True is bad (pressure, "Deleting", "Paused"). */
const NEGATIVE = new Set(['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable', 'Deleting', 'Paused']);

function ConditionsTable({ conditions }: { conditions: ClusterCondition[] }) {
  return (
    <SimpleTable
      columns={[
        { label: 'Condition', getter: (c: ClusterCondition) => c.type },
        {
          label: 'Status',
          getter: (c: ClusterCondition) => (
            <StatusLabel status={condStatus(c, !NEGATIVE.has(c.type))}>{c.status}</StatusLabel>
          ),
        },
        { label: 'Reason', getter: (c: ClusterCondition) => c.reason ?? '—' },
        { label: 'Message', getter: (c: ClusterCondition) => c.message ?? '—' },
        { label: 'Last change', getter: (c: ClusterCondition) => when(c.lastTransitionTime) },
      ]}
      data={conditions}
    />
  );
}

export function MachineDetail() {
  const params = useParams<{ supervisor: string; namespace: string; name: string; machine: string }>();
  const { config, all, refresh: refreshAll, canWrite: canWriteFor } = useFleetData();
  const supervisor = config.supervisors.find(s => s.id === params.supervisor);
  const results = all;
  const refresh = refreshAll;
  const cluster = results?.flatMap(r => r.clusters).find(c => c.key === clusterKey(params.supervisor, params.namespace, params.name));
  const machine = cluster?.machines.find(m => m.name === params.machine);

  const single = React.useMemo(() => (cluster ? [cluster] : []), [cluster]);
  const workload = useWorkloadHealth(single, config.refreshSeconds);
  const contextName = cluster ? workload.byKey.get(cluster.key)?.contextName : undefined;

  const target = supervisor?.headlampCluster;
  const detail = usePolling(
    target ? `${target}/${params.namespace}/${params.machine}` : null,
    () => fetchMachineDetail(supervisorClient(supervisor!), params.namespace, params.machine),
    config.refreshSeconds
  );
  const nodeName = machine?.nodeName;
  const drainStarted = detail?.drainStarted;
  const nodeView = usePolling(
    contextName && nodeName ? `${contextName}/${nodeName}/${drainStarted ?? ''}` : null,
    () => fetchNodeView(headlampClient(contextName as string), nodeName as string, drainStarted),
    config.refreshSeconds
  );

  const writeOk = supervisor ? canWriteFor(supervisor.id) : false;
  const writer = React.useMemo(() => (supervisor && writeOk ? supervisorWriter(supervisor) : null), [target, writeOk]);
  const [action, setAction] = React.useState<'replace' | 'unblock' | 'timeouts' | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const back = cluster ? (
    <Box sx={{ mb: 2 }}>
      <Link to={clusterPath(cluster)}>Back to {cluster.name}</Link>
    </Box>
  ) : null;

  if (!supervisor) {
    return (
      <SectionBox title={params.machine}>
        <Typography>Supervisor "{params.supervisor}" isn't configured in the plugin settings.</Typography>
      </SectionBox>
    );
  }
  if (results === null) return <Loader title={`Loading ${params.machine}`} />;
  if (!cluster || !machine) {
    return (
      <SectionBox title={params.machine}>
        {back}
        <SupervisorBanners results={results} />
        <Typography>
          Machine {params.machine} wasn't found in cluster {params.name}. It may have been deleted, or replaced by a
          new machine.
        </Typography>
      </SectionBox>
    );
  }

  const notes = detail ? machineStatusNotes(detail) : [];
  const pool = cluster.nodePools.find(p => p.name === machine.pool);
  const supervisorHost = serverHost(workload.contexts.find(c => c.name === supervisor.headlampCluster)?.server);
  const applied = (message: string) => {
    setNotice(message);
    refresh();
  };

  const stage = detail ? deletionStage(detail) : undefined;
  const buttons = !writeOk ? [] : [
    machine.deletingSince ? (
      pool ? (
        <Button key="unblock" size="small" color="warning" variant="outlined" onClick={() => setAction('unblock')}>
          Unblock deletion
        </Button>
      ) : null
    ) : (
      <Button key="replace" size="small" variant="outlined" onClick={() => setAction('replace')}>
        Replace
      </Button>
    ),
    ...(pool && !machine.deletingSince
      ? [
          <Button key="timeouts" size="small" variant="outlined" onClick={() => setAction('timeouts')}>
            Pool timeouts
          </Button>,
        ]
      : []),
  ].filter(Boolean);

  const blockers = nodeView?.pods.filter(p => p.blockingPdb) ?? [];
  const pinned = nodeView?.pods.filter(p => p.pinned) ?? [];

  return (
    <>
      <SectionBox title={machine.nodeName ?? machine.name} headerProps={{ actions: buttons }}>
        {back}
        {notice && (
          <Alert severity="success" onClose={() => setNotice(null)} sx={{ mb: 2 }}>
            {notice}
          </Alert>
        )}
        {notes.length > 0 && (
          <Alert severity={machine.deletingSince || machine.phase === 'Failed' ? 'warning' : 'info'} sx={{ mb: 2 }}>
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {notes.map(n => (
                <li key={n}>{n}</li>
              ))}
            </Box>
          </Alert>
        )}
        {machine.deletingSince && pinned.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {pinned.length} pod{pinned.length === 1 ? ' keeps' : 's keep'} coming back to this node:{' '}
            {pinned.map(p => `${p.namespace}/${p.name} (${p.pinned})`).join('; ')}. Remove the pin from its owner (for
            example nodeName in a Deployment) or scale it down, or the drain and volume detach can't finish.
          </Alert>
        )}
        {machine.deletingSince && blockers.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {blockers.length} pod{blockers.length === 1 ? '' : 's'} on this node can't be evicted because a
            PodDisruptionBudget allows no disruptions: {blockers.map(b => `${b.namespace}/${b.name} (${b.blockingPdb})`).join(', ')}.
          </Alert>
        )}
        <NameValueTable
          rows={[
            { name: 'Cluster', value: <Link to={clusterPath(cluster)}>{cluster.name}</Link> },
            { name: 'Machine', value: machine.name },
            { name: 'Role', value: machine.role === 'control-plane' ? 'Control plane' : `Worker (pool ${machine.pool ?? '—'})` },
            { name: 'Phase', value: machine.phase },
            { name: 'Kubernetes', value: machine.version ?? '—' },
            { name: 'IP', value: machine.internalIP ?? '—' },
            { name: 'Zone', value: machine.failureDomain ?? '—' },
            { name: 'Operating system', value: machine.osImage ?? '—' },
            { name: 'Created', value: `${when(machine.createdAt)} (${since(machine.createdAt)})` },
            ...(machine.deletingSince
              ? [
                  { name: 'Deleting since', value: `${when(machine.deletingSince)} (${since(machine.deletingSince)})` },
                  { name: 'Drain started', value: detail?.drainStarted ? when(detail.drainStarted) : '—' },
                  ...(detail?.volumeWaitStarted
                    ? [{ name: 'Waiting for volumes since', value: when(detail.volumeWaitStarted) }]
                    : []),
                ]
              : []),
            ...(machine.certificatesExpiry
              ? [{ name: 'Certificates expire', value: when(machine.certificatesExpiry) }]
              : []),
            ...(pool ? [{ name: 'Pool drain timeout', value: pool.nodeDrainTimeout ?? 'None' }] : []),
          ]}
        />
      </SectionBox>

      <SectionBox title="Virtual machine">
        {!detail ? (
          <Typography>Loading…</Typography>
        ) : !detail.vm ? (
          <Typography>No VM found for this machine yet.</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <NameValueTable
              rows={[
                {
                  name: 'Power',
                  value: detail.vm.powerState ? (
                    <StatusLabel status={/^poweredon$/i.test(detail.vm.powerState) ? 'success' : 'error'}>
                      {detail.vm.powerState}
                    </StatusLabel>
                  ) : (
                    '—'
                  ),
                },
                {
                  name: 'Class',
                  value:
                    machine.vm?.cpus !== undefined && machine.vm.memoryBytes !== undefined
                      ? `${detail.vm.className ?? '—'} (${machine.vm.cpus} vCPU, ${formatBytes(machine.vm.memoryBytes)})`
                      : detail.vm.className ?? '—',
                },
                { name: 'Image', value: detail.vm.imageName ?? '—' },
                { name: 'IP', value: detail.vm.ip ?? '—' },
                { name: 'Zone', value: detail.vm.zone ?? '—' },
                ...(detail.vm.host ? [{ name: 'ESXi host', value: detail.vm.host }] : []),
                ...(detail.vm.uniqueId ? [{ name: 'vCenter ID', value: detail.vm.uniqueId }] : []),
              ]}
            />
            {detail.vm.conditions.length > 0 && <ConditionsTable conditions={detail.vm.conditions} />}
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Node and pods">
        {!contextName ? (
          <LoginHint cluster={cluster} supervisorHost={supervisorHost} />
        ) : !nodeName ? (
          <Typography>This machine hasn't joined the cluster as a node yet.</Typography>
        ) : !nodeView ? (
          <Typography>Loading…</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {nodeView.warnings.length > 0 && <Typography variant="body2">{nodeView.warnings.join(' ')}</Typography>}
            {nodeView.node && (
              <NameValueTable
                rows={[
                  {
                    name: 'Ready',
                    value: (
                      <StatusLabel status={nodeView.node.ready ? 'success' : 'error'}>
                        {nodeView.node.ready ? 'Ready' : 'Not ready'}
                      </StatusLabel>
                    ),
                  },
                  { name: 'Scheduling', value: nodeView.node.cordoned ? 'Cordoned (no new pods)' : 'Open' },
                  { name: 'Pressure', value: nodeView.node.pressure.join(', ') || 'None' },
                  { name: 'Taints', value: nodeView.node.taints.join(', ') || 'None' },
                  { name: 'Kubelet', value: nodeView.node.kubeletVersion ?? '—' },
                  {
                    name: 'CPU (allocatable of capacity)',
                    value: `${nodeView.node.allocatable.cpu ?? '—'} of ${nodeView.node.capacity.cpu ?? '—'}`,
                  },
                  {
                    name: 'Memory (allocatable of capacity)',
                    value: `${nodeView.node.allocatable.memory ?? '—'} of ${nodeView.node.capacity.memory ?? '—'}`,
                  },
                  {
                    name: 'Open',
                    value: (
                      <Link to={headlampNodePath(contextName, nodeName)}>
                        Open node {nodeName} in Headlamp (shell, events, YAML)
                      </Link>
                    ),
                  },
                ]}
              />
            )}
            <Typography variant="h6">
              Pods on this node ({nodeView.pods.length})
            </Typography>
            <SimpleTable
              columns={[
                { label: 'Namespace', getter: (p: NodePod) => p.namespace },
                {
                  label: 'Pod',
                  getter: (p: NodePod) => <Link to={headlampPodPath(contextName, p.namespace, p.name)}>{p.name}</Link>,
                },
                {
                  label: 'Status',
                  getter: (p: NodePod) => (
                    <StatusLabel status={p.phase === 'Running' && !p.reason ? 'success' : p.phase === 'Succeeded' ? '' : 'warning'}>
                      {p.reason ?? p.phase}
                    </StatusLabel>
                  ),
                },
                { label: 'Ready', getter: (p: NodePod) => p.ready },
                { label: 'Restarts', getter: (p: NodePod) => p.restarts },
                {
                  label: 'Drain',
                  getter: (p: NodePod) =>
                    p.pinned ? (
                      <StatusLabel status="error">Pinned to this node</StatusLabel>
                    ) : p.blockingPdb ? (
                      <StatusLabel status="error">{`Blocked by ${p.blockingPdb}`}</StatusLabel>
                    ) : p.daemonSet ? (
                      'Stays on node'
                    ) : p.protectedBy ? (
                      `Protected by ${p.protectedBy}`
                    ) : (
                      'Evictable'
                    ),
                },
                { label: 'Owner', getter: (p: NodePod) => p.owner ?? 'None' },
              ]}
              data={nodeView.pods}
            />
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Machine conditions">
        {!detail ? (
          <Typography>Loading…</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {detail.warnings.length > 0 && <Typography variant="body2">{detail.warnings.join(' ')}</Typography>}
            {detail.conditions.length > 0 ? (
              <ConditionsTable conditions={detail.conditions} />
            ) : (
              <Typography>No conditions reported.</Typography>
            )}
            {detail.detailedConditions.length > 0 && (
              <>
                <Typography variant="h6">Detailed conditions</Typography>
                <ConditionsTable conditions={detail.detailedConditions} />
              </>
            )}
          </Box>
        )}
      </SectionBox>

      <SectionBox title="Events">
        {!detail ? (
          <Typography>Loading…</Typography>
        ) : detail.events.length === 0 ? (
          <Typography>No recent events for this machine.</Typography>
        ) : (
          <SimpleTable
            columns={[
              {
                label: 'Type',
                getter: (e: EventInfo) => (
                  <StatusLabel status={e.type === 'Warning' ? 'warning' : ''}>{e.type ?? '—'}</StatusLabel>
                ),
              },
              { label: 'Object', getter: (e: EventInfo) => e.object || '—' },
              { label: 'Reason', getter: (e: EventInfo) => e.reason ?? '—' },
              { label: 'Message', getter: (e: EventInfo) => e.message ?? '—' },
              { label: 'Count', getter: (e: EventInfo) => e.count ?? 1 },
              { label: 'Last seen', getter: (e: EventInfo) => when(e.lastSeen) },
            ]}
            data={detail.events}
          />
        )}
      </SectionBox>

      {detail?.raw && (
        <SectionBox title="Machine object">
          <details>
            <summary>Show the Machine object as JSON</summary>
            <Box
              component="pre"
              sx={{ mt: 1, p: 1.5, maxHeight: 480, overflow: 'auto', fontSize: '0.8rem', bgcolor: 'action.hover' }}
            >
              {JSON.stringify(detail.raw, null, 2)}
            </Box>
          </details>
        </SectionBox>
      )}

      {writer && action === 'replace' && (
        <ActionDialog plan={replacePlan(cluster, machine)} writer={writer} onClose={() => setAction(null)} onApplied={applied} />
      )}
      {writer && (action === 'unblock' || action === 'timeouts') && pool && (
        <TimeoutDialog
          cluster={cluster}
          pool={pool}
          initialKind={action === 'unblock' ? stage ?? 'drain' : 'drain'}
          context={
            action === 'unblock'
              ? stage === 'volume'
                ? 'This machine is stuck waiting for volumes to detach. Force-remove the stuck pod first if you can; the timeout is the last resort.'
                : stage === 'drain'
                ? "This machine is stuck draining: pods on it can't be evicted."
                : 'This machine is stuck deleting.'
              : undefined
          }
          writer={writer}
          onClose={() => setAction(null)}
          onApplied={applied}
        />
      )}
    </>
  );
}

