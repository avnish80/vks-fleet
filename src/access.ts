/**
 * Access: who can reach a Supervisor namespace (and so its clusters), from
 * the namespace's RoleBindings, plus connection instructions to send a
 * developer.
 */
import { describeError, SupervisorClient } from './api/client';
import { AccessEntry, FleetCluster } from './types';

export function isSystemSubject(kind: string, name: string): boolean {
  return (
    kind === 'ServiceAccount' ||
    /^system:/.test(name) ||
    /vmware-system|^wcp:|kube-|controller|operator/i.test(name)
  );
}

export function accessEntries(bindings: any[]): AccessEntry[] {
  const out: AccessEntry[] = [];
  for (const b of bindings) {
    const role = `${b?.roleRef?.kind === 'ClusterRole' ? '' : 'role '}${b?.roleRef?.name ?? '?'}`;
    for (const sub of b?.subjects ?? []) {
      const name = String(sub?.name ?? '');
      out.push({
        subject: sub?.kind === 'ServiceAccount' && sub?.namespace ? `${sub.namespace}/${name}` : name,
        subjectKind: sub?.kind ?? '?',
        role,
        binding: b?.metadata?.name ?? '',
        system: isSystemSubject(sub?.kind ?? '', name),
      });
    }
  }
  const seen = new Set<string>();
  return out
    .filter(e => {
      const k = `${e.subjectKind}|${e.subject}|${e.role}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => Number(a.system) - Number(b.system) || a.subject.localeCompare(b.subject));
}

export async function fetchAccess(client: SupervisorClient, namespace: string): Promise<{ entries: AccessEntry[]; error?: string }> {
  try {
    const list = await client.get<{ items?: any[] }>(`/apis/rbac.authorization.k8s.io/v1/namespaces/${encodeURIComponent(namespace)}/rolebindings`);
    return { entries: accessEntries(list?.items ?? []) };
  } catch (err) {
    return { entries: [], error: describeError(err) };
  }
}

/** Plain-language instructions for a developer to connect to a cluster. */
export function connectInstructions(c: FleetCluster, supervisorServer: string): string {
  return [
    `To connect to the VKS cluster ${c.name}:`,
    '',
    `1. Download the Kubernetes CLI tools (kubectl and the vSphere plugin) from https://${supervisorServer} and put both on your PATH.`,
    '2. Sign in with your vSphere or VCF account:',
    '',
    `   kubectl vsphere login --server=${supervisorServer} --vsphere-username <you@domain> --insecure-skip-tls-verify \\`,
    `     --tanzu-kubernetes-cluster-namespace ${c.namespace} --tanzu-kubernetes-cluster-name ${c.name}`,
    '',
    `3. Use the context:  kubectl config use-context ${c.name}`,
    '4. Check:            kubectl get nodes',
    '',
    `The sign-in lasts about 10 hours; run step 2 again when it expires. Access is granted through the Supervisor namespace ${c.namespace} (ask the platform team if the sign-in is refused).`,
  ].join('\n');
}
