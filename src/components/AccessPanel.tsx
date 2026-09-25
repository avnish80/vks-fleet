import { Loader, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Box, Button, FormControlLabel, Switch, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { connectInstructions, fetchAccess } from '../access';
import { headlampClient } from '../api/headlampClient';
import { clusterPath } from '../routes';
import { usePluginConfig } from '../settings/store';
import { AccessEntry, FleetCluster, SupervisorResult } from '../types';
import { useFleet } from '../useFleet';
import { usePolling } from '../usePolling';

function CopyText({ text, label }: { text: string; label: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button
      size="small"
      variant="outlined"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 2000);
        } catch {
          // Clipboard blocked; the text is shown for manual copying.
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Who can reach one Supervisor namespace, and how a developer connects to its clusters. */
export function NamespaceAccess({
  supervisorContext,
  namespace,
  clusters,
  showSystemDefault = false,
}: {
  supervisorContext: string;
  namespace: string;
  clusters: FleetCluster[];
  showSystemDefault?: boolean;
}) {
  const [showSystem, setShowSystem] = React.useState(showSystemDefault);
  const [shown, setShown] = React.useState<string | null>(null);
  const access = usePolling(`${supervisorContext}/${namespace}`, () => fetchAccess(headlampClient(supervisorContext), namespace), 300);
  const entries = (access?.entries ?? []).filter(e => showSystem || !e.system);
  return (
    <Box>
      {!access ? (
        <Typography>Loading…</Typography>
      ) : access.error ? (
        <Typography color="text.secondary">Couldn't read who has access: {access.error}</Typography>
      ) : (
        <>
          <FormControlLabel control={<Switch checked={showSystem} onChange={e => setShowSystem(e.target.checked)} />} label="Include system accounts" />
          {entries.length === 0 ? (
            <Typography color="text.secondary">No people or groups bound to this namespace.</Typography>
          ) : (
            <SimpleTable
              columns={[
                { label: 'Who', getter: (e: AccessEntry) => e.subject },
                { label: 'Type', getter: (e: AccessEntry) => e.subjectKind },
                { label: 'Role', getter: (e: AccessEntry) => e.role },
                { label: 'Binding', getter: (e: AccessEntry) => e.binding },
              ]}
              data={entries}
            />
          )}
        </>
      )}
      <Typography sx={{ fontWeight: 600, mt: 2, mb: 1 }}>Connection instructions for developers</Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {clusters.map(c => (
          <Box key={c.key} sx={{ display: 'flex', gap: 1 }}>
            <CopyText text={connectInstructions(c, supervisorContext)} label={`Copy for ${c.name}`} />
            <Button size="small" onClick={() => setShown(shown === c.key ? null : c.key)}>
              {shown === c.key ? 'Hide' : 'Show'}
            </Button>
          </Box>
        ))}
      </Box>
      {shown && (
        <Box component="pre" sx={{ mt: 1, p: 1.5, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', fontSize: '0.8rem' }}>
          {connectInstructions(clusters.find(c => c.key === shown)!, supervisorContext)}
        </Box>
      )}
    </Box>
  );
}

export function AccessPage() {
  const config = usePluginConfig();
  const { results } = useFleet(config.supervisors, config.refreshSeconds);
  if (results === null) return <Loader title="Loading namespaces" />;
  const spaces: Array<{ r: SupervisorResult; ns: string; clusters: FleetCluster[] }> = results.flatMap(r => {
    const byNs = new Map<string, FleetCluster[]>();
    for (const c of r.clusters) byNs.set(c.namespace, [...(byNs.get(c.namespace) ?? []), c]);
    return Array.from(byNs.entries()).map(([ns, cs]) => ({ r, ns, clusters: cs }));
  });
  return (
    <>
      <SectionBox title="Access">
        <Typography variant="body2" color="text.secondary">
          Who can reach each Supervisor namespace (and so its VKS clusters), from the namespace's role bindings. VCFA and
          vSphere grant these through project and namespace permissions; change them there. Each cluster has
          ready-to-send connection instructions.
        </Typography>
      </SectionBox>
      {spaces.map(s => (
        <SectionBox key={`${s.r.supervisor.id}/${s.ns}`} title={`${s.clusters[0].tenantName}: ${s.ns}`}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Clusters:{' '}
            {s.clusters.map((c, i) => (
              <React.Fragment key={c.key}>
                {i ? ', ' : ''}
                <Link to={clusterPath(c)}>{c.name}</Link>
              </React.Fragment>
            ))}
          </Typography>
          <NamespaceAccess supervisorContext={s.r.supervisor.headlampCluster} namespace={s.ns} clusters={s.clusters} />
        </SectionBox>
      ))}
    </>
  );
}
