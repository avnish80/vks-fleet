import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, FormControlLabel, Switch, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { formatDuration } from '../capi/v1beta1';
import { clusterPath, machinePath } from '../routes';
import { usePluginConfig } from '../settings/store';
import { FleetCluster, MachineInfo } from '../types';
import { useFleet } from '../useFleet';

type Row = MachineInfo & { cluster: FleetCluster; problem?: string };

/** Why a machine needs a look, or undefined. */
export function machineProblem(m: MachineInfo, now: Date): string | undefined {
  if (m.deletingSince) return `Deleting for ${formatDuration(now.getTime() - new Date(m.deletingSince).getTime())}`;
  if (m.vm?.powerState && !/^poweredon$/i.test(m.vm.powerState)) return `VM ${m.vm.powerState}`;
  if (m.phase === 'Failed') return 'Failed';
  if (m.phase !== 'Running') return m.phase;
  if (m.ready === false) return 'Not ready';
  return undefined;
}

export function MachinesPage() {
  const config = usePluginConfig();
  const { results } = useFleet(config.supervisors, config.refreshSeconds);
  const now = new Date();
  const rows: Row[] = (results ?? []).flatMap(r =>
    r.clusters.flatMap(c => c.machines.map(m => ({ ...m, cluster: c, problem: machineProblem(m, now) })))
  );
  const problems = rows.filter(r => r.problem);
  const [onlyProblems, setOnlyProblems] = React.useState<boolean | null>(null);
  const only = onlyProblems ?? problems.length > 0;
  if (results === null) return <Loader title="Loading machines" />;
  const shown = (only ? problems : rows).sort(
    (a, b) => Number(!!b.problem) - Number(!!a.problem) || a.cluster.name.localeCompare(b.cluster.name) || a.name.localeCompare(b.name)
  );
  return (
    <SectionBox title="Machines">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
        <Typography>
          {rows.length} machine{rows.length === 1 ? '' : 's'} across the fleet; {problems.length} need
          {problems.length === 1 ? 's' : ''} a look.
        </Typography>
        <FormControlLabel
          control={<Switch checked={only} onChange={e => setOnlyProblems(e.target.checked)} />}
          label="Only machines that need a look"
        />
      </Box>
      {shown.length === 0 ? (
        <Typography color="text.secondary">Every machine is running, ready and powered on.</Typography>
      ) : (
        <SimpleTable
          columns={[
            { label: 'Node', getter: (r: Row) => <Link to={machinePath(r.cluster, r.name)}>{r.nodeName ?? r.name}</Link> },
            { label: 'Cluster', getter: (r: Row) => <Link to={clusterPath(r.cluster)}>{r.cluster.name}</Link> },
            { label: 'Role', getter: (r: Row) => (r.role === 'control-plane' ? 'Control plane' : r.pool ?? 'Worker') },
            {
              label: 'State',
              getter: (r: Row) =>
                r.problem ? <StatusLabel status="warning">{r.problem}</StatusLabel> : <StatusLabel status="success">Running</StatusLabel>,
            },
            { label: 'VM', getter: (r: Row) => [r.vm?.powerState, r.vm?.className].filter(Boolean).join(', ') || '—' },
            { label: 'IP', getter: (r: Row) => r.internalIP ?? '—' },
            { label: 'Zone', getter: (r: Row) => r.failureDomain ?? '—' },
            { label: 'Version', getter: (r: Row) => r.version ?? '—' },
            { label: 'Age', getter: (r: Row) => (r.createdAt ? formatDuration(now.getTime() - new Date(r.createdAt).getTime()) : '—') },
          ]}
          data={shown}
        />
      )}
    </SectionBox>
  );
}
