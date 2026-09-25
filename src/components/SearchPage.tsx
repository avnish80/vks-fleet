import { SectionBox, SimpleTable, StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, TextField, Typography } from '@mui/material';
import React from 'react';
import { Link, useHistory, useLocation } from 'react-router-dom';
import { headlampClient } from '../api/headlampClient';
import { parseQuery, searchCluster, SearchHit, searchSupervisor } from '../search';
import { usePluginConfig } from '../settings/store';
import { useFleet } from '../useFleet';
import { useWorkloadHealth } from '../useWorkload';

export const SEARCH_PATH = '/vks-fleet/search';

export function SearchPage() {
  const config = usePluginConfig();
  const { results } = useFleet(config.supervisors, config.refreshSeconds);
  const clusters = React.useMemo(() => (results ?? []).flatMap(r => r.clusters), [results]);
  const workload = useWorkloadHealth(clusters, config.refreshSeconds);
  const location = useLocation();
  const history = useHistory();
  const initial = new URLSearchParams(location.search).get('q') ?? '';
  const [text, setText] = React.useState(initial);
  const [query, setQuery] = React.useState(initial);
  const [live, setLive] = React.useState<{ hits: SearchHit[]; errors: string[]; running: boolean }>({ hits: [], errors: [], running: false });

  // Debounce typing, and keep the query in the URL so searches can be shared.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(text.trim());
      history.replace(`${SEARCH_PATH}${text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''}`);
    }, 400);
    return () => window.clearTimeout(t);
  }, [text]);

  const targets = clusters
    .map(c => ({ cluster: c, contextName: workload.byKey.get(c.key)?.contextName }))
    .filter((t): t is { cluster: typeof clusters[number]; contextName: string } => !!t.contextName);
  const targetKey = targets.map(t => `${t.cluster.key}=${t.contextName}`).join('|');

  React.useEffect(() => {
    if (query.length < 2) {
      setLive({ hits: [], errors: [], running: false });
      return;
    }
    let cancelled = false;
    const q = parseQuery(query);
    setLive(prev => ({ ...prev, running: true }));
    Promise.all(targets.map(t => searchCluster(headlampClient(t.contextName), t.cluster, t.contextName, q))).then(all => {
      if (cancelled) return;
      setLive({
        hits: all.flatMap(a => a.hits),
        errors: all.flatMap((a, i) => a.errors.map(e => `${targets[i].cluster.name}: ${e}`)),
        running: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [query, targetKey]);

  const q = parseQuery(query);
  const supervisorHits = query.length >= 2 ? searchSupervisor(clusters, q) : [];
  const hits = [...supervisorHits, ...live.hits];
  const notSignedIn = clusters.filter(c => !workload.byKey.get(c.key)?.contextName);

  return (
    <SectionBox title="Search the fleet">
      <TextField
        autoFocus
        fullWidth
        label="Name, label (app=web), IP address or image; add kind:pod to narrow"
        value={text}
        onChange={e => setText(e.target.value)}
        sx={{ mb: 2 }}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Searches clusters and machines on {config.supervisors.length === 1 ? 'the Supervisor' : 'every Supervisor'}, and pods,
        workloads, services, ingresses, volumes, namespaces and nodes in {targets.length} signed-in cluster
        {targets.length === 1 ? '' : 's'}.
        {notSignedIn.length ? ` Not searched inside: ${notSignedIn.map(c => c.name).join(', ')} (not signed in).` : ''}
      </Typography>
      {live.errors.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Some results may be missing: {live.errors.slice(0, 4).join('; ')}
          {live.errors.length > 4 ? '; …' : ''}
        </Alert>
      )}
      {query.length >= 2 && (
        <Typography sx={{ mb: 1 }}>
          {live.running ? 'Searching…' : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
        </Typography>
      )}
      {hits.length > 0 && (
        <SimpleTable
          columns={[
            { label: 'Kind', getter: (h: SearchHit) => h.kind },
            { label: 'Name', getter: (h: SearchHit) => <Link to={h.path}>{h.name}</Link> },
            { label: 'Namespace', getter: (h: SearchHit) => h.namespace ?? '—' },
            { label: 'Cluster', getter: (h: SearchHit) => h.clusterName },
            {
              label: 'Found on',
              getter: (h: SearchHit) => <StatusLabel status="">{h.where === 'supervisor' ? 'Supervisor' : 'Inside cluster'}</StatusLabel>,
            },
            { label: 'Matched', getter: (h: SearchHit) => h.match },
          ]}
          data={hits}
        />
      )}
      {query.length >= 2 && !live.running && hits.length === 0 && (
        <Box sx={{ py: 2 }}>
          <Typography color="text.secondary">Nothing found for "{query}".</Typography>
        </Box>
      )}
    </SectionBox>
  );
}
