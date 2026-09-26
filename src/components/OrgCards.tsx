import { SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Paper, TextField, Typography } from '@mui/material';
import { settingsStore, useRawSettings } from '../settings/store';
import React, { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useFleetData } from '../fleetContext';
import { namespacePath } from '../inventoryIssues';
import { configuredByNamespace, overcommit } from '../limits';
import { formatBytes } from '../quantity';
import { CAPACITY_PATH, SECURITY_ROUTE, SHOWBACK_PATH } from '../routes';
import { ALL_ORGS, OrgInfo } from '../scope';
import { UsageBar } from './InventoryViews';

interface OrgStats {
  storageUsed: number;
  storageLimit: number;
  memConfigured: number;
  memLimit: number;
}

function useOrgStats(): (o: OrgInfo) => OrgStats {
  const { all, inventoryAll, limitsAll } = useFleetData();
  const configured = configuredByNamespace(all ?? [], inventoryAll);
  const quotas = Array.from(inventoryAll?.values() ?? []).flatMap(i => i.quotas);
  return o => {
    const ns = new Set(o.namespaces);
    const q = quotas.filter(x => ns.has(x.namespace));
    let memConfigured = 0;
    let memLimit = 0;
    for (const n of o.namespaces) {
      const l = limitsAll.get(n);
      if (l?.memoryLimitBytes) {
        memLimit += l.memoryLimitBytes;
        memConfigured += configured.get(n)?.memoryBytes ?? 0;
      }
    }
    return {
      storageUsed: q.reduce((a, x) => a + x.used, 0),
      storageLimit: q.reduce((a, x) => a + x.limit, 0),
      memConfigured,
      memLimit,
    };
  };
}

function Card({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Paper
      variant="outlined"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e: any) => (e.key === 'Enter' || e.key === ' ') && onClick()}
      sx={{
        p: 1.75,
        borderRadius: 2,
        cursor: 'pointer',
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? 'primary.main' : 'divider',
        transition: 'box-shadow 150ms',
        '&:hover': { boxShadow: 3 },
      }}
    >
      {children}
    </Paper>
  );
}

/**
 * The orgs on the Supervisor as cards: pick one to see only its things on
 * every page (the choice is remembered, and kept in the address as ?org=).
 */
/** Gives an org shown only by its ID a readable name (kept with the plugin settings). */
function NameOrg({ id }: { id: string }) {
  const raw = useRawSettings();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  if (!open) {
    return (
      <Button
        size="small"
        onClick={e => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        Name this org
      </Button>
    );
  }
  return (
    <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }} onClick={e => e.stopPropagation()}>
      <TextField size="small" autoFocus placeholder="e.g. org1" value={name} onChange={e => setName(e.target.value)} />
      <Button
        size="small"
        disabled={!name.trim()}
        onClick={() => {
          settingsStore.update({ orgNames: { ...(raw.orgNames ?? {}), [id]: name.trim() } });
          setOpen(false);
        }}
      >
        Save
      </Button>
    </Box>
  );
}

const looksLikeId = (o: OrgInfo) => o.name === o.id && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(o.id);

export function OrgCards() {
  const { orgs, org, setOrg, persona } = useFleetData();
  const stats = useOrgStats();
  if (persona?.persona === 'tenant' || persona?.persona === 'tenant-readonly' || orgs.length === 0) return null;
  const totals = orgs.reduce((a, o) => ({ ns: a.ns + o.namespaces.length, c: a.c + o.clusters, v: a.v + o.vms, att: a.att + o.attention }), { ns: 0, c: 0, v: 0, att: 0 });
  return (
    <SectionBox title="Orgs">
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 1.5 }}>
        <Card selected={org === ALL_ORGS} onClick={() => setOrg(ALL_ORGS)}>
          <Typography sx={{ fontWeight: 700 }}>All orgs</Typography>
          <Typography variant="body2" color="text.secondary">
            {orgs.length} org{orgs.length === 1 ? '' : 's'} · {totals.ns} namespaces
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {totals.c} clusters · {totals.v} VMs
          </Typography>
          {totals.att > 0 && <StatusLabel status="warning">{`${totals.att} cluster${totals.att === 1 ? '' : 's'} need attention`}</StatusLabel>}
        </Card>
        {orgs.map(o => {
          const s = stats(o);
          const mem = overcommit(s.memConfigured, s.memLimit || undefined);
          return (
            <Card key={o.id} selected={org === o.id} onClick={() => setOrg(org === o.id ? ALL_ORGS : o.id)}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <Typography sx={{ fontWeight: 700 }} noWrap title={o.id}>
                  {o.name}
                </Typography>
                {o.attention > 0 ? (
                  <StatusLabel status="warning">{`${o.attention} need attention`}</StatusLabel>
                ) : o.clusters > 0 ? (
                  <StatusLabel status="success">Healthy</StatusLabel>
                ) : null}
              </Box>
              {looksLikeId(o) && <NameOrg id={o.id} />}
              <Typography variant="body2" color="text.secondary">
                {o.namespaces.length} namespace{o.namespaces.length === 1 ? '' : 's'} · {o.clusters} cluster{o.clusters === 1 ? '' : 's'} · {o.vms} VM
                {o.vms === 1 ? '' : 's'}
              </Typography>
              {s.storageLimit > 0 && (
                <Box sx={{ mt: 0.75 }}>
                  <Typography variant="caption" color="text.secondary">
                    Storage
                  </Typography>
                  <UsageBar used={s.storageUsed} total={s.storageLimit} text={`${formatBytes(s.storageUsed)} of ${formatBytes(s.storageLimit)}`} />
                </Box>
              )}
              {mem !== undefined && (
                <Box sx={{ mt: 0.5 }}>
                  <StatusLabel status={mem > 4 ? 'error' : mem > 2 ? 'warning' : 'success'}>
                    {`Memory ${mem.toFixed(1)}× the limit`}
                  </StatusLabel>
                </Box>
              )}
            </Card>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Click an org to see only its clusters, VMs, networks, issues and reports, on every page. Click it again (or All orgs) to go back.
      </Typography>
    </SectionBox>
  );
}

/** When one org is selected: its quota, namespaces and where to look next. */
export function OrgSummary() {
  const { orgs, org, setOrg, orgQuotas, all, inventoryAll, limitsAll } = useFleetData();
  const o = orgs.find(x => x.id === org);
  if (!o) return null;
  const configured = configuredByNamespace(all ?? [], inventoryAll);
  const quotas = Array.from(inventoryAll?.values() ?? []).flatMap(i => i.quotas);
  const supOf = new Map((all ?? []).flatMap(r => (r.namespaces ?? []).map(n => [n.name, r.supervisor.id] as [string, string])));
  const quota = orgQuotas.find(q => q.org === o.name || q.org === o.id);
  type NsRow = { ns: string };
  return (
    <SectionBox
      title={`${o.name}: summary`}
      headerProps={{
        actions: [
          <Button key="cap" size="small" variant="outlined" component={Link} to={CAPACITY_PATH}>
            Capacity
          </Button>,
          <Button key="sec" size="small" variant="outlined" component={Link} to={SECURITY_ROUTE}>
            Security
          </Button>,
          <Button key="sb" size="small" variant="outlined" component={Link} to={SHOWBACK_PATH}>
            Showback
          </Button>,
          <Button key="all" size="small" onClick={() => setOrg(ALL_ORGS)}>
            Show all orgs
          </Button>,
        ],
      }}
    >
      {quota && (
        <Box sx={{ mb: 2 }}>
          <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Org quota{quota.region ? ` in ${quota.region}` : ''} (VCF Automation)</Typography>
          {quota.storage.map(st => (
            <Box key={st.storageClass} sx={{ mb: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {st.storageClass}: allocated to namespaces
              </Typography>
              <UsageBar used={st.allocatedBytes} total={st.capacityBytes} text={`${formatBytes(st.allocatedBytes)} of ${formatBytes(st.capacityBytes)}`} />
            </Box>
          ))}
        </Box>
      )}
      <SimpleTable
        columns={[
          {
            label: 'Namespace',
            getter: (r: NsRow) => (supOf.get(r.ns) ? <Link to={namespacePath(supOf.get(r.ns)!, r.ns)}>{r.ns}</Link> : r.ns),
          },
          {
            label: 'Clusters',
            getter: (r: NsRow) => (all ?? []).flatMap(x => x.clusters).filter(c => c.namespace === r.ns).length,
          },
          {
            label: 'VMs',
            getter: (r: NsRow) => Array.from(inventoryAll?.values() ?? []).flatMap(i => i.vms).filter(v => v.namespace === r.ns && !v.cluster).length,
          },
          {
            label: 'Memory',
            getter: (r: NsRow) => {
              const l = limitsAll.get(r.ns);
              const c = configured.get(r.ns);
              if (!l?.memoryLimitBytes) return c ? `${formatBytes(c.memoryBytes)} configured` : '—';
              const ratio = overcommit(c?.memoryBytes ?? 0, l.memoryLimitBytes)!;
              return (
                <StatusLabel status={ratio > 4 ? 'error' : ratio > 2 ? 'warning' : 'success'}>
                  {`${formatBytes(c?.memoryBytes ?? 0)} of ${formatBytes(l.memoryLimitBytes)} (${ratio.toFixed(1)}×)`}
                </StatusLabel>
              );
            },
          },
          {
            label: 'Storage',
            getter: (r: NsRow) => {
              const q = quotas.filter(x => x.namespace === r.ns);
              const used = q.reduce((a, x) => a + x.used, 0);
              const limit = q.reduce((a, x) => a + x.limit, 0);
              return limit ? <UsageBar used={used} total={limit} text={`${formatBytes(used)} of ${formatBytes(limit)}`} /> : '—';
            },
          },
          { label: 'Class', getter: (r: NsRow) => limitsAll.get(r.ns)?.className ?? '—' },
        ]}
        data={o.namespaces.map(ns => ({ ns }))}
      />
    </SectionBox>
  );
}
