/**
 * Demo mode: the whole plugin running on a fictional fleet, with no lab
 * needed (for screenshots, talks, trying it out). Turned on in Settings.
 * Every request to a demo context is answered from in-memory data; dry runs
 * work, so action dialogs can be tried, but nothing is ever changed.
 */
import { SupervisorClient, SupervisorWriter, WriteRequest } from '../api/client';
import { rememberingGet } from '../api/served';
import { HeadlampClusterInfo } from '../contexts';
import { buildGuest } from './guest';
import { demoPrometheus, MONITORED } from './prometheus';
import { answer, notFound, Store } from './router';
import { buildSupervisor, contextName, DEMO_PREFIX, DEMO_SUPERVISOR, demoContexts, demoClusters, demoScale, baseName } from './supervisor';

export { DEMO_SUPERVISOR_RAW } from './supervisor';

let enabled = false;
export const setDemoMode = (on: boolean) => {
  enabled = on;
};
export const demoModeOn = () => enabled;
export const isDemoContext = (ctx: string) => ctx === DEMO_SUPERVISOR || ctx.startsWith(`${DEMO_PREFIX}:`);
export const DEMO_WRITE_REFUSED = 'Demo mode: nothing is changed. Dry runs work; turn demo mode off in Settings to act on real clusters.';

let cache: { at: number; scale: number; supervisor: Store; guests: Map<string, Store> } | undefined;

/** The demo data, rebuilt every 10 minutes so ages and "since last visit" stay plausible. */
export function demoStores(now: Date = new Date()) {
  if (!cache || cache.scale !== demoScale() || now.getTime() - cache.at > 10 * 60 * 1000 || now.getTime() < cache.at) {
    cache = {
      at: now.getTime(),
      scale: demoScale(),
      supervisor: buildSupervisor(now),
      guests: new Map(demoClusters().map(c => [contextName(c.name), buildGuest(c, now)])),
    };
  }
  return cache;
}

const storeFor = (ctx: string, now?: Date) => {
  const st = demoStores(now);
  return ctx === DEMO_SUPERVISOR ? st.supervisor : st.guests.get(ctx);
};

// A little latency, so loading states look as they do for real.
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

export function demoClient(ctx: string, opts: { now?: Date; latencyMs?: number; remember?: boolean } = {}): SupervisorClient {
  return {
    name: opts.remember === false ? undefined : ctx,
    get<T>(path: string): Promise<T> {
      const read = async () => {
        if (opts.latencyMs !== 0) await pause(opts.latencyMs ?? 60 + Math.random() * 140);
        const store = storeFor(ctx, opts.now);
        if (!store) throw notFound(path);
        // /version, as every Kubernetes API answers it: the cluster's release, or the Supervisor's.
        if (path === '/version') {
          const c = demoClusters().find(x => contextName(x.name) === ctx);
          const v = c?.version ?? 'v1.34.9+vmware.1';
          const [major, minor] = v.replace(/^v/, '').split('.');
          return { major, minor, gitVersion: v, platform: 'linux/amd64' } as T;
        }
        // Prometheus and Alertmanager behind the API's service proxy.
        const proxied = /^\/api\/v1\/namespaces\/[^/]+\/services\/[^/]+\/proxy\//.test(path);
        if (proxied) {
          // Any demo cluster, clones included (demoClusters() is the scaled list).
          const c = demoClusters().find(x => contextName(x.name) === ctx);
          // Clones (payments-2…) are monitored like the cluster they copy.
          if (!c || !MONITORED.has(baseName(c))) throw notFound(path);
          return demoPrometheus(c, path, opts.now ?? new Date()) as T;
        }
        const out = answer(store, path) as any;
        // The store is rebuilt every few minutes; leases must look renewed now, as a real Supervisor's are.
        if (path.includes('/leases') && Array.isArray(out?.items)) {
          const at = (opts.now ?? new Date()).getTime();
          return { ...out, items: out.items.map((l: any, i: number) => ({ ...l, spec: { ...l.spec, renewTime: new Date(at - (2 + i) * 1000).toISOString() } })) } as T;
        }
        return out as T;
      };
      return opts.remember === false ? read() : rememberingGet(ctx, path, read);
    },
  };
}

export function demoWriter(ctx: string, opts: { now?: Date } = {}): SupervisorWriter {
  return {
    async send(req: WriteRequest, dryRun: boolean): Promise<unknown> {
      if (req.path.endsWith('/selfsubjectaccessreviews')) return { status: { allowed: true } };
      if (req.path.endsWith('/selfsubjectreviews')) return { status: { userInfo: { username: 'demo@vsphere.local' } } };
      // Pod creation in a namespace without a Pod Security label meets VKS's "restricted" default.
      const pod = /\/api\/v1\/namespaces\/([^/]+)\/pods$/.exec(req.path.split('?')[0]);
      if (pod && req.method === 'POST') {
        const ns = (storeFor(ctx, opts.now)?.objects.get('|namespaces') ?? []).find(n => n?.metadata?.name === pod[1]);
        const level = ns?.metadata?.labels?.['pod-security.kubernetes.io/enforce'] ?? 'restricted';
        if (level === 'restricted') {
          throw Object.assign(new Error(`pods "probe" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false`), { status: 403 });
        }
      }
      if (dryRun) return req.body ?? {};
      throw Object.assign(new Error(DEMO_WRITE_REFUSED), { status: 403 });
    },
  };
}

/** Headlamp's cluster list, as demo mode sees it: only the demo contexts. */
export const demoClusterList = (): HeadlampClusterInfo[] => demoContexts();
