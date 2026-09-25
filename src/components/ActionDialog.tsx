import { StatusLabel } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import React, { ReactNode } from 'react';
import {
  ActionPlan,
  blocked,
  CheckLevel,
  currentTimeout,
  scalePlan,
  TimeoutKind,
  timeoutPlan,
  upgradePlan,
} from '../actions';
import { headlampClient } from '../api/headlampClient';
import { upgradeKind, upgradeTargets } from '../releases';
import { usePolling } from '../usePolling';
import { describeError, statusOf, SupervisorWriter } from '../api/client';
import { FleetCluster, MachineInfo, NodePool } from '../types';

const LEVEL: Record<CheckLevel, { text: string; status: 'success' | 'warning' | 'error' }> = {
  ok: { text: 'OK', status: 'success' },
  warn: { text: 'Note', status: 'warning' },
  block: { text: 'Blocked', status: 'error' },
};

type DryRun = { state: 'running' } | { state: 'ok' } | { state: 'error'; message: string } | { state: 'skipped' };

/** Always keeps the Supervisor's own words: a 403 can be RBAC or an admission webhook. */
function explain(err: unknown): string {
  if (statusOf(err) === 409) return 'The cluster changed since this page loaded. Close this and try again.';
  const text = describeError(err);
  if (statusOf(err) === 403 && /admission webhook|denied the request/i.test(text)) {
    return `A Supervisor admission rule rejected it. ${text}`;
  }
  if (statusOf(err) === 403) return `Your account may not be allowed to make this change. ${text}`;
  return text;
}

async function runAll(plan: ActionPlan, writer: SupervisorWriter, reason: string, dryRun: boolean) {
  for (const req of plan.requests(reason)) {
    await writer.send(req, dryRun);
  }
}

export interface ActionDialogProps {
  plan: ActionPlan;
  writer: SupervisorWriter;
  onClose: () => void;
  /** Called after a successful apply, e.g. to refresh the view. */
  onApplied: (message: string) => void;
  /** Extra inputs shown above the checks (e.g. the node count for scaling). */
  children?: ReactNode;
  /** Shown under a rejected dry run, e.g. an alternative action to try. */
  rejectedHint?: ReactNode;
}

export function ActionDialog({ plan, writer, onClose, onApplied, children, rejectedHint }: ActionDialogProps) {
  const [reason, setReason] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [dry, setDry] = React.useState<DryRun>({ state: 'skipped' });
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const isBlocked = blocked(plan);

  // Preview with a server-side dry run whenever the planned change changes.
  React.useEffect(() => {
    if (isBlocked) {
      setDry({ state: 'skipped' });
      return;
    }
    let cancelled = false;
    setDry({ state: 'running' });
    runAll(plan, writer, 'dry run', true)
      .then(() => !cancelled && setDry({ state: 'ok' }))
      .catch(err => !cancelled && setDry({ state: 'error', message: explain(err) }));
    return () => {
      cancelled = true;
    };
    // plan.id captures everything that changes the requests.
  }, [plan.id, isBlocked]);

  const reasonOk = !plan.reasonRequired || reason.trim().length > 0;
  const confirmOk = !plan.confirmText || confirm.trim() === plan.confirmText;
  const canApply = !isBlocked && dry.state === 'ok' && reasonOk && confirmOk && !applying;

  async function apply() {
    setApplying(true);
    setApplyError(null);
    try {
      await runAll(plan, writer, reason, false);
      onApplied(`${plan.applyLabel}: done. The Supervisor is applying the change.`);
      onClose();
    } catch (err) {
      setApplyError(explain(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Dialog open onClose={applying ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{plan.title}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
          <Typography>{plan.summary}</Typography>
          {children}

          <Box component="ul" sx={{ m: 0, pl: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {plan.checks.map(c => (
              <Box component="li" key={c.text} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <StatusLabel status={LEVEL[c.level].status}>{LEVEL[c.level].text}</StatusLabel>
                <Typography variant="body2">{c.text}</Typography>
              </Box>
            ))}
          </Box>

          {dry.state === 'running' && <Alert severity="info">Checking the change with the Supervisor (dry run)…</Alert>}
          {dry.state === 'ok' && <Alert severity="success">The Supervisor accepted this change in a dry run.</Alert>}
          {dry.state === 'error' && (
            <Alert severity="error">
              The Supervisor would reject this change. {dry.message}
              {rejectedHint && <Box sx={{ mt: 1 }}>{rejectedHint}</Box>}
            </Alert>
          )}

          {!isBlocked && (
            <TextField
              label={plan.reasonRequired ? 'Reason (recorded on the cluster)' : 'Reason (optional, recorded on the cluster)'}
              value={reason}
              onChange={e => setReason(e.target.value)}
              required={plan.reasonRequired}
              size="small"
            />
          )}
          {!isBlocked && plan.confirmText && (
            <TextField
              label={`Type ${plan.confirmText} to confirm`}
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              size="small"
            />
          )}
          {applyError && <Alert severity="error">{applyError}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={applying}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={plan.confirmText ? 'error' : 'primary'}
          onClick={apply}
          disabled={!canApply}
        >
          {applying ? 'Applying…' : plan.applyLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ScaleDialog(props: {
  cluster: FleetCluster;
  pool: NodePool;
  writer: SupervisorWriter;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [text, setText] = React.useState(String(props.pool.desired ?? props.pool.ready));
  const replicas = Number(text);
  const plan = scalePlan(props.cluster, props.pool, text.trim() === '' ? NaN : replicas);
  return (
    <ActionDialog plan={plan} writer={props.writer} onClose={props.onClose} onApplied={props.onApplied}>
      <TextField
        label="Nodes"
        type="number"
        inputProps={{ min: 0 }}
        value={text}
        onChange={e => setText(e.target.value)}
        size="small"
        sx={{ maxWidth: 160 }}
      />
    </ActionDialog>
  );
}

/**
 * Sets or clears a pool's drain or volume-detach timeout. Opened as
 * "Unblock deletion" on a stuck machine (with the stage it's stuck in
 * pre-selected) or as "Timeouts" on a node pool.
 */
export function TimeoutDialog(props: {
  cluster: FleetCluster;
  pool: NodePool;
  initialKind?: TimeoutKind;
  /** Why the dialog was opened, e.g. what the machine is stuck on. */
  context?: string;
  writer: SupervisorWriter;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const [kind, setKind] = React.useState<TimeoutKind>(props.initialKind ?? 'drain');
  const existing = currentTimeout(props.pool, kind);
  const [clear, setClear] = React.useState(false);
  const [text, setText] = React.useState('60s');
  const plan = timeoutPlan(props.cluster, props.pool, kind, clear && existing ? null : text);
  return (
    <ActionDialog plan={plan} writer={props.writer} onClose={props.onClose} onApplied={props.onApplied}>
      {props.context && <Alert severity="info">{props.context}</Alert>}
      <TextField
        select
        size="small"
        label="Stage"
        value={kind}
        onChange={e => {
          setKind(e.target.value as TimeoutKind);
          setClear(false);
        }}
        sx={{ maxWidth: 360 }}
      >
        <MenuItem value="drain">Drain: pods that can't be evicted</MenuItem>
        <MenuItem value="volume">Volume detach: disks still attached</MenuItem>
      </TextField>
      <Typography variant="body2">Current timeout: {existing ?? 'none (waits indefinitely)'}</Typography>
      {existing && (
        <FormControlLabel
          control={<Checkbox checked={clear} onChange={e => setClear(e.target.checked)} />}
          label="Clear the timeout instead"
        />
      )}
      {!(clear && existing) && (
        <TextField
          label="Timeout (for example 60s, 5m, 1h)"
          value={text}
          onChange={e => setText(e.target.value)}
          size="small"
          sx={{ maxWidth: 260 }}
        />
      )}
    </ActionDialog>
  );
}

/** PodDisruptionBudgets that currently allow no disruptions (and protect at least one pod). */
async function blockingPdbs(contextName: string): Promise<{ names?: string[]; error?: string }> {
  try {
    const list = await headlampClient(contextName).get<{ items?: any[] }>('/apis/policy/v1/poddisruptionbudgets');
    const names = (list?.items ?? [])
      .filter(b => (b?.status?.disruptionsAllowed ?? 0) === 0 && (b?.status?.expectedPods ?? 0) > 0)
      .map(b => `${b?.metadata?.namespace}/${b?.metadata?.name}`);
    return { names };
  } catch (err) {
    return { error: describeError(err) };
  }
}

export function UpgradeDialog(props: {
  cluster: FleetCluster;
  available: string[];
  /** Headlamp context for the workload cluster, for the PodDisruptionBudget check. */
  contextName?: string;
  writer: SupervisorWriter;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const targets = upgradeTargets(props.cluster.kubernetesVersion, props.available);
  const [target, setTarget] = React.useState(targets[0] ?? '');
  const [moveClass, setMoveClass] = React.useState(false);
  const pdbs = usePolling(
    props.contextName ? `pdb/${props.contextName}` : null,
    () => blockingPdbs(props.contextName as string),
    60
  );
  const plan = upgradePlan(props.cluster, target, moveClass && props.cluster.classUpdate ? props.cluster.classUpdate : null, {
    available: props.available,
    blockingPdbs: pdbs?.names,
    pdbCheck: !props.contextName
      ? 'sign in to the cluster to check them.'
      : pdbs === null
      ? 'still checking…'
      : pdbs.error,
  });
  return (
    <ActionDialog plan={plan} writer={props.writer} onClose={props.onClose} onApplied={props.onApplied}>
      {targets.length === 0 ? (
        <Alert severity="info">
          No newer release in this minor or the next is available on the Supervisor for {props.cluster.kubernetesVersion}.
        </Alert>
      ) : (
        <TextField
          select
          size="small"
          label="Upgrade to"
          value={target}
          onChange={e => setTarget(e.target.value)}
          sx={{ maxWidth: 360 }}
        >
          {targets.map(v => (
            <MenuItem key={v} value={v}>
              {v} ({upgradeKind(props.cluster.kubernetesVersion, v) === 'minor' ? 'next minor' : 'patch'})
            </MenuItem>
          ))}
        </TextField>
      )}
      {props.cluster.classUpdate && (
        <FormControlLabel
          control={<Checkbox checked={moveClass} onChange={e => setMoveClass(e.target.checked)} />}
          label={`Also move from ${props.cluster.clusterClass} to ${props.cluster.classUpdate}`}
        />
      )}
      <details>
        <summary>
          <Typography variant="body2" component="span">
            Releases this Supervisor offers ({props.available.length})
          </Typography>
        </summary>
        <Typography variant="body2" sx={{ mt: 1, overflowWrap: 'anywhere' }}>
          {props.available.length ? [...props.available].sort().reverse().join(', ') : 'None could be read.'}
        </Typography>
      </details>
    </ActionDialog>
  );
}
