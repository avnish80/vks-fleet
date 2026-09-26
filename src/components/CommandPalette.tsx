import { Box, Dialog, TextField, Typography } from '@mui/material';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { PaletteEntry, rankEntries } from '../awareness';
import { useFleetData } from '../fleetContext';
import { namespacePath, vmPath } from '../inventoryIssues';
import {
  ACCESS_PATH,
  APPS_ROUTE,
  BASELINE_PATH,
  CAPACITY_PATH,
  CLEANUP_PATH,
  clusterPath,
  COMPLIANCE_ROUTE,
  FLEET_PATH,
  MACHINES_PATH,
  NAMESPACE_BASE,
  NETWORK_PATH,
  PACKAGES_PATH,
  SEARCH_ROUTE,
  SECURITY_ROUTE,
  SHOWBACK_PATH,
  UPGRADES_PATH,
  VM_BASE,
} from '../routes';


const PAGES: Array<[string, string]> = [
  ['Fleet overview', FLEET_PATH],
  ['Search', SEARCH_ROUTE],
  ['Namespaces', NAMESPACE_BASE],
  ['Machines', MACHINES_PATH],
  ['VMs', VM_BASE],
  ['Network', NETWORK_PATH],
  ['Applications', APPS_ROUTE],
  ['Packages', PACKAGES_PATH],
  ['Security', SECURITY_ROUTE],
  ['Compliance', COMPLIANCE_ROUTE],
  ['Upgrades', UPGRADES_PATH],
  ['Capacity', CAPACITY_PATH],
  ['Baseline', BASELINE_PATH],
  ['Cleanup', CLEANUP_PATH],
  ['Access', ACCESS_PATH],
  ['Showback', SHOWBACK_PATH],
];


/** Ctrl+K (or ⌘K): jump to any page, cluster, VM or namespace. */
export function CommandPalette() {
  const { all, inventory } = useFleetData();
  const history = useHistory();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
        setQ('');
        setSel(0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const entries: PaletteEntry[] = [
    ...PAGES.map(([label, path]) => ({ kind: 'Page' as const, label, path })),
    ...(all ?? []).flatMap(r => r.clusters.map(c => ({ kind: 'Cluster' as const, label: c.name, hint: `${c.tenantName} · ${c.namespace}`, path: clusterPath(c) }))),
    ...(all ?? []).flatMap(r => (r.namespaces ?? []).map(n => ({ kind: 'Namespace' as const, label: n.name, hint: n.tenantName, path: namespacePath(r.supervisor.id, n.name) }))),
    ...Array.from(inventory?.values() ?? []).flatMap(i =>
      i.vms.filter(v => !v.cluster).map(v => ({ kind: 'VM' as const, label: v.name, hint: `${v.namespace}${v.ip ? ` · ${v.ip}` : ''}`, path: vmPath(v.supervisorId, v.namespace, v.name) }))
    ),
  ];
  const results = rankEntries(entries, q);
  const withSearch: PaletteEntry[] = q.trim()
    ? [...results, { kind: 'Search', label: `Search the fleet for "${q.trim()}"`, path: `${SEARCH_ROUTE}?q=${encodeURIComponent(q.trim())}` }]
    : results;
  const go = (e?: PaletteEntry) => {
    if (!e) return;
    setOpen(false);
    history.push(e.path);
  };
  return (
    <Dialog open onClose={() => setOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { position: 'absolute', top: '12%' } }}>
      <Box sx={{ p: 1.5 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder="Jump to a page, cluster, VM or namespace…"
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel(s => Math.min(s + 1, withSearch.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel(s => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              go(withSearch[sel]);
            }
          }}
        />
        <Box sx={{ mt: 1, maxHeight: 360, overflowY: 'auto' }}>
          {withSearch.map((e, i) => (
            <Box
              key={`${e.kind}-${e.path}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => go(e)}
              sx={{ display: 'flex', gap: 1.5, alignItems: 'baseline', px: 1.25, py: 0.75, borderRadius: 1, cursor: 'pointer', bgcolor: i === sel ? 'action.selected' : 'transparent' }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 72 }}>
                {e.kind}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {e.label}
              </Typography>
              {e.hint && (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {e.hint}
                </Typography>
              )}
            </Box>
          ))}
          {!withSearch.length && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              Nothing matches.
            </Typography>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          ↑ ↓ to move, Enter to open, Esc to close. Ctrl+K (⌘K) opens this on any VKS fleet page.
        </Typography>
      </Box>
    </Dialog>
  );
}
