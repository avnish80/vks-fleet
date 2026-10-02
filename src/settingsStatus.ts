/**
 * Checks behind the settings page's setup status: does each configured context
 * exist, sign in, and see what it should? Plain answers, with what to do.
 */
import { SupervisorClient, statusOf } from './api/client';

export type Level = 'ok' | 'warn' | 'error' | 'pending';

export interface Probe {
  level: Level;
  text: string;
  /** What to do about it. */
  fix?: string;
}

export interface SupervisorProbe extends Probe {
  clusters?: number;
  namespaces?: number;
  /** Org (tenant) IDs found on namespaces, for naming them. */
  orgIds?: string[];
  /** The VKS clusters it found (their contexts are named after them). */
  clusterNames?: string[];
}

/** Why a request failed, in terms an operator acts on. */
export function explain(err: unknown, what: string): Probe {
  const s = statusOf(err);
  const text = String((err as { message?: string })?.message ?? err ?? '');
  // Headlamp couldn't verify the server's certificate (x509): a CA problem, not a network one.
  if (/x509|certificate|unknown authority|tls:/i.test(text))
    return {
      level: 'error',
      text: `${what}: its certificate isn't trusted`,
      fix: "Give Headlamp the vCenter CA (the chart's tls.caSecret, or the refresher's CA_FILE writes it into the kubeconfig), or for lab certificates skip the check (tls.insecure).",
    };
  if (s === 401) return { level: 'error', text: `${what}: sign-in expired`, fix: 'Sign in again (kubectl vsphere login, or vcf context refresh), or check the refresh timer.' };
  if (s === 403) return { level: 'warn', text: `${what}: signed in, but not allowed to list this`, fix: 'Give the account read rights, or list the namespaces it can read (Advanced).' };
  if (s === 404) return { level: 'warn', text: `${what}: not found`, fix: 'Check the name.' };
  return { level: 'error', text: `${what}: not reachable`, fix: 'Check the address and that the jump server or pod can reach it.' };
}

export async function probeSupervisor(client: SupervisorClient, context: string, known: string[], tenantLabelKey: string): Promise<SupervisorProbe> {
  if (!context) return { level: 'error', text: 'No Headlamp cluster chosen', fix: 'Pick the context that points at the Supervisor.' };
  if (known.length && !known.includes(context)) return { level: 'error', text: `Headlamp has no cluster named ${context}`, fix: 'Sign in to the Supervisor (kubectl vsphere login), or pick another context.' };
  try {
    const cl = await client.get<{ items?: Array<{ metadata?: { name?: string } }> }>('/apis/cluster.x-k8s.io/v1beta1/clusters');
    let namespaces: number | undefined;
    let orgIds: string[] | undefined;
    try {
      const ns = await client.get<{ items?: Array<{ metadata?: { labels?: Record<string, string> } }> }>('/api/v1/namespaces');
      namespaces = ns.items?.length ?? 0;
      if (tenantLabelKey) orgIds = Array.from(new Set((ns.items ?? []).map(n => n.metadata?.labels?.[tenantLabelKey]).filter((x): x is string => !!x))).sort();
    } catch {
      /* namespaces not listable: the cluster count still says it works */
    }
    const n = cl.items?.length ?? 0;
    return {
      level: 'ok',
      text: `${n} cluster${n === 1 ? '' : 's'}${namespaces !== undefined ? `, ${namespaces} namespace${namespaces === 1 ? '' : 's'}` : ''}`,
      clusters: n,
      namespaces,
      orgIds,
      clusterNames: (cl.items ?? []).map(x => x.metadata?.name).filter((x): x is string => !!x),
    };
  } catch (err) {
    return explain(err, context);
  }
}

/** Is a context usable at all (signed in)? */
export async function probeContext(client: SupervisorClient, context: string): Promise<Probe> {
  try {
    await client.get('/version');
    return { level: 'ok', text: `${context}: signed in` };
  } catch (err) {
    return explain(err, context);
  }
}

export interface AdminTwins {
  supervisors: Array<{ context: string; admin: string; found: boolean }>;
  /** Other contexts (clusters) with and without an admin twin. */
  clustersWith: number;
  clustersWithout: string[];
}

/** For elevation: which read contexts have their admin counterpart. */
export function adminTwins(contexts: string[], suffix: string, supervisors: Array<{ context: string; admin?: string }>, exclude: string[] = [], clusterNames?: string[]): AdminTwins {
  const set = new Set(contexts);
  const sv = supervisors.filter(s => s.context).map(s => {
    const admin = s.admin?.trim() || `${s.context}${suffix}`;
    return { context: s.context, admin, found: set.has(admin) };
  });
  const skip = new Set([...sv.flatMap(s => [s.context, s.admin]), ...exclude]);
  // Only the VKS clusters' own contexts, when known (namespace contexts from kubectl vsphere login aren't clusters).
  const known = clusterNames ? new Set(clusterNames) : undefined;
  const clusters = contexts.filter(c => !skip.has(c) && !c.endsWith(suffix) && (!known || known.has(c)));
  const twinned = clusters.filter(c => set.has(`${c}${suffix}`));
  return { supervisors: sv, clustersWith: twinned.length, clustersWithout: clusters.filter(c => !set.has(`${c}${suffix}`)) };
}

/** The changes mode as one choice. */
export type ChangesMode = 'allow' | 'elevate' | 'readonly';
export const changesMode = (s: { readOnly?: boolean; elevation?: { enabled?: boolean } }): ChangesMode => (s.readOnly ? 'readonly' : s.elevation?.enabled ? 'elevate' : 'allow');
export function changesPatch(mode: ChangesMode, elevation?: { suffix?: string }): { readOnly: boolean; elevation: { enabled: boolean; suffix?: string } } {
  return { readOnly: mode === 'readonly', elevation: { ...(elevation ?? {}), enabled: mode === 'elevate' } };
}
