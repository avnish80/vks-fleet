import { Loader, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { formatDuration } from '../capi/v1beta1';
import { clusterPath } from '../routes';
import { usePluginConfig } from '../settings/store';
import { CleanupItem, FleetCluster } from '../types';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';
import { Runbook } from './IssuesList';

export function CleanupPage() {
  const config = usePluginConfig();
  const { results } = useFleet(config.supervisors, config.refreshSeconds);
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  if (results === null) return <Loader title="Looking for leftovers" />;
  const now = new Date();
  const items: CleanupItem[] = results.flatMap(r => r.cleanup ?? []);
  const idle = clusters.filter(
    c => workload.byKey.get(c.key)?.userPods === 0 && c.createdAt && now.getTime() - new Date(c.createdAt).getTime() > 7 * 86400000
  );
  const notSignedIn = clusters.filter(c => !workload.byKey.get(c.key)?.contextName).length;

  return (
    <>
      <SectionBox title="Cleanup">
        <Alert severity="info" sx={{ mb: 2 }}>
          Leftovers on the Supervisor: VMs, load balancer services and volume claims that name a cluster that no longer
          exists, volume claims that are lost or stuck, and clusters stuck deleting. Only objects that say which cluster
          they belong to are judged, so VM Service VMs are never listed. The plugin deletes nothing: review each item, then
          run its command yourself.
        </Alert>
        {items.length === 0 ? (
          <Typography color="text.secondary">Nothing left over.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Kind', getter: (i: CleanupItem) => i.kind },
              { label: 'Name', getter: (i: CleanupItem) => i.name },
              { label: 'Namespace', getter: (i: CleanupItem) => i.namespace },
              { label: 'Why', getter: (i: CleanupItem) => i.reason },
              { label: 'Age', getter: (i: CleanupItem) => (i.since ? formatDuration(now.getTime() - new Date(i.since).getTime()) : '—') },
            ]}
            data={items}
          />
        )}
      </SectionBox>

      {items.length > 0 && (
        <SectionBox title="Commands">
          <Runbook
            steps={items.map(i => ({
              title: `${i.kind} ${i.namespace}/${i.name}`,
              commands: [i.inspect, ...(i.remove ? [i.remove] : [])],
              note: i.reason,
            }))}
          />
        </SectionBox>
      )}

      <SectionBox title="Idle clusters">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Clusters older than a week with nothing running outside platform namespaces. They still hold VMs and quota.
          {notSignedIn ? ` ${notSignedIn} cluster${notSignedIn === 1 ? " isn't" : "s aren't"} signed in, so ${notSignedIn === 1 ? "it's" : "they're"} not checked.` : ''}
        </Typography>
        {idle.length === 0 ? (
          <Typography color="text.secondary">None found.</Typography>
        ) : (
          <SimpleTable
            columns={[
              { label: 'Cluster', getter: (c: FleetCluster) => <Link to={clusterPath(c)}>{c.name}</Link> },
              { label: 'Tenant', getter: (c: FleetCluster) => c.tenantName },
              { label: 'Nodes', getter: (c: FleetCluster) => c.machines.filter(m => !m.deletingSince).length },
              { label: 'Created', getter: (c: FleetCluster) => (c.createdAt ? `${formatDuration(now.getTime() - new Date(c.createdAt).getTime())} ago` : '—') },
            ]}
            data={idle}
          />
        )}
      </SectionBox>
    </>
  );
}
