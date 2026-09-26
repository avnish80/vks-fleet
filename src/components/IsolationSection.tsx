import { SectionBox, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Typography } from '@mui/material';
import React from 'react';
import { fetchAccess } from '../access';
import { supervisorClient } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { ISO_CHECKS, IsoStatus, isolationMarkdown, isolationReport } from '../isolation';
import { download } from '../report';
import { AccessEntry } from '../types';
import { usePolling } from '../usePolling';

const TONE: Record<IsoStatus, 'success' | 'error' | 'warning' | ''> = { pass: 'success', fail: 'error', review: 'warning', unknown: '' };

/** Operators and read-only admins: is each org separated from the others? */
export function IsolationSection() {
  const { all, inventoryAll, persona } = useFleetData();
  const [open, setOpen] = React.useState<string | null>(null);
  const operatorView = !!persona && (persona.persona === 'operator' || persona.persona === 'readonly' || persona.persona === 'unknown');
  const spaces = (all ?? []).flatMap(r => (r.namespaces ?? []).map(n => ({ r, ns: n.name })));
  const key = operatorView && spaces.length ? spaces.map(x => `${x.r.supervisor.id}/${x.ns}`).join('|') : null;
  const bindings = usePolling(
    key,
    async () =>
      new Map(
        await Promise.all(
          spaces.map(async x => [x.ns, (await fetchAccess(supervisorClient(x.r.supervisor), x.ns)).entries] as [string, AccessEntry[]])
        )
      ),
    600
  );
  if (!operatorView || !all) return null;
  const rows = isolationReport(all, inventoryAll, bindings);
  if (rows.length < 1) return null;
  return (
    <SectionBox
      title="Tenant isolation"
      headerProps={{
        actions: [
          <Button key="md" size="small" variant="outlined" onClick={() => download(`vks-tenant-isolation-${new Date().toISOString().slice(0, 10)}.md`, isolationMarkdown(rows), 'text/markdown')}>
            Report (Markdown)
          </Button>,
        ],
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        From the Supervisor's view: does each org have its own VPC, are its public addresses and routed ranges its own, are subnets
        shared, do people have access to more than one org, and are firewall policies in place. Click a cell for the details.
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>
        <Box component="table" sx={{ borderCollapse: 'separate', borderSpacing: '4px', fontSize: '0.85rem', minWidth: '100%' }}>
          <thead>
            <tr>
              <Box component="th" sx={{ textAlign: 'left', p: 1 }}>
                Org
              </Box>
              {ISO_CHECKS.map(c => (
                <Box component="th" key={c.id} sx={{ textAlign: 'left', p: 1, whiteSpace: 'nowrap' }}>
                  {c.title}
                </Box>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.orgId}>
                <Box component="td" sx={{ p: 1, fontWeight: 600, whiteSpace: 'nowrap' }} title={r.namespaces.join(', ')}>
                  {r.org}
                </Box>
                {ISO_CHECKS.map(c => {
                  const x = r.checks.find(y => y.id === c.id);
                  const k = `${r.orgId}/${c.id}`;
                  return (
                    <Box
                      component="td"
                      key={c.id}
                      title={x?.detail}
                      onClick={() => setOpen(open === k ? null : k)}
                      sx={{ p: 1, cursor: 'pointer', borderRadius: 1, bgcolor: 'action.hover' }}
                    >
                      {x ? <StatusLabel status={TONE[x.status]}>{x.status}</StatusLabel> : '—'}
                    </Box>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
      {open && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          {(() => {
            const [orgId, id] = open.split('/');
            const r = rows.find(x => x.orgId === orgId);
            const c = r?.checks.find(x => x.id === id);
            return c ? `${r!.org} · ${c.title}: ${c.detail}` : '';
          })()}
        </Typography>
      )}
    </SectionBox>
  );
}
