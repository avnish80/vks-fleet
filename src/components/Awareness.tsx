import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Alert, Box, Button, FormControlLabel, Switch, Typography } from '@mui/material';
import React from 'react';
import { Link } from 'react-router-dom';
import { diffSeen } from '../awareness';
import { Issue } from '../types';

/** What this browser saw last time, for "since your last visit". */
const seenStore = new ConfigStore<{ at?: string; issues?: Record<string, string>; notify?: boolean; notified?: string[] }>('vks-fleet-seen');
const useSeen = seenStore.useConfig();

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};


/** New and resolved issues since this browser last marked them as seen; plus desktop alerts for new critical ones. */
export function SinceLastVisit({ issues, ready }: { issues: Issue[]; ready: boolean }) {
  const seen = useSeen() ?? {};
  const actionable = issues.filter(i => i.severity !== 'info');
  const snapshot = () => Object.fromEntries(actionable.slice(0, 300).map(i => [i.id, i.title]));

  // First visit: remember the current state quietly.
  React.useEffect(() => {
    if (ready && !seen.at) seenStore.update({ at: new Date().toISOString(), issues: snapshot() });
  }, [ready, seen.at]);

  // Desktop notifications for critical issues not notified before (while this page is open).
  React.useEffect(() => {
    if (!ready || !seen.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const already = new Set(seen.notified ?? []);
    const fresh = issues.filter(i => i.severity === 'critical' && !already.has(i.id));
    for (const i of fresh.slice(0, 3)) {
      try {
        new Notification(`VKS fleet: ${i.title}`, { body: i.cause.slice(0, 180), tag: i.id });
      } catch {
        // Some browsers only allow notifications from a service worker; skip quietly.
      }
    }
    if (fresh.length) seenStore.update({ notified: [...already, ...fresh.map(i => i.id)].slice(-500) });
  }, [ready, seen.notify, issues.map(i => i.id).join('|')]);

  const toggleNotify = async (on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return;
    }
    // Existing critical issues count as already notified; only new ones alert.
    seenStore.update({ notify: on, notified: on ? issues.filter(i => i.severity === 'critical').map(i => i.id) : seen.notified });
  };

  if (!ready) return null;
  const { added, resolved } = seen.at ? diffSeen(seen.issues, actionable) : { added: [], resolved: [] };
  const notifySupported = typeof Notification !== 'undefined';
  return (
    <Box sx={{ mb: 2 }}>
      {(added.length > 0 || resolved.length > 0) && seen.at && (
        <Alert
          severity={added.some(i => i.severity === 'critical') ? 'error' : added.length ? 'warning' : 'success'}
          action={
            <Button color="inherit" size="small" onClick={() => seenStore.update({ at: new Date().toISOString(), issues: snapshot() })}>
              Mark as seen
            </Button>
          }
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            Since you last looked ({ago(seen.at)} ago): {added.length} new, {resolved.length} resolved.
          </Typography>
          {added.slice(0, 5).map(i => (
            <Typography key={i.id} variant="body2">
              + {i.primary ? <Link to={i.primary.path}>{i.title}</Link> : i.title}
            </Typography>
          ))}
          {added.length > 5 && <Typography variant="body2">…and {added.length - 5} more</Typography>}
          {resolved.slice(0, 5).map(r => (
            <Typography key={r.id} variant="body2" color="text.secondary">
              ✓ {r.title}
            </Typography>
          ))}
        </Alert>
      )}
      {notifySupported && (
        <FormControlLabel
          sx={{ mt: 0.5 }}
          control={<Switch size="small" checked={!!seen.notify} onChange={e => toggleNotify(e.target.checked)} />}
          label={<Typography variant="body2">Desktop notification for new critical issues (while this page is open)</Typography>}
        />
      )}
    </Box>
  );
}
