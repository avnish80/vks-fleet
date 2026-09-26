import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import React from 'react';
import { headlampClient, headlampWriter } from '../api/headlampClient';
import { DEFAULT_KUBE_BENCH_IMAGE, SCAN_NS } from '../nodeScan';
import { runNodeScan, ScanStep } from '../nodeScanRunner';
import { settingsStore } from '../settings/store';

/** Runs kube-bench in one cluster: dry run first, then the scan, with each step shown as it happens. */
export function NodeScanDialog({
  cluster,
  contextName,
  image: configured,
  onClose,
  onDone,
}: {
  cluster: string;
  contextName: string;
  image?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [image, setImage] = React.useState(configured ?? DEFAULT_KUBE_BENCH_IMAGE);
  const [steps, setSteps] = React.useState<ScanStep[]>([]);
  const [phase, setPhase] = React.useState<'idle' | 'checking' | 'checked' | 'running' | 'done'>('idle');
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const go = async (dryRun: boolean) => {
    if (image !== (configured ?? DEFAULT_KUBE_BENCH_IMAGE)) settingsStore.update({ nodeScanImage: image });
    setPhase(dryRun ? 'checking' : 'running');
    setSteps([]);
    const r = await runNodeScan(headlampClient(contextName), headlampWriter(contextName), { image, dryRun }, setSteps);
    setResult(r);
    setPhase(dryRun ? (r.ok ? 'checked' : 'idle') : 'done');
    if (!dryRun) onDone();
  };

  return (
    <Dialog open onClose={phase === 'running' ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Node scan of {cluster}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: 1 }}>
          <Typography variant="body2">
            Runs <b>kube-bench</b> (the open-source CIS scanner) on one control-plane node and one worker, for what the API can't show:
            file permissions and ownership. It creates the <code>{SCAN_NS}</code> namespace (labelled privileged, because kube-bench reads
            host files through host PID and read-only host paths) and two short-lived Jobs. Results are kept in a ConfigMap there;
            the Jobs are deleted afterwards. Takes a minute or two.
          </Typography>
          <TextField
            size="small"
            label="kube-bench image"
            value={image}
            onChange={e => setImage(e.target.value)}
            disabled={phase === 'running'}
            helperText="Pull it from your own registry on air-gapped sites (and pin a version)."
          />
          {steps.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {steps.map((s, i) => (
                <li key={i}>
                  <Typography variant="body2" color={s.state === 'failed' ? 'error' : s.state === 'running' ? 'text.primary' : 'text.secondary'}>
                    {s.state === 'running' ? '… ' : s.state === 'done' ? '✓ ' : s.state === 'failed' ? '✗ ' : '– '}
                    {s.text}
                  </Typography>
                </li>
              ))}
            </Box>
          )}
          {result && <Alert severity={result.ok ? 'success' : 'error'}>{result.message}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={phase === 'running'}>
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        {phase !== 'done' && (
          <Button onClick={() => go(true)} disabled={phase === 'checking' || phase === 'running'}>
            {phase === 'checking' ? 'Checking…' : 'Dry run'}
          </Button>
        )}
        {phase !== 'done' && (
          <Button variant="contained" onClick={() => go(false)} disabled={phase !== 'checked'}>
            {phase === 'running' ? 'Scanning…' : 'Run scan'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
