import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Button, Typography } from '@mui/material';
import React from 'react';
import { useFleetData } from '../fleetContext';
import { ALL_ORGS } from '../scope';

/**
 * Shown by pages that read inside VKS clusters when there's nothing to read:
 * the selected org has no clusters (it may have only VMs), or none are signed in.
 */
export function NoClusters({ title, what }: { title: string; what: string }) {
  const { org, orgs, setOrg } = useFleetData();
  const name = orgs.find(o => o.id === org)?.name;
  return (
    <SectionBox title={title}>
      <Typography sx={{ mb: 1 }}>
        {org !== ALL_ORGS
          ? `${name ?? 'This org'} has no VKS clusters, so there's no ${what} to show.`
          : `No VKS clusters found, so there's no ${what} to show.`}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        This page reads inside VKS clusters. {org !== ALL_ORGS ? "The org's VMs, networks and storage are on the Namespaces, VMs and Network pages." : ''}
      </Typography>
      {org !== ALL_ORGS && (
        <Button size="small" sx={{ mt: 1 }} onClick={() => setOrg(ALL_ORGS)}>
          Show all orgs
        </Button>
      )}
    </SectionBox>
  );
}
