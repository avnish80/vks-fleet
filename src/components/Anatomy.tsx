/**
 * The VKS anatomy of one cluster as a diagram: tenant namespace, cluster,
 * control plane and node pools, and each machine with its VM. Coloured by
 * health; stuck machines are dashed; everything clickable. Plain SVG.
 */
import { Box, Typography, useTheme } from '@mui/material';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { formatDuration } from '../capi/v1beta1';
import { clusterDeepLink, machinePath } from '../routes';
import { FleetCluster, MachineInfo } from '../types';
import { Tone, useTone } from './charts';

const W = 1000;
const ROW = 58;
const TOP = 24;
const COL = { tenant: 10, cluster: 225, group: 465, machine: 700 };
const BOX = { tenant: 180, cluster: 200, group: 200, machine: 290 };

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Keeps the distinctive end of long machine names. */
function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-(n - 1))}` : s;
}

/**
 * VKS names machines and pools after the cluster ("<cluster>-<cluster>-np-1-7d8jr…").
 * Dropping the repeated cluster prefix leaves the part that tells them apart.
 */
export function shortName(name: string, clusterName: string): string {
  let out = name;
  for (let i = 0; i < 2 && out.startsWith(`${clusterName}-`) && out.length > clusterName.length + 1; i++) {
    out = out.slice(clusterName.length + 1);
  }
  return out;
}

interface Group {
  key: string;
  label: string;
  sub: string;
  tone: Tone;
  machines: MachineInfo[];
  pool?: string;
}

function machineTone(m: MachineInfo): Tone {
  if (m.deletingSince) return 'warning';
  if (m.phase === 'Failed' || (m.vm?.powerState && !/^poweredon$/i.test(m.vm.powerState))) return 'error';
  if (m.phase !== 'Running') return 'info';
  return m.ready === false ? 'warning' : 'success';
}

function edge(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
}

export function AnatomyDiagram({ cluster, now = new Date() }: { cluster: FleetCluster; now?: Date }) {
  const theme: any = useTheme();
  const tone = useTone();
  const history = useHistory();
  const paper = theme.palette?.background?.paper ?? '#fff';
  const text = theme.palette?.text?.primary ?? '#222';
  const muted = theme.palette?.text?.secondary ?? '#666';
  const line = theme.palette?.divider ?? '#ccc';

  const cp = cluster.machines.filter(m => m.role === 'control-plane');
  const groups: Group[] = [
    {
      key: 'cp',
      label: 'Control plane',
      sub: cluster.controlPlane ? `${cluster.controlPlane.ready}/${cluster.controlPlane.desired} ready` : `${cp.length} node${cp.length === 1 ? '' : 's'}`,
      tone: cluster.controlPlane && cluster.controlPlane.ready < cluster.controlPlane.desired ? 'warning' : 'success',
      machines: cp,
    },
    ...cluster.nodePools.map(p => {
      const ms = cluster.machines.filter(m => m.pool === p.name);
      const timeouts = [p.nodeDrainTimeout ? `drain ${p.nodeDrainTimeout}` : '', p.nodeVolumeDetachTimeout ? `volumes ${p.nodeVolumeDetachTimeout}` : '']
        .filter(Boolean)
        .join(', ');
      return {
        key: `pool-${p.name}`,
        label: p.name,
        sub: `${p.ready}/${p.desired ?? '?'} ready${p.vmClass ? `, ${p.vmClass}` : ''}${timeouts ? `, ${timeouts}` : ''}`,
        tone: (timeouts ? 'warning' : p.desired !== undefined && p.ready < p.desired ? 'warning' : 'success') as Tone,
        machines: ms,
        pool: p.name,
      };
    }),
  ];
  const placed = new Set(groups.flatMap(g => g.machines.map(m => m.name)));
  const others = cluster.machines.filter(m => !placed.has(m.name));
  if (others.length) groups.push({ key: 'other', label: 'Other machines', sub: `${others.length}`, tone: 'neutral', machines: others });

  // Rows: one per machine, and one placeholder row for an empty group.
  let row = 0;
  const machineY = new Map<string, number>();
  const groupY = new Map<string, number>();
  for (const g of groups) {
    const start = row;
    if (g.machines.length === 0) row += 1;
    for (const m of g.machines) {
      machineY.set(m.name, TOP + row * ROW + ROW / 2);
      row += 1;
    }
    groupY.set(g.key, TOP + ((start + row) / 2) * ROW);
  }
  const rows = Math.max(row, 2);
  const H = TOP * 2 + rows * ROW;
  const midY = TOP + (rows * ROW) / 2;
  const healthTone: Tone =
    cluster.health === 'healthy' ? 'success' : cluster.health === 'failed' ? 'error' : cluster.health === 'provisioning' ? 'info' : 'warning';

  const box = (
    x: number,
    y: number,
    w: number,
    h: number,
    stroke: string,
    lines: Array<{ text: string; weight?: number; color?: string; size?: number }>,
    opts: { key?: string; dashed?: boolean; onClick?: () => void; title?: string; badge?: { text: string; color: string } } = {}
  ) => (
    <g
      key={opts.key}
      transform={`translate(${x}, ${y - h / 2})`}
      style={{ cursor: opts.onClick ? 'pointer' : 'default' }}
      onClick={opts.onClick}
      role={opts.onClick ? 'link' : undefined}
    >
      {opts.title && <title>{opts.title}</title>}
      <rect width={w} height={h} rx={8} fill={paper} stroke={stroke} strokeWidth={1.5} strokeDasharray={opts.dashed ? '5 4' : undefined} />
      <rect width={4} height={h} rx={2} fill={stroke} />
      {lines.map((l, i) => (
        <text
          key={i}
          x={12}
          y={h / 2 + (i - (lines.length - 1) / 2) * 15 + 4}
          fontSize={l.size ?? 12}
          fontWeight={l.weight ?? 400}
          fill={l.color ?? text}
        >
          {l.text}
        </text>
      ))}
      {opts.badge && (
        <g transform={`translate(${w - 10}, -9)`}>
          <rect x={-(opts.badge.text.length * 6.2 + 12)} width={opts.badge.text.length * 6.2 + 12} height={17} rx={8.5} fill={opts.badge.color} />
          <text x={-(opts.badge.text.length * 6.2 + 12) / 2} y={12} fontSize={10} fontWeight={600} fill="#fff" textAnchor="middle">
            {opts.badge.text}
          </text>
        </g>
      )}
    </g>
  );

  return (
    <Box sx={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 760, display: 'block' }} role="img" aria-label={`Anatomy of ${cluster.name}`}>
        {/* edges */}
        <path d={edge(COL.tenant + BOX.tenant, midY, COL.cluster, midY)} fill="none" stroke={line} strokeWidth={1.5} />
        {groups.map(g => (
          <path key={`e-${g.key}`} d={edge(COL.cluster + BOX.cluster, midY, COL.group, groupY.get(g.key)!)} fill="none" stroke={line} strokeWidth={1.5} />
        ))}
        {groups.flatMap(g =>
          g.machines.map(m => (
            <path
              key={`e-${m.name}`}
              d={edge(COL.group + BOX.group, groupY.get(g.key)!, COL.machine, machineY.get(m.name)!)}
              fill="none"
              stroke={m.deletingSince ? tone('warning') : line}
              strokeWidth={1.5}
              strokeDasharray={m.deletingSince ? '5 4' : undefined}
            />
          ))
        )}

        {box(COL.tenant, midY, BOX.tenant, 64, tone('info'), [
          { text: trunc(`Tenant ${cluster.tenantName}`, 24), weight: 600 },
          { text: trunc(cluster.namespace, 26), color: muted, size: 11 },
          { text: `Supervisor ${trunc(cluster.supervisorId, 14)}`, color: muted, size: 11 },
        ])}

        {box(
          COL.cluster,
          midY,
          BOX.cluster,
          78,
          tone(healthTone),
          [
            { text: trunc(cluster.name, 25), weight: 600 },
            { text: trunc(cluster.kubernetesVersion ?? 'version unknown', 28), color: muted, size: 11 },
            { text: trunc(cluster.clusterClass ?? '', 28), color: muted, size: 11 },
            { text: cluster.endpoint ? `API ${cluster.endpoint.host}:${cluster.endpoint.port}` : '', color: muted, size: 11 },
          ],
          { key: 'cluster', title: `${cluster.name}: ${cluster.health}`, badge: { text: cluster.health, color: tone(healthTone) } }
        )}

        {groups.map(g =>
          box(
            COL.group,
            groupY.get(g.key)!,
            BOX.group,
            48,
            tone(g.tone),
            [
              { text: trunc(g.pool ? shortName(g.label, cluster.name) : g.label, 25), weight: 600 },
              { text: trunc(g.sub, 29), color: muted, size: 11 },
            ],
            {
              key: g.key,
              onClick: g.pool ? () => history.push(clusterDeepLink(cluster, { hash: 'node-pools', focus: g.pool })) : undefined,
              title: g.pool ? `Node pool ${g.pool}\n${g.sub}` : g.sub,
            }
          )
        )}

        {groups.flatMap(g =>
          g.machines.map(m => {
            const t = machineTone(m);
            const details = [m.vm?.powerState, m.internalIP, m.failureDomain, m.vm?.className].filter(Boolean).join(', ');
            const badge = m.deletingSince
              ? { text: `deleting ${formatDuration(now.getTime() - new Date(m.deletingSince).getTime())}`, color: tone('warning') }
              : m.phase !== 'Running'
              ? { text: m.phase.toLowerCase(), color: tone(t) }
              : m.ready === false
              ? { text: 'not ready', color: tone('warning') }
              : undefined;
            return (
              <React.Fragment key={m.name}>
                {box(
                  COL.machine,
                  machineY.get(m.name)!,
                  BOX.machine,
                  46,
                  tone(t),
                  [
                    { text: tail(shortName(m.nodeName ?? m.name, cluster.name), 34), weight: 600 },
                    { text: trunc(details || m.phase, 42), color: muted, size: 11 },
                  ],
                  {
                    dashed: !!m.deletingSince,
                    onClick: () => history.push(machinePath(cluster, m.name)),
                    title: `${m.nodeName ?? m.name}\n${m.phase}${details ? `\n${details}` : ''}`,
                    badge,
                  }
                )}
              </React.Fragment>
            );
          })
        )}
        {groups
          .filter(g => g.machines.length === 0)
          .map(g => (
            <text key={`empty-${g.key}`} x={COL.machine} y={groupY.get(g.key)! + 4} fontSize={11} fill={muted}>
              No nodes
            </text>
          ))}
      </svg>
      <Typography variant="caption" color="text.secondary">
        Click a machine to open it, or a node pool to jump to its row. Dashed: being deleted.
      </Typography>
    </Box>
  );
}
