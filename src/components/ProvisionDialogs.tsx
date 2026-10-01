import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, TextField, Typography } from '@mui/material';
import React from 'react';
import { ActionPlan } from '../actions';
import { supervisorClient, supervisorWriter } from '../api/headlampClient';
import { useFleetData } from '../fleetContext';
import { classSize, quotaLines } from '../headroom';
import { configuredByNamespace } from '../limits';
import { clusterDelta, clusterManifest, createPlan, impact, ImpactRow, PoolInput, toYaml, vmManifests } from '../provision';
import { download } from '../report';
import { compareVersions } from '../packages';
import { FleetCluster, SupervisorResult } from '../types';
import { ActionDialog } from './ActionDialog';

interface Props {
  r: SupervisorResult;
  namespace: string;
  onClose: () => void;
}

function useNamespaceContext(r: SupervisorResult, namespace: string) {
  const { all, inventoryAll, limitsAll, canWrite, refresh } = useFleetData();
  const inv = inventoryAll?.get(r.supervisor.id);
  const classes = (r.vmClasses ?? []).filter(c => c.namespace === namespace).sort((a, b) => (a.cpus ?? 0) - (b.cpus ?? 0) || (a.memoryBytes ?? 0) - (b.memoryBytes ?? 0));
  const storageClasses = Array.from(new Set([...(inv?.quotas ?? []).filter(q => q.namespace === namespace).map(q => q.policy), ...(limitsAll.get(namespace)?.storage ?? []).map(s => s.storageClass)])).filter(Boolean);
  const configured = configuredByNamespace(all ?? [], inventoryAll).get(namespace);
  const quota = quotaLines(r.clusters.find(c => c.namespace === namespace)?.quota);
  return { inv, classes, storageClasses, configured, limits: limitsAll.get(namespace), quota, writable: canWrite(r.supervisor.id), refresh };
}

function ImpactTable({ rows, unknown }: { rows: ImpactRow[]; unknown?: string[] }) {
  return (
    <Box>
      <Typography sx={{ fontWeight: 600, mb: 0.5 }}>Effect on the namespace</Typography>
      <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' }}>
        <thead>
          <tr>
            {['', 'Now', 'After', 'Limit'].map(h => (
              <Box component="th" key={h} sx={{ textAlign: 'left', p: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                {h}
              </Box>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.resource} title={r.note}>
              <Box component="td" sx={{ p: 0.5 }}>{r.resource}</Box>
              <Box component="td" sx={{ p: 0.5 }}>{r.before}</Box>
              <Box component="td" sx={{ p: 0.5 }}>
                {r.status === 'ok' || r.status === 'na' ? r.after : <StatusLabel status={r.status === 'over' ? 'error' : 'warning'}>{r.after}</StatusLabel>}
              </Box>
              <Box component="td" sx={{ p: 0.5 }}>{r.limit}</Box>
            </tr>
          ))}
        </tbody>
      </Box>
      {unknown?.length ? (
        <Typography variant="caption" color="text.secondary">
          Not counted (VM class size unknown): {unknown.join(', ')}.
        </Typography>
      ) : null}
    </Box>
  );
}

function Outputs({ docs, fileName, plan, writable, onCreate }: { docs: any[]; fileName: string; plan: ActionPlan; writable: boolean; onCreate: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const yaml = toYaml(docs);
  return (
    <>
      <Button
        onClick={() => {
          navigator.clipboard?.writeText(yaml);
          setCopied(true);
        }}
      >
        {copied ? 'Copied' : 'Copy YAML'}
      </Button>
      <Button onClick={() => download(fileName, yaml, 'application/yaml')}>Download YAML</Button>
      {writable && (
        <Button variant="contained" onClick={onCreate} disabled={plan.checks.some(c => c.level === 'block')}>
          Create…
        </Button>
      )}
    </>
  );
}

/* ---------------- New VM ---------------- */

export function NewVmDialog({ r, namespace, onClose }: Props) {
  const ctx = useNamespaceContext(r, namespace);
  const images = (ctx.inv?.images ?? []).filter(i => i.ready && (i.kind === 'ClusterVirtualMachineImage' || i.namespace === namespace));
  const networks = (ctx.inv?.subnets ?? []).filter(s => s.namespace === namespace);
  const [name, setName] = React.useState('');
  const [className, setClassName] = React.useState(ctx.classes[0]?.name ?? '');
  const [image, setImage] = React.useState(images[0]?.name ?? '');
  const [storageClass, setStorageClass] = React.useState(ctx.storageClasses[0] ?? '');
  const [network, setNetwork] = React.useState('');
  const [sshKey, setSshKey] = React.useState('');
  const [user, setUser] = React.useState('vmware');
  const [powerOn, setPowerOn] = React.useState(true);
  const [creating, setCreating] = React.useState<ActionPlan | null>(null);

  const img = images.find(i => i.name === image);
  const net = networks.find(n => `${n.kind}/${n.name}` === network);
  const docs = vmManifests({
    namespace,
    name: name || 'new-vm',
    className,
    image,
    imageKind: img?.kind ?? 'ClusterVirtualMachineImage',
    storageClass: storageClass || undefined,
    network: net ? { kind: net.kind, name: net.name } : undefined,
    sshKey,
    user,
    powerOn,
  });
  const size = classSize(r.vmClasses ?? [], namespace, className);
  const delta = { cpus: powerOn ? size?.cpus ?? 0 : 0, memoryBytes: powerOn ? size?.memoryBytes ?? 0 : 0, reservedBytes: size?.reserved && powerOn ? size.memoryBytes ?? 0 : 0 };
  const eff = impact(delta, ctx.configured, ctx.limits, ctx.quota);
  const checks = [
    ...(!className ? [{ level: 'block' as const, text: 'No VM class is available in this namespace.' }] : []),
    ...(!image ? [{ level: 'block' as const, text: 'No VM image is available to this namespace.' }] : []),
    ...(sshKey && !/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-)/.test(sshKey.trim()) ? [{ level: 'warn' as const, text: "The SSH key doesn't look like a public key (ssh-ed25519 …, ssh-rsa …)." }] : []),
    ...eff.checks,
  ];
  const plan = createPlan('VM', docs, name, namespace, checks, (ctx.inv?.vms ?? []).filter(v => v.namespace === namespace).map(v => v.name));

  if (creating) {
    return <ActionDialog plan={creating} writer={supervisorWriter(r.supervisor)} onClose={onClose} onApplied={() => ctx.refresh()} />;
  }
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New VM in {namespace}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2, pt: 1 }}>
          <TextField size="small" label="Name" value={name} onChange={e => setName(e.target.value.trim().toLowerCase())} autoFocus />
          <TextField select size="small" label="VM class" value={className} onChange={e => setClassName(e.target.value)}>
            {ctx.classes.map(c => (
              <MenuItem key={c.name} value={c.name}>
                {c.name}
                {c.cpus ? ` (${c.cpus} vCPU, ${Math.round((c.memoryBytes ?? 0) / 2 ** 30)} GiB${c.reserved ? ', guaranteed' : ''})` : ''}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Image" value={image} onChange={e => setImage(e.target.value)}>
            {images.map(i => (
              <MenuItem key={`${i.kind}/${i.name}`} value={i.name}>
                {i.displayName}
                {i.version ? ` ${i.version}` : ''}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Storage class" value={storageClass} onChange={e => setStorageClass(e.target.value)}>
            {ctx.storageClasses.map(s => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Network" value={network} onChange={e => setNetwork(e.target.value)}>
            <MenuItem value="">Namespace default</MenuItem>
            {networks.map(n => (
              <MenuItem key={`${n.kind}/${n.name}`} value={`${n.kind}/${n.name}`}>
                {n.name} ({n.kind === 'SubnetSet' ? 'subnet set' : 'subnet'}{n.accessMode ? `, ${n.accessMode}` : ''})
              </MenuItem>
            ))}
          </TextField>
          <FormControlLabel control={<Checkbox checked={powerOn} onChange={e => setPowerOn(e.target.checked)} />} label="Power on" />
          <TextField size="small" label="User (cloud-init)" value={user} onChange={e => setUser(e.target.value.trim())} />
          <TextField size="small" label="SSH public key (optional)" value={sshKey} onChange={e => setSshKey(e.target.value)} placeholder="ssh-ed25519 AAAA… you@host" sx={{ gridColumn: '1 / -1' }} />
        </Box>
        <Box sx={{ mt: 2 }}>
          <ImpactTable rows={eff.rows} unknown={size ? [] : [className || 'no class']} />
        </Box>
        {plan.checks
          .filter(c => c.level !== 'ok')
          .map((c, i) => (
            <Alert key={i} severity={c.level === 'block' ? 'error' : 'warning'} sx={{ mt: 1 }}>
              {c.text}
            </Alert>
          ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Outputs docs={docs} fileName={`${name || 'new-vm'}.yaml`} plan={plan} writable={ctx.writable} onCreate={() => setCreating(plan)} />
      </DialogActions>
    </Dialog>
  );
}

/* ---------------- New cluster ---------------- */

export function NewClusterDialog({ r, namespace, onClose }: Props) {
  const ctx = useNamespaceContext(r, namespace);
  const templates: FleetCluster[] = [...r.clusters.filter(c => c.namespace === namespace), ...r.clusters.filter(c => c.namespace !== namespace)];
  const releases = [...(r.releases ?? [])].sort((a, b) => compareVersions(b, a));
  const [name, setName] = React.useState('');
  const [templateKey, setTemplateKey] = React.useState(templates[0]?.key ?? '');
  const [template, setTemplate] = React.useState<any>(undefined);
  const [templateError, setTemplateError] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(releases[0] ?? '');
  const [cp, setCp] = React.useState<1 | 3>(1);
  const [cpClass, setCpClass] = React.useState('');
  const [clusterClass, setClusterClass] = React.useState((r.classes ?? [])[0] ?? '');
  const [storageClass, setStorageClass] = React.useState(ctx.storageClasses[0] ?? '');
  const [pools, setPools] = React.useState<PoolInput[]>([{ name: 'np-1', replicas: 2, vmClass: ctx.classes[Math.min(1, ctx.classes.length - 1)]?.name ?? '' }]);
  const [creating, setCreating] = React.useState<ActionPlan | null>(null);

  // The template Cluster, read live so its class variables are exactly what works.
  React.useEffect(() => {
    const t = templates.find(c => c.key === templateKey);
    setTemplate(undefined);
    setTemplateError(null);
    if (!t) return;
    supervisorClient(r.supervisor)
      .get<any>(`/apis/cluster.x-k8s.io/v1beta1/namespaces/${encodeURIComponent(t.namespace)}/clusters/${encodeURIComponent(t.name)}`)
      .then(o => {
        setTemplate(o);
        const vars = o?.spec?.topology?.variables ?? [];
        setCpClass(vars.find((v: any) => v?.name === 'vmClass')?.value ?? '');
        setCp((o?.spec?.topology?.controlPlane?.replicas === 3 ? 3 : 1) as 1 | 3);
      })
      .catch(err => setTemplateError(String(err?.message ?? err)));
  }, [templateKey]);

  const input = {
    namespace,
    name: name || 'new-cluster',
    version,
    controlPlaneReplicas: cp,
    pools,
    template: templateKey ? template : undefined,
    clusterClass: templateKey ? undefined : clusterClass,
    classNamespace: templateKey ? undefined : 'vmware-system-vks-public',
    controlPlaneClass: cpClass || undefined,
    storageClass: templateKey ? undefined : storageClass || undefined,
  };
  const doc = clusterManifest(input);
  const d = clusterDelta(input, r.vmClasses ?? []);
  const eff = impact(d, ctx.configured, ctx.limits, ctx.quota);
  const poolIssue = pools.some(p => !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(p.name) || p.replicas < 0) || new Set(pools.map(p => p.name)).size !== pools.length;
  const checks = [
    ...(templateKey && !template ? [{ level: 'block' as const, text: templateError ? `Couldn't read the template cluster: ${templateError}` : 'Reading the template cluster…' }] : []),
    ...(!version ? [{ level: 'block' as const, text: 'No Kubernetes release is available on this Supervisor.' }] : []),
    ...(poolIssue ? [{ level: 'block' as const, text: 'Node pool names must be unique DNS labels, with zero or more nodes.' }] : []),
    ...pools.filter(p => !ctx.classes.some(c => c.name === p.vmClass)).map(p => ({ level: 'warn' as const, text: `VM class ${p.vmClass || '(none)'} for ${p.name} isn't assigned to ${namespace}.` })),
    ...(templateKey && template && template.metadata?.namespace !== namespace ? [{ level: 'warn' as const, text: `The template is in ${template.metadata.namespace}; check its classes and storage class are available in ${namespace}.` }] : []),
    ...eff.checks,
  ];
  const plan = createPlan('cluster', [doc], name, namespace, checks, r.clusters.filter(c => c.namespace === namespace).map(c => c.name));

  if (creating) {
    return <ActionDialog plan={creating} writer={supervisorWriter(r.supervisor)} onClose={onClose} onApplied={() => ctx.refresh()} />;
  }
  const setPool = (i: number, p: Partial<PoolInput>) => setPools(pools.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>New cluster in {namespace}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2, pt: 1 }}>
          <TextField size="small" label="Name" value={name} onChange={e => setName(e.target.value.trim().toLowerCase())} autoFocus />
          <TextField select size="small" label="Start from" value={templateKey} onChange={e => setTemplateKey(e.target.value)} helperText="Copying a working cluster keeps its class variables right">
            {templates.map(c => (
              <MenuItem key={c.key} value={c.key}>
                Copy of {c.name} ({c.namespace})
              </MenuItem>
            ))}
            <MenuItem value="">From scratch</MenuItem>
          </TextField>
          <TextField select size="small" label="Kubernetes release" value={version} onChange={e => setVersion(e.target.value)}>
            {releases.map(v => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </TextField>
          <TextField select size="small" label="Control plane" value={cp} onChange={e => setCp(Number(e.target.value) as 1 | 3)}>
            <MenuItem value={1}>1 node</MenuItem>
            <MenuItem value={3}>3 nodes (highly available)</MenuItem>
          </TextField>
          <TextField select size="small" label="Control-plane VM class" value={cpClass} onChange={e => setCpClass(e.target.value)}>
            {ctx.classes.map(c => (
              <MenuItem key={c.name} value={c.name}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          {!templateKey && (
            <>
              <TextField select size="small" label="Cluster class" value={clusterClass} onChange={e => setClusterClass(e.target.value)}>
                {(r.classes ?? []).map(c => (
                  <MenuItem key={c} value={c}>
                    {c}
                  </MenuItem>
                ))}
              </TextField>
              <TextField select size="small" label="Storage class" value={storageClass} onChange={e => setStorageClass(e.target.value)}>
                {ctx.storageClasses.map(s => (
                  <MenuItem key={s} value={s}>
                    {s}
                  </MenuItem>
                ))}
              </TextField>
            </>
          )}
        </Box>
        <Typography sx={{ fontWeight: 600, mt: 2, mb: 1 }}>Node pools</Typography>
        {pools.map((p, i) => (
          <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'center' }}>
            <TextField size="small" label="Pool" value={p.name} onChange={e => setPool(i, { name: e.target.value.trim().toLowerCase() })} sx={{ width: 140 }} />
            <TextField size="small" type="number" label="Nodes" value={p.replicas} onChange={e => setPool(i, { replicas: Math.max(0, Number(e.target.value)) })} sx={{ width: 100 }} />
            <TextField select size="small" label="VM class" value={p.vmClass} onChange={e => setPool(i, { vmClass: e.target.value })} sx={{ minWidth: 220 }}>
              {ctx.classes.map(c => (
                <MenuItem key={c.name} value={c.name}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
            {pools.length > 1 && (
              <Button size="small" onClick={() => setPools(pools.filter((_, k) => k !== i))}>
                Remove
              </Button>
            )}
          </Box>
        ))}
        <Button size="small" onClick={() => setPools([...pools, { name: `np-${pools.length + 1}`, replicas: 1, vmClass: pools[pools.length - 1]?.vmClass ?? '' }])}>
          Add pool
        </Button>
        <Box sx={{ mt: 2 }}>
          <ImpactTable rows={eff.rows} unknown={d.unknown} />
        </Box>
        {plan.checks
          .filter(c => c.level !== 'ok')
          .map((c, i) => (
            <Alert key={i} severity={c.level === 'block' ? 'error' : 'warning'} sx={{ mt: 1 }}>
              {c.text}
            </Alert>
          ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Outputs docs={[doc]} fileName={`${name || 'new-cluster'}.yaml`} plan={plan} writable={ctx.writable} onCreate={() => setCreating(plan)} />
      </DialogActions>
    </Dialog>
  );
}
