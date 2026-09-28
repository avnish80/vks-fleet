import { Box, Tab, Tabs, Typography } from '@mui/material';
import React, { ReactNode } from 'react';
import { useHistory, useLocation } from 'react-router-dom';

export interface HubTab {
  label: string;
  path: string;
  render: () => ReactNode;
}

/**
 * A merged page: one header, tabs for what used to be separate pages. Each
 * tab keeps its own route, so every existing link still lands on the right
 * tab; a detail page underneath a tab (a VM, a machine) keeps that tab lit.
 */
export function Hub({ title, blurb, tabs, children }: { title: string; blurb: string; tabs: HubTab[]; children?: ReactNode }) {
  const location = useLocation();
  const history = useHistory();
  const active = tabs.find(t => location.pathname === t.path || location.pathname.startsWith(`${t.path}/`)) ?? tabs[0];
  return (
    <Box>
      <Box sx={{ px: 2, pt: 1.5 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {blurb}
        </Typography>
        <Tabs value={active.path} onChange={(_e: unknown, v: string) => history.push(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}>
          {tabs.map(t => (
            <Tab key={t.path} label={t.label} value={t.path} sx={{ textTransform: 'none', fontWeight: 600 }} />
          ))}
        </Tabs>
      </Box>
      {children ?? active.render()}
    </Box>
  );
}
