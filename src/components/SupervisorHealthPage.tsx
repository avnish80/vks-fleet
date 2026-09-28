import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';
import { requestStats } from '../api/limiter';
import { supervisorWriter } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { BacklogRow, healthTone, LeaseInfo, leftoverCleanupPlan, responsiveness, ServiceState, SupervisorHealth } from '../supervisorHealth';
import { SupervisorResult } from '../types';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile } from './charts';

const ago = (s?: number) => (s === undefined ? '—' : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

export function SupervisorHealthPage() {
  const { all, inventoryAll, persona, canWrite, refresh } = useFleetData();
  const operator = !!persona && ['operator', 'readonly', 'unknown'].includes(persona.persona);
  const health = useSupervisorHealth(all, inventoryAll, operator);
  const [cleaning, setCleaning] = React.useState<{ h: SupervisorHealth; r: SupervisorResult } | null>(null);
  if (!operator) {
    return (
      <SectionBox title="Supervisor health">
        <Typography>Supervisor health needs Supervisor-wide read access (operators and read-only administrators).</Typography>
      </SectionBox>
    );
  }
  if (all === null || health === null) return <Loader title="Reading the Supervisor" />;
  return (
    <>
      <ChartStyles />
      {health.map(h => {
        const r = all.find(x => x.supervisor.id === h.supervisorId)!;
        return <One key={h.supervisorId} h={h} r={r} canClean={canWrite(h.supervisorId)} onClean={() => setCleaning({ h, r })} />;
      })}
      {cleaning && <ActionDialog plan={leftoverCleanupPlan(cleaning.h)} writer={supervisorWriter(cleaning.r.supervisor)} onClose={() => setCleaning(null)} onApplied={() => refresh()} />}
    </>
  );
}

function One({ h, r, canClean, onClean }: { h: SupervisorHealth; r: SupervisorResult; canClean: boolean; onClean: () => void }) {
  const cps = h.nodes.filter(n => n.role === 'control-plane');
  const hosts = h.nodes.filter(n => n.role === 'host');
  const leftovers = h.services.reduce((n, s) => n + s.leftovers.length, 0);
  const stuck = h.backlog.reduce((n, b) => n + b.notReady, 0);
  const resp = responsiveness(requestStats().clusters.find(c => c.cluster === r.supervisor.headlampCluster));
  return (
    <>
      <SectionBox title={`${h.name}: Supervisor health`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2 }}>
          <KpiTile label="Health" value={h.score} sub="out of 100" tone={healthTone(h.score)} meter={{ value: h.score, max: 100 }} />
          <KpiTile label="Control plane" value={`${cps.filter(n => n.ready).length}/${cps.length}`} sub={cps.length === 1 ? 'single node' : 'nodes Ready'} tone={cps.every(n => n.ready) ? 'success' : 'error'} />
          <KpiTile label="ESXi hosts" value={`${hosts.filter(n => n.ready).length}/${hosts.length}`} sub="Ready" tone={hosts.every(n => n.ready) ? 'success' : 'warning'} />
          <KpiTile label="Controllers" value={`${h.leases.filter(l => l.state === 'ok').length}/${h.leases.length}`} sub="leases renewing" tone={h.leases.every(l => l.state === 'ok') ? 'success' : 'error'} />
          <KpiTile label="Services" value={`${h.services.filter(s => s.state === 'ok').length}/${h.services.length}`} sub={leftovers ? `${leftovers} leftover pods` : 'healthy'} tone={h.services.some(s => s.state === 'down') ? 'error' : h.services.some(s => s.state !== 'ok') || leftovers ? 'warning' : 'success'} />
          <KpiTile label="Stuck objects" value={stuck} sub="not Ready (all kinds)" tone={stuck ? 'warning' : 'success'} />
          <KpiTile label="API response" value={resp.avgMs !== undefined ? `${resp.avgMs} ms` : '—'} sub={resp.errorRate !== undefined ? `${(resp.errorRate * 100).toFixed(1)}% errors (this tab)` : 'measured by the plugin'} tone={resp.errorRate && resp.errorRate > 0.05 ? 'warning' : 'primary'} />
        </Box>
        {h.errors.length > 0 && (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            Partly read: {h.errors.slice(0, 3).join('; ')}
          </Alert>
        )}
      </SectionBox>

      <SectionBox title="Controllers">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Each controller holds a leader-election lease and renews it every few seconds. A lease that stops renewing means the
          controller is stuck or gone, even if its pod shows Running.
          {h.leasesUnreadable.length ? ` Not readable with this account: ${h.leasesUnreadable.join(', ')}.` : ''}
        </Typography>
        {h.leases.length ? (
          <SimpleTable
            columns={[
              { label: 'State', getter: (l: LeaseInfo) => <StatusLabel status={l.state === 'ok' ? 'success' : 'error'}>{l.state === 'ok' ? 'Renewing' : l.state === 'stale' ? 'Stale' : 'No leader'}</StatusLabel> },
              { label: 'Controller', getter: (l: LeaseInfo) => <b>{l.controller}</b> },
              { label: 'Last renewed', getter: (l: LeaseInfo) => ago(l.renewedSecondsAgo) },
              { label: 'Leader on', getter: (l: LeaseInfo) => l.holderNode ?? '—' },
              { label: 'Lease', getter: (l: LeaseInfo) => `${l.namespace}/${l.name}` },
            ]}
            data={h.leases}
          />
        ) : (
          <Typography color="text.secondary">No controller leases readable.</Typography>
        )}
      </SectionBox>

      <SectionBox
        title="Supervisor services"
        headerProps={{
          actions:
            leftovers && canClean
              ? [
                  <Button key="c" size="small" variant="outlined" onClick={onClean}>
                    Clean up {leftovers} leftover pod{leftovers === 1 ? '' : 's'}…
                  </Button>,
                ]
              : [],
        }}
      >
        <SimpleTable
          columns={[
            { label: 'State', getter: (s: ServiceState) => <StatusLabel status={s.state === 'ok' ? 'success' : s.state === 'down' ? 'error' : 'warning'}>{s.state === 'ok' ? 'Running' : s.state === 'down' ? 'Down' : 'Degraded'}</StatusLabel> },
            { label: 'Service', getter: (s: ServiceState) => <b>{s.name}</b> },
            { label: 'Running on', getter: (s: ServiceState) => s.running.map(p => p.host ?? '?').join(', ') || '—' },
            { label: 'Restarts', getter: (s: ServiceState) => s.running.reduce((n, p) => n + p.restarts, 0) },
            {
              label: 'Left behind',
              getter: (s: ServiceState) =>
                s.leftovers.length ? (
                  <span title={s.leftovers.map(p => `${p.name}: ${p.reason ?? p.phase} on ${p.host ?? '?'}, ${Math.round(p.ageDays)} days`).join('\n')}>
                    {`${s.leftovers.length} (${s.leftovers.map(p => p.reason ?? p.phase).join(', ')})`}
                  </span>
                ) : (
                  '—'
                ),
            },
            { label: 'Failing', getter: (s: ServiceState) => s.failing.map(p => `${p.name} (${p.reason ?? p.phase}${p.host ? ` on ${p.host}` : ''})`).join('; ') || '—' },
            { label: 'Namespace', getter: (s: ServiceState) => s.namespace },
          ]}
          data={h.services}
        />
      </SectionBox>

      <SectionBox title="Placement on ESXi hosts">
        {h.placement.concentrated && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            Every Supervisor service pod runs on <b>{h.placement.concentrated}</b>, while {h.placement.readyHosts} hosts are Ready: if that
            host fails, all services stop together. Pods rescheduled after a host problem stay where they landed; restarting one
            service's pod at a time spreads them.
          </Alert>
        )}
        {hosts.map(n => {
          const pods = h.placement.byHost.find(x => x.host === n.name)?.pods ?? 0;
          const max = Math.max(1, ...h.placement.byHost.map(x => x.pods));
          return (
            <Box key={n.name} sx={{ display: 'grid', gridTemplateColumns: '220px 1fr 120px', gap: 1, alignItems: 'center', mb: 0.5 }}>
              <Typography variant="body2">{n.name}</Typography>
              <Box sx={{ height: 10, bgcolor: 'action.hover', borderRadius: 1, overflow: 'hidden' }}>
                <Box sx={{ width: `${(pods / max) * 100}%`, height: '100%', bgcolor: n.ready ? 'primary.main' : 'error.main' }} />
              </Box>
              <Typography variant="body2" color={n.ready ? 'text.secondary' : 'error'}>
                {n.ready ? `${pods} service pod${pods === 1 ? '' : 's'}` : 'Not Ready'}
              </Typography>
            </Box>
          );
        })}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Control plane: {cps.map(n => `${n.name} (${n.ready ? 'Ready' : 'NOT Ready'}${n.version ? `, ${n.version}` : ''})`).join(', ') || '—'}
        </Typography>
      </SectionBox>

      <SectionBox title="Reconcile backlog">
        <SimpleTable
          columns={[
            { label: 'Kind', getter: (b: BacklogRow) => b.kind },
            { label: 'Not Ready', getter: (b: BacklogRow) => <StatusLabel status={b.notReady ? 'warning' : 'success'}>{`${b.notReady} of ${b.total}`}</StatusLabel> },
            { label: 'Stuck longest', getter: (b: BacklogRow) => (b.oldest ? `${b.oldest.name} (${b.oldest.hours < 48 ? `${Math.round(b.oldest.hours)} h` : `${Math.round(b.oldest.hours / 24)} days`})` : '—') },
          ]}
          data={h.backlog}
        />
      </SectionBox>

      {h.events.length > 0 && (
        <SectionBox title="Warning events by reason (last hours)">
          <SimpleTable
            columns={[
              { label: 'Reason', getter: (e: SupervisorHealth['events'][number]) => <b>{e.reason}</b> },
              { label: 'Count', getter: (e: SupervisorHealth['events'][number]) => e.count },
              { label: 'Example', getter: (e: SupervisorHealth['events'][number]) => e.example ?? '—' },
            ]}
            data={h.events.slice(0, 12)}
          />
        </SectionBox>
      )}

      <SectionBox title="Not visible from here">
        <Typography variant="body2" color="text.secondary">
          The Supervisor's own health checks (/readyz) and metrics (/metrics) aren't exposed through its endpoint, and even an SSO
          administrator can't read cluster-wide leases or admission webhooks. The Supervisor's own status, alarms and host
          health live in vCenter; a small read-only collector for those is planned.
        </Typography>
      </SectionBox>
    </>
  );
}
