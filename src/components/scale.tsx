import { SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper, TextField, Typography } from '@mui/material';
import React, { ReactNode } from 'react';

/**
 * Pages at fleet scale: "summary first, details on demand".
 *  - PagedTable: a filter box and "Show more" once a table is long.
 *  - ClusterSections: one collapsed row per cluster with its counts; expanding
 *    shows the first rows; "Show all" opens the full table in a dialog.
 */

export function PagedTable<T>({ columns, data, pageSize = 25, filterText, emptyMessage }: { columns: any[]; data: T[]; pageSize?: number; filterText?: (row: T) => string; emptyMessage?: string }) {
  const [q, setQ] = React.useState('');
  const [shown, setShown] = React.useState(pageSize);
  const needle = q.trim().toLowerCase();
  const rows = needle && filterText ? data.filter(r => filterText(r).toLowerCase().includes(needle)) : data;
  const long = data.length > pageSize;
  return (
    <Box>
      {long && filterText && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
          <TextField size="small" placeholder="Filter…" value={q} onChange={e => { setQ(e.target.value); setShown(pageSize); }} sx={{ width: 260 }} />
          <Typography variant="caption" color="text.secondary">
            {rows.length === data.length ? `${data.length} rows` : `${rows.length} of ${data.length} rows`}
          </Typography>
        </Box>
      )}
      {rows.length ? <SimpleTable columns={columns} data={rows.slice(0, shown)} /> : <Typography color="text.secondary">{emptyMessage ?? (needle ? 'Nothing matches.' : 'Nothing here.')}</Typography>}
      {rows.length > shown && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
          <Button size="small" onClick={() => setShown(shown + pageSize)}>
            Show {Math.min(pageSize, rows.length - shown)} more ({rows.length - shown} left)
          </Button>
          <Button size="small" onClick={() => setShown(rows.length)}>
            Show all
          </Button>
        </Box>
      )}
    </Box>
  );
}

export interface ClusterSection {
  key: string;
  title: string;
  subtitle?: string;
  /** Status chips, rendered by the caller (StatusLabel etc.). */
  chips?: ReactNode;
  /** Rows in this section; the first few show inline, all of them in the dialog. */
  count: number;
  renderPreview: (limit: number) => ReactNode;
  renderAll?: () => ReactNode;
  /** Sort order: attention first. */
  weight?: number;
}

export function ClusterSections({ sections, previewRows = 10, openFirst }: { sections: ClusterSection[]; previewRows?: number; openFirst?: boolean }) {
  const ordered = [...sections].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.title.localeCompare(b.title));
  const [open, setOpen] = React.useState<Set<string>>(() => new Set(sections.length === 1 || openFirst ? [ordered[0]?.key].filter(Boolean) : []));
  const [dialog, setDialog] = React.useState<ClusterSection | null>(null);
  const toggle = (k: string) => setOpen(prev => {
    const next = new Set(prev);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      {ordered.map(s => {
        const isOpen = open.has(s.key);
        return (
          <Paper key={s.key} variant="outlined" sx={{ borderRadius: 2 }}>
            <Box
              role="button"
              onClick={() => toggle(s.key)}
              sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, cursor: 'pointer', flexWrap: 'wrap', '&:hover': { bgcolor: 'action.hover' } }}
            >
              <Typography sx={{ width: 14, color: 'text.secondary', fontFamily: 'monospace' }}>{isOpen ? '▾' : '▸'}</Typography>
              <Typography sx={{ fontWeight: 700 }}>{s.title}</Typography>
              {s.subtitle && (
                <Typography variant="body2" color="text.secondary">
                  {s.subtitle}
                </Typography>
              )}
              <Box sx={{ flex: 1 }} />
              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>{s.chips}</Box>
            </Box>
            {isOpen && (
              <Box sx={{ px: 1.5, pb: 1.5 }}>
                {s.renderPreview(previewRows)}
                {s.count > previewRows && s.renderAll && (
                  <Button size="small" sx={{ mt: 1 }} onClick={() => setDialog(s)}>
                    Show all {s.count}…
                  </Button>
                )}
              </Box>
            )}
          </Paper>
        );
      })}
      {dialog && dialog.renderAll && (
        <Dialog open onClose={() => setDialog(null)} maxWidth="lg" fullWidth>
          <DialogTitle>{dialog.title}</DialogTitle>
          <DialogContent>{dialog.renderAll()}</DialogContent>
          <DialogActions>
            <Button onClick={() => setDialog(null)}>Close</Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
