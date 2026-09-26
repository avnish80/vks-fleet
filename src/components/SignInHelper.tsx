import { Alert, Box, Button, Typography } from '@mui/material';
import React from 'react';
import { FleetCluster, SupervisorConfig, WorkloadHealth } from '../types';

/** The command that signs in to one VKS cluster, for the identity in use. */
export function clusterLoginCommand(c: FleetCluster, s: SupervisorConfig | undefined): string {
  if (s?.mode === 'vcfa') {
    return `# ${c.name}: download its kubeconfig from VCF Automation (the cluster's page), or with the VCF CLI:\nvcf cluster kubeconfig get ${c.name} --export-file ~/.kube/${c.name}.kubeconfig   # then merge it into ~/.kube/config`;
  }
  return `kubectl vsphere login --server=${s?.headlampCluster ?? '<supervisor>'} --vsphere-username <you@domain> --insecure-skip-tls-verify \\\n  --tanzu-kubernetes-cluster-namespace ${c.namespace} --tanzu-kubernetes-cluster-name ${c.name}`;
}

/**
 * Pages that read inside clusters show this when some can't be read:
 * which clusters, why, and the exact commands (one copy for all).
 */
export function SignInHelper({
  clusters,
  health,
  supervisors,
}: {
  clusters: FleetCluster[];
  health: Map<string, WorkloadHealth>;
  supervisors: SupervisorConfig[];
}) {
  const [copied, setCopied] = React.useState(false);
  const missing = clusters
    .map(c => ({ c, h: health.get(c.key) }))
    .filter(x => !x.h || x.h.status === 'no-context' || x.h.status === 'expired');
  if (!missing.length) return null;
  const sup = (c: FleetCluster) => supervisors.find(s => s.id === c.supervisorId);
  const commands = missing.map(({ c }) => clusterLoginCommand(c, sup(c))).join('\n\n') + '\n\ndocker restart headlamp   # or restart Headlamp however it runs, so it reloads the kubeconfig';
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {missing.length} cluster{missing.length === 1 ? " can't" : "s can't"} be read inside, so this page is incomplete:{' '}
        {missing.map(({ c, h }) => `${c.name} (${h?.status === 'expired' ? 'sign-in expired' : 'not signed in'})`).join(', ')}.
        Run on the machine where Headlamp reads its kubeconfig:
      </Typography>
      <Box component="pre" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, fontSize: '0.78rem', whiteSpace: 'pre-wrap', overflowX: 'auto' }}>
        {commands}
      </Box>
      <Button
        size="small"
        sx={{ mt: 1 }}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(commands);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard blocked; the commands are shown above.
          }
        }}
      >
        {copied ? 'Copied' : 'Copy all commands'}
      </Button>
      <Typography variant="caption" display="block" color="text.secondary">
        Cluster sign-ins last about 10 hours; the deployment's refresher (or a cron entry) keeps them fresh.
      </Typography>
    </Alert>
  );
}
