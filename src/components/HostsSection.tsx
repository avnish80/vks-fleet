import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Typography } from '@mui/material';
import React from 'react';
import { HostCard, hostBlast, hostMap } from '../hostmap';
import { SupervisorHealth } from '../supervisorHealth';
import { ServiceVm, SupervisorResult } from '../types';
import { placementFor, VcEntity, VcenterStatus, VcSupervisor } from '../vcenterStatus';

const bar = (pct: number | undefined, label: string) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
    <Typography variant="caption" color="text.secondary" sx={{ width: 30 }}>
      {label}
    </Typography>
    <Box sx={{ flex: 1, height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
      <Box sx={{ width: `${Math.min(100, pct ?? 0)}%`, height: '100%', bgcolor: pct === undefined ? 'transparent' : pct > 90 ? 'error.main' : pct > 75 ? 'warning.main' : 'success.main' }} />
    </Box>
    <Typography variant="caption" sx={{ width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
      {pct === undefined ? '—' : `${Math.round(pct)}%`}
    </Typography>
  </Box>
);

const chip = (text: string, tone: 'primary' | 'neutral' | 'warning' = 'neutral', title?: string) => (
  <Box
    key={text}
    component="span"
    title={title}
    sx={{
      display: 'inline-block',
      px: 0.75,
      py: 0.1,
      borderRadius: 1,
      fontSize: '0.72rem',
      fontWeight: 600,
      bgcolor: tone === 'primary' ? 'primary.main' : tone === 'warning' ? 'warning.main' : 'action.selected',
      color: tone === 'neutral' ? 'text.primary' : 'common.white',
      whiteSpace: 'nowrap',
    }}
  >
    {text}
  </Box>
);

/** The Supervisor by ESXi host: load, what runs where, and what a host failure takes down. */
export function HostsSection({ h, r, vc, status, vms, entities, label }: { h: SupervisorHealth; r: SupervisorResult; vc?: VcSupervisor; status?: VcenterStatus; vms: ServiceVm[]; entities: VcEntity[]; label: (n?: string) => string }) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const placed = placementFor(status, vc?.id);
  const byVm = new Map(vms.map(v => [v.name, v.host]));
  const hostOf = (name: string) => byVm.get(name) ?? placed.get(name);
  const map = hostMap({
    hosts: h.nodes.filter(n => n.role === 'host').map(n => ({ name: n.name, ready: n.ready })),
    vcHosts: vc?.hosts,
    load: entities,
    alarms: vc?.alarms,
    controlPlaneVms: vc?.controlPlaneVMs.map(v => v.name),
    services: h.services,
    clusters: r.clusters,
    vms,
    hostOf,
  });
  if (!map.cards.length) return null;
  const card = map.cards.find(c => c.name === selected);
  const blast = card ? hostBlast(card, h.services, r.clusters) : undefined;
  const short = (n: string) => n.replace(/\..*$/, '');
  const edge = (c: HostCard) => (!c.ready || (c.connection && c.connection !== 'CONNECTED') ? 'error.main' : c.alarms || (c.cpuPct ?? 0) > 90 || (c.memPct ?? 0) > 90 ? 'warning.main' : 'success.main');
  return (
    <SectionBox title="Hosts">
      {h.placement.concentrated && (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          Every Supervisor service pod runs on <b>{short(h.placement.concentrated)}</b> while {h.placement.readyHosts} hosts are Ready: if it
          fails, all services stop together. Restarting one service's pod at a time spreads them.
        </Alert>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(map.cards.length, 6)}, minmax(190px, 1fr))`, gap: 1.5, overflowX: 'auto' }}>
        {map.cards.map(c => (
          <Box
            key={c.name}
            role="button"
            onClick={() => setSelected(selected === c.name ? null : c.name)}
            sx={{
              p: 1.25,
              borderRadius: 2,
              border: 1,
              borderColor: selected === c.name ? 'primary.main' : 'divider',
              borderLeft: 4,
              borderLeftColor: edge(c),
              cursor: 'pointer',
              transition: 'box-shadow 150ms',
              '&:hover': { boxShadow: 3 },
              boxShadow: selected === c.name ? 3 : 0,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mb: 0.75 }}>
              <Typography sx={{ fontWeight: 700, flex: 1 }}>{short(c.name)}</Typography>
              {c.alarms > 0 && chip(`${c.alarms} alarm${c.alarms === 1 ? '' : 's'}`, 'warning')}
              {!c.ready && chip('not Ready', 'warning')}
            </Box>
            {bar(c.cpuPct, 'CPU')}
            {bar(c.memPct, 'Mem')}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
              {c.controlPlaneVms.length > 0 && chip('Supervisor CP', 'primary', c.controlPlaneVms.join(', '))}
              {c.services.length > 0 && chip(`${c.services.length} service${c.services.length === 1 ? '' : 's'}`, 'neutral', c.services.join(', '))}
              {c.clusters.map(x => chip(`${x.cluster.replace(/^kubernetes-cluster-/, '')} ×${x.nodes.length}${x.controlPlane ? ' (CP)' : ''}`, 'neutral', x.nodes.join('\n')))}
              {c.vms.length > 0 && chip(`${c.vms.length} VM${c.vms.length === 1 ? '' : 's'}`, 'neutral', c.vms.join(', '))}
              {!c.controlPlaneVms.length && !c.services.length && !c.clusters.length && !c.vms.length && (
                <Typography variant="caption" color="text.secondary">
                  nothing placed here
                </Typography>
              )}
            </Box>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Click a host for what its failure would take down.
        {map.unplaced ? ` ${map.unplaced} cluster node${map.unplaced === 1 ? '' : 's'} and VMs not placed: ${status?.placement ? 'not in this vCenter cluster' : 'placement needs the vCenter collector with pyvmomi'}.` : ''}
        {' '}Control plane: {h.nodes.filter(n => n.role === 'control-plane').map(n => `${label(n.name)} ${n.ready ? 'Ready' : 'NOT Ready'}`).join(', ') || '—'}.
      </Typography>
      {blast && (
        <Alert severity={blast.supervisorControlPlane.length || blast.servicesDown.length || blast.clusters.some(x => x.controlPlaneLost) ? 'error' : 'warning'} sx={{ mt: 1.5 }} onClose={() => setSelected(null)}>
          <Typography sx={{ fontWeight: 700, mb: 0.5 }}>If {short(blast.host)} fails (until vSphere HA restarts its VMs elsewhere):</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {blast.supervisorControlPlane.length > 0 && (
              <li>
                <b>The Supervisor's control plane</b> ({blast.supervisorControlPlane.join(', ')}): the Supervisor API and every controller stop.
              </li>
            )}
            {blast.servicesDown.length > 0 && (
              <li>
                <b>Supervisor services stop:</b> {blast.servicesDown.join(', ')} (every pod is here).
              </li>
            )}
            {blast.servicesDegraded.length > 0 && <li>Services that keep running with fewer pods: {blast.servicesDegraded.join(', ')}.</li>}
            {blast.clusters.map(x => (
              <li key={x.cluster}>
                <b>{x.cluster}</b> loses {x.nodes} of {x.total} nodes{x.controlPlaneLost ? ', including its whole control plane: its API is down' : ''}.
              </li>
            ))}
            {blast.vms.length > 0 && <li>VM Service VMs: {blast.vms.join(', ')}.</li>}
            {!blast.supervisorControlPlane.length && !blast.servicesDown.length && !blast.servicesDegraded.length && !blast.clusters.length && !blast.vms.length && <li>Nothing placed on this host.</li>}
          </Box>
        </Alert>
      )}
    </SectionBox>
  );
}

