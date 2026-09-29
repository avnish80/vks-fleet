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
import { diskForecast, entitiesFor, fullestDisk, historySeries, matchSupervisor, STALE_MINUTES, utilisationPenalty, vcenterPenalty, VcenterRead, VcEntity, vcHostOk, VcMetrics, VcSupervisor, vcServiceOk } from '../vcenterStatus';
import { TimeSeriesChart } from './TimeSeriesChart';
import { SeriesDetailDialog } from './SeriesDetailDialog';
import { humanDuration } from '../observability';
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
  const entities = vc ? entitiesFor(vcRead?.status?.metrics, vc.id) : [];
  const score = Math.max(0, h.score - (vc ? vcenterPenalty(vc) + utilisationPenalty(entities) : 0));
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
      {vc && entities.length > 0 && <UtilisationSection entities={entities} metrics={vcRead?.status?.metrics} />}

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
            {
              label: 'Running on',
              getter: (s: ServiceState) => {
                const counts = new Map<string, number>();
                for (const p of s.running) counts.set(label(p.host), (counts.get(label(p.host)) ?? 0) + 1);
                return Array.from(counts.entries()).map(([h, n]) => (n > 1 ? `${h} ×${n}` : h)).join(', ') || (s.state === 'ok' ? 'no long-running pods' : '—');
              },
            },
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

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, pb: 2 }}>
        Sources: the Supervisor’s API (controllers, services, placement, backlog, events)
        {vc ? ' and vCenter through the collector (status, control-plane VMs, hosts, services, alarms, utilisation)' : ''}. The Supervisor’s own
        /readyz and /metrics aren’t exposed through its endpoint{vc ? '' : '; vCenter’s view needs the collector (Settings)'}.
      </Typography>
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

const pct = (v?: number) => (v === undefined ? '—' : `${v.toFixed(0)}%`);
const tone = (v?: number, warn = 80, bad = 90) => (v === undefined ? '' : v > bad ? 'error' : v > warn ? 'warning' : 'success');

/** Utilisation of the control-plane VMs and hosts, from vCenter's performance counters, with the last 24 hours. */
function UtilisationSection({ entities, metrics }: { entities: VcEntity[]; metrics?: VcMetrics }) {
  const end = Math.floor(Date.now() / 60000) * 60000;
  // Fit the window to the history there is: an hour at least, a day at most.
  const first = Math.min(...(metrics?.history ?? []).map(h => new Date(h.t).getTime()), end);
  const start = end - Math.min(24 * 3600e3, Math.max(3600e3, (end - first) * 1.1));
  const vms = entities.filter(e => e.kind === 'vm');
  const hosts = entities.filter(e => e.kind === 'host');
  const names = entities.map(e => e.name);
  const legend = (l: Record<string, string>) => l.name.replace(/\.site-a\.vcf\.lab$|\.[a-z0-9-]+\.[a-z]+$/, '');
  const charts: Array<{ title: string; metric: 'cpuPct' | 'memPct' | 'diskFullPct' | 'netKBps'; unit: 'percent' | 'rate'; who: string[]; warn?: number; meaning: string }> = [
    { title: 'CPU', metric: 'cpuPct', unit: 'percent', who: names, warn: 90, meaning: 'The control-plane VM busy for long means the API server and controllers are under load (many clusters, objects or callers). A host near 90% cannot absorb a failover of another host’s VMs.' },
    { title: 'Memory', metric: 'memPct', unit: 'percent', who: names, warn: 90, meaning: 'Memory on the control-plane VM is mostly etcd and the API server’s caches, which grow with the number of objects. Sustained use above 90% is when the Supervisor starts to slow down; its size (small, medium, large) is set in Workload Management.' },
    { title: 'Control-plane VM disk (fullest)', metric: 'diskFullPct', unit: 'percent', who: vms.map(v => v.name), warn: 80, meaning: 'The fullest of the control-plane VM’s volumes. etcd and the API server live on this VM, and a full disk stops the whole Supervisor. Growth is normally logs or images; the forecast says when it runs out at the current rate.' },
    { title: 'Network (KB/s)', metric: 'netKBps', unit: 'rate', who: names, meaning: 'Traffic through the control-plane VM and the hosts. A sudden jump on the control-plane VM usually means a controller re-listing everything, or many clients (watches) reconnecting.' },
  ];
  const [detail, setDetail] = React.useState<(typeof charts)[number] | null>(null);
  const samples = metrics?.history.length ?? 0;
  return (
    <SectionBox title="Utilisation (vCenter)">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        From vCenter's performance counters, sampled every 5 minutes by the collector, with the last 24 hours kept. The control-plane
        VM holds etcd and the API server: its disk and memory matter most.
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 1.5, mb: 2 }}>
        {[...vms, ...hosts].map(e => {
          const d = fullestDisk(e);
          const eta = e.kind === 'vm' ? diskForecast(metrics, e.name) : undefined;
          return (
            <Box key={e.name} sx={{ p: 1.25, borderRadius: 2, border: 1, borderColor: 'divider' }}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {e.kind === 'vm' ? 'Control plane' : 'Host'}
              </Typography>
              <Typography sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{legend({ name: e.name })}</Typography>
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: 0.75 }}>
                <StatusLabel status={tone(e.cpuPct)}>{`CPU ${pct(e.cpuPct)}`}</StatusLabel>
                <StatusLabel status={tone(e.memPct)}>{`Mem ${pct(e.memPct)}`}</StatusLabel>
                {d && (
                  <span title={`${d.path}${eta !== undefined ? `; full in about ${humanDuration(eta)} at this rate` : ''}`}>
                    <StatusLabel status={tone(d.pct, 80, 90)}>{`Disk ${pct(d.pct)}${eta !== undefined && eta < 7 * 86400 ? ` · full in ${humanDuration(eta)}` : ''}`}</StatusLabel>
                  </span>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
      {samples > 0 && samples < 12 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {samples} sample{samples === 1 ? '' : 's'} so far; the collector adds one every 5 minutes, and the day’s curve builds up over 24 hours.
        </Typography>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 2 }}>
        {charts.map(c => {
          const series = historySeries(metrics, c.who, c.metric);
          return (
            <Box key={c.title} sx={{ p: 1.5, borderRadius: 2, border: 1, borderColor: 'divider', transition: 'box-shadow 150ms', '&:hover': { boxShadow: 3 } }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
                <Typography sx={{ fontWeight: 600, flex: 1 }}>{c.title}</Typography>
                <Button size="small" onClick={() => setDetail(c)} sx={{ minWidth: 0, py: 0 }} title={c.meaning}>
                  Expand
                </Button>
              </Box>
              {series.length ? (
                <TimeSeriesChart series={series} legend={legend} unit={c.unit} start={start} end={end} warnAbove={c.warn} height={190} />
              ) : (
                <Typography variant="body2" color="text.secondary">No history yet: the collector adds a sample every 5 minutes.</Typography>
              )}
            </Box>
          );
        })}
      </Box>
      {detail && (
        <SeriesDetailDialog
          title={detail.title}
          subtitle="Supervisor, from vCenter"
          series={historySeries(metrics, detail.who, detail.metric)}
          legend={legend}
          unit={detail.unit}
          warnAbove={detail.warn}
          meaning={detail.meaning}
          onClose={() => setDetail(null)}
        />
      )}
    </SectionBox>
  );
}

