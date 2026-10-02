/**
 * Read by default, elevate to change: everyday viewing uses a read-only
 * sign-in; changes go through an admin sign-in only while elevated, for a
 * limited time and with a reason. Like sudo for the fleet.
 *
 * Elevation lives in memory only: it ends when its time is up or the page
 * reloads, and is never saved. Reads keep using the read-only sign-in even
 * while elevated; only change requests switch context.
 */
import React from 'react';
import { WriteRequest } from './api/client';

export interface ElevationConfig {
  enabled: boolean;
  /** Read context → change context, for Supervisors (e.g. "10.0.0.2" → "10.0.0.2-admin"). */
  supervisorAdmin: Record<string, string>;
  /** Suffix of the change context for everything else (clusters): "kubernetes-cluster-c3d4" → "kubernetes-cluster-c3d4-admin". */
  suffix: string;
}

export interface Elevation {
  until: number;
  reason: string;
  since: number;
}

let config: ElevationConfig = { enabled: false, supervisorAdmin: {}, suffix: '-admin' };
let state: Elevation | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

export function configureElevation(c: ElevationConfig): void {
  const changed = JSON.stringify(c) !== JSON.stringify(config);
  config = c;
  if (!c.enabled && state) state = null;
  if (changed) notify();
}

export const elevationEnabled = () => config.enabled;

/** The admin contexts elevation sends Supervisor changes to. */
export const requiredAdminContexts = (): string[] => Array.from(new Set(Object.values(config.supervisorAdmin)));

/** Those Headlamp doesn't have: elevating would only lead to failed changes. */
export function missingAdminContexts(known: string[]): string[] {
  const have = new Set(known);
  return requiredAdminContexts().filter(c => !have.has(c));
}

export function current(now = Date.now()): Elevation | null {
  if (state && now >= state.until) {
    state = null;
    notify();
  }
  return state;
}

export function elevate(minutes: number, reason: string, now = Date.now()): Elevation {
  state = { since: now, until: now + Math.max(1, Math.min(240, minutes)) * 60_000, reason: reason.trim() };
  notify();
  return state;
}

export function dropElevation(): void {
  state = null;
  notify();
}

export class ElevationRequired extends Error {
  status = 403;
  constructor() {
    super('Changes need elevation: use Elevate (top bar) with a reason, then try again.');
  }
}

/** The context a change goes to: the admin one while elevated; refused when elevation is on but not active. */
export function changeContext(readContext: string, now = Date.now()): { context: string; elevated: boolean } {
  if (!config.enabled) return { context: readContext, elevated: false };
  if (!current(now)) throw new ElevationRequired();
  return { context: config.supervisorAdmin[readContext] ?? `${readContext}${config.suffix}`, elevated: true };
}

/** Records the elevation on what it changes (objects created, or changed with a merge patch). */
export function stamp(req: WriteRequest, e: Elevation | null): WriteRequest {
  if (!e || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return req;
  const merge = req.method === 'POST' || (req.method === 'PATCH' && /merge-patch|strategic-merge/.test(req.contentType ?? ''));
  if (!merge) return req;
  const body = req.body as any;
  return {
    ...req,
    body: {
      ...body,
      metadata: {
        ...(body.metadata ?? {}),
        annotations: {
          ...(body.metadata?.annotations ?? {}),
          'vks-fleet/elevated': new Date(e.since).toISOString(),
          'vks-fleet/elevation-reason': e.reason.slice(0, 200),
        },
      },
    },
  };
}

/** Re-renders every second while elevated (for the countdown), and on any change. */
export function useElevation(): { enabled: boolean; active: Elevation | null; secondsLeft: number } {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const l = () => setTick(t => t + 1);
    listeners.add(l);
    const timer = window.setInterval(() => state && l(), 1000);
    return () => {
      listeners.delete(l);
      window.clearInterval(timer);
    };
  }, []);
  const active = current();
  return { enabled: config.enabled, active, secondsLeft: active ? Math.max(0, Math.round((active.until - Date.now()) / 1000)) : 0 };
}
