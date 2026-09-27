/**
 * The cluster-wide default Pod Security level (set in the API server's
 * admission configuration, not visible through the API), found by asking:
 * two server-side dry-run pod creations in a namespace without a Pod
 * Security label. A plain pod is refused only by "restricted"; a privileged
 * pod is refused by "baseline" too. Dry runs create nothing.
 */
import { SupervisorWriter } from './api/client';

export type PsaLevel = 'restricted' | 'baseline' | 'privileged';

const probePod = (privileged: boolean) => ({
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { generateName: 'vks-fleet-psa-probe-', labels: { 'app.kubernetes.io/managed-by': 'vks-fleet' } },
  spec: {
    containers: [{ name: 'probe', image: 'registry.k8s.io/pause:3.9', ...(privileged ? { securityContext: { privileged: true } } : {}) }],
  },
});

/** The level named in a Pod Security refusal ("violates PodSecurity \"restricted:latest\""). */
export function levelFromError(message: string): PsaLevel | undefined {
  const m = /violates PodSecurity "(restricted|baseline|privileged)/.exec(message);
  return m ? (m[1] as PsaLevel) : undefined;
}

/** A namespace to probe in: one with no enforce label (default, if unlabelled). */
export function probeNamespace(namespaces: any[]): string | undefined {
  const unlabelled = namespaces.filter(n => !n?.metadata?.labels?.['pod-security.kubernetes.io/enforce']);
  return unlabelled.find(n => n?.metadata?.name === 'default')?.metadata?.name ?? unlabelled[0]?.metadata?.name;
}

export async function probePsaDefault(writer: SupervisorWriter, namespace: string): Promise<PsaLevel | undefined> {
  const attempt = async (privileged: boolean): Promise<'accepted' | PsaLevel | 'error'> => {
    try {
      await writer.send(
        { method: 'POST', path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`, contentType: 'application/json', body: probePod(privileged) },
        true
      );
      return 'accepted';
    } catch (err) {
      return levelFromError(String((err as Error)?.message ?? err)) ?? 'error';
    }
  };
  const plain = await attempt(false);
  if (plain === 'error') return undefined; // not allowed to ask, or another refusal: don't guess
  if (plain !== 'accepted') return plain; // refused a plain pod: the default is that level (restricted)
  const priv = await attempt(true);
  if (priv === 'error') return undefined;
  return priv === 'accepted' ? 'privileged' : priv;
}
