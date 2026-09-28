import { Loader, SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';
import { requestStats } from '../api/limiter';
import { supervisorWriter } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { BacklogRow, healthTone, LeaseInfo, leftoverCleanupPlan, responsiveness, ServiceState, SupervisorHealth } from '../supervisorHealth';
import { SupervisorResult } from '../types';
import { useSupervisorHealth } from '../useSupervisorHealth';
import { useVcenterStatus } from '../useVcenterStatus';
import { matchSupervisor, STALE_MINUTES, vcenterPenalty, VcenterRead, vcHostOk, VcSupervisor, vcServiceOk } from '../vcenterStatus';
import { ActionDialog } from './ActionDialog';
import { ChartStyles, KpiTile } from './charts';

const ago = (s?: number) => (s === undefined ? '—' : s < 5 ? 'just now' : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);

export function SupervisorHealthPage() {
  const { all, inventoryAll, persona, canWrite, refresh, config } = useFleetData();
  const vcenter = useVcenterStatus(config);
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
        const vc = vcenter?.status ? matchSupervisor(vcenter.status, r.supervisor, all.length, h.nodes.filter(n => n.role === 'host').map(n => n.name)) : undefined;
        return <One key={h.supervisorId} h={h} r={r} vc={vc} vcRead={config.vcenter ? vcenter ?? undefined : null} canClean={canWrite(h.supervisorId)} onClean={() => setCleaning({ h, r })} />;
      })}
      {cleaning && <ActionDialog plan={leftoverCleanupPlan(cleaning.h)} writer={supervisorWriter(cleaning.r.supervisor)} onClose={() => setCleaning(null)} onApplied={() => refresh()} />}
    </>
  );
}

function One({ h, r, vc, vcRead, canClean, onClean }: { h: SupervisorHealth; r: SupervisorResult; vc?: VcSupervisor; vcRead?: VcenterRead | null; canClean: boolean; onClean: () => void }) {
  const score = Math.max(0, h.score - (vc ? vcenterPenalty(vc) : 0));
  const cps = h.nodes.filter(n => n.role === 'control-plane');
  const hosts = h.nodes.filter(n => n.role === 'host');
  const leftovers = h.services.reduce((n, s) => n + s.leftovers.length, 0);
  const stuck = h.backlog.reduce((n, b) => n + b.notReady, 0);
  // The control-plane VM's node name is an id; say what it is.
  const label = (node?: string) => (!node ? '—' : cps.some(n => n.name === node) ? `control-plane VM (${node.slice(0, 8)}…)` : node);
  const resp = responsiveness(requestStats().clusters.find(c => c.cluster === r.supervisor.headlampCluster));
  return (
    <>
      <SectionBox title={`${h.name}: Supervisor health`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 2 }}>
          <KpiTile label="Health" value={score} sub={vc ? 'out of 100, with vCenter' : 'out of 100'} tone={healthTone(score)} meter={{ value: score, max: 100 }} />
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

      <VcenterSection vc={vc} read={vcRead} />

      <SectionBox title="Controllers">
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Each controller holds a leader-election lease and renews it every few seconds. A lease that stops renewing means the
          controller is stuck or gone, even if its pod shows Running.
          {h.leasesUnreadable.length ? ` (${h.leasesUnreadable.length} more namespaces aren't readable with this account.)` : ''}
        </Typography>
        {h.leases.length ? (
          <SimpleTable
            columns={[
              { label: 'State', getter: (l: LeaseInfo) => <StatusLabel status={l.state === 'ok' ? 'success' : 'error'}>{l.state === 'ok' ? 'Renewing' : l.state === 'stale' ? 'Stale' : 'No leader'}</StatusLabel> },
              { label: 'Controller', getter: (l: LeaseInfo) => <b>{l.controller}</b> },
              { label: 'Last renewed', getter: (l: LeaseInfo) => ago(l.renewedSecondsAgo) },
              { label: 'Leader on', getter: (l: LeaseInfo) => label(l.holderNode) },
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
            { label: 'Running on', getter: (s: ServiceState) => s.running.map(p => label(p.host)).join(', ') || (s.state === 'ok' ? 'no long-running pods' : '—') },
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
          administrator can't read cluster-wide leases or admission webhooks. {vc ? "vCenter's view (above) covers the Supervisor's own status." : ''}
        </Typography>
      </SectionBox>
    </>
  );
}

/** vCenter's own view of the Supervisor, from the collector (or how to set it up). */
function VcenterSection({ vc, read }: { vc?: VcSupervisor; read?: VcenterRead | null }) {
  if (read === null) {
    return (
      <SectionBox title="From vCenter">
        <Typography variant="body2" color="text.secondary">
          The Supervisor's own status (Workload Management), its control-plane VMs, Supervisor Services, hosts and alarms live in
          vCenter. The vCenter collector (deploy/collector, read-only account) writes them into a ConfigMap this page reads; set
          its location in Settings.
        </Typography>
      </SectionBox>
    );
  }
  if (!read) return <SectionBox title="From vCenter"><Typography color="text.secondary">Reading…</Typography></SectionBox>;
  if (read.error || !vc) {
    return (
      <SectionBox title="From vCenter">
        <Alert severity="info">{read.error ?? "The collector's data has no Supervisor matching this one (by API address)."}</Alert>
      </SectionBox>
    );
  }
  const tone = (ok: boolean, bad: boolean) => (ok ? 'success' : bad ? 'error' : 'warning');
  return (
    <SectionBox title={`From vCenter${read.status?.vcenter ? ` (${read.status.vcenter})` : ''}`}>
      {read.ageMinutes !== undefined && read.ageMinutes > STALE_MINUTES && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          Collected {read.ageMinutes} minutes ago: the collector may have stopped (check its CronJob or timer).
        </Alert>
      )}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
        <StatusLabel status={tone(vc.configStatus === 'RUNNING', vc.configStatus === 'ERROR')}>{`Configuration: ${vc.configStatus.toLowerCase()}`}</StatusLabel>
        <StatusLabel status={tone(vc.kubernetesStatus === 'READY', vc.kubernetesStatus === 'ERROR')}>{`Kubernetes: ${vc.kubernetesStatus.toLowerCase()}`}</StatusLabel>
        <Typography variant="caption" color="text.secondary">
          {vc.name ? `vSphere cluster ${vc.name}` : ''}
          {read.ageMinutes !== undefined ? ` · collected ${read.ageMinutes} min ago` : ''}
        </Typography>
      </Box>
      {vc.messages.map((m, i) => (
        <Alert key={i} severity={m.severity === 'ERROR' ? 'error' : m.severity === 'WARNING' ? 'warning' : 'info'} sx={{ mb: 1 }}>
          {m.text}
        </Alert>
      ))}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 3, mt: 1 }}>
        <Box>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Control-plane VMs</Typography>
          <SimpleTable
            columns={[
              { label: 'State', getter: (v: VcSupervisor['controlPlaneVMs'][number]) => <StatusLabel status={v.power === 'POWERED_ON' ? 'success' : 'error'}>{String(v.power ?? '?').toLowerCase().replace('_', ' ')}</StatusLabel> },
              { label: 'VM', getter: (v: VcSupervisor['controlPlaneVMs'][number]) => <b>{v.name}</b> },
              { label: 'Size', getter: (v: VcSupervisor['controlPlaneVMs'][number]) => (v.cpus ? `${v.cpus} vCPU, ${Math.round((v.memoryMiB ?? 0) / 1024)} GiB` : '—') },
            ]}
            data={vc.controlPlaneVMs}
          />
          <Typography sx={{ fontWeight: 700, mt: 2, mb: 0.5 }}>Hosts</Typography>
          <SimpleTable
            columns={[
              { label: 'State', getter: (x: VcSupervisor['hosts'][number]) => <StatusLabel status={vcHostOk(x) ? 'success' : 'error'}>{vcHostOk(x) ? 'connected' : String(x.connection ?? '?').toLowerCase()}</StatusLabel> },
              { label: 'Host', getter: (x: VcSupervisor['hosts'][number]) => <b>{x.name}</b> },
              { label: 'Power', getter: (x: VcSupervisor['hosts'][number]) => String(x.power ?? '—').toLowerCase().replace('_', ' ') },
            ]}
            data={vc.hosts}
          />
        </Box>
        <Box>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Supervisor Services (vCenter)</Typography>
          {vc.services.length ? (
            <SimpleTable
              columns={[
                { label: 'State', getter: (x: VcSupervisor['services'][number]) => <StatusLabel status={vcServiceOk(x.state) ? 'success' : x.state === 'ERROR' ? 'error' : 'warning'}>{x.state.toLowerCase()}</StatusLabel> },
                { label: 'Service', getter: (x: VcSupervisor['services'][number]) => <b>{x.id.replace(/\.(vsphere\.vmware\.com|vmware\.com|vksm\.broadcom\.com)$/, '')}</b> },
                { label: 'Version', getter: (x: VcSupervisor['services'][number]) => x.version ?? '—' },
                { label: 'Notes', getter: (x: VcSupervisor['services'][number]) => x.messages?.map(m => m.text).join('; ') || '—' },
              ]}
              data={vc.services}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">None reported.</Typography>
          )}
          <Typography sx={{ fontWeight: 700, mt: 2, mb: 0.5 }}>Alarms</Typography>
          {vc.alarms.length ? (
            <SimpleTable
              columns={[
                { label: 'Level', getter: (a: VcSupervisor['alarms'][number]) => <StatusLabel status={a.status === 'red' ? 'error' : a.status === 'yellow' ? 'warning' : ''}>{a.acknowledged ? `${a.status}, acknowledged` : a.status}</StatusLabel> },
                { label: 'On', getter: (a: VcSupervisor['alarms'][number]) => <b>{a.entity}</b> },
                { label: 'Alarm', getter: (a: VcSupervisor['alarms'][number]) => a.name },
                { label: 'Since', getter: (a: VcSupervisor['alarms'][number]) => (a.time ? new Date(a.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—') },
              ]}
              data={vc.alarms}
            />
          ) : (
            <Typography variant="body2" color="text.secondary">
              {read.status?.notes?.find(n => /Alarms/.test(n)) ?? 'No triggered alarms.'}
            </Typography>
          )}
        </Box>
      </Box>
    </SectionBox>
  );
}

