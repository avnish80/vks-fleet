/**
 * Who is signed in, from the Supervisor's own answers to "can I?" questions
 * (SelfSubjectAccessReview, which any signed-in user may ask). The Supervisor
 * stays the real boundary; this only lets the plugin show the right view.
 */
import { SupervisorWriter } from './api/client';
import { SupervisorConfig } from './types';

export type Persona = 'operator' | 'readonly' | 'tenant' | 'tenant-readonly' | 'unknown';

export interface PersonaInfo {
  persona: Persona;
  /** The signed-in user name, when the API server says (SelfSubjectReview). */
  user?: string;
  /** May make changes through the plugin (false when read-only is forced). */
  canWrite: boolean;
  canListAll: boolean;
  label: string;
  detail: string;
}

async function can(
  writer: SupervisorWriter,
  verb: string,
  resource: string,
  group: string,
  namespace?: string
): Promise<boolean> {
  const res: any = await writer.send(
    {
      method: 'POST',
      path: '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews',
      contentType: 'application/json',
      body: {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: { resourceAttributes: { verb, group, resource, ...(namespace ? { namespace } : {}) } },
      },
    },
    false
  );
  return res?.status?.allowed === true;
}

export function describePersona(p: Persona, org: string | undefined, forcedReadOnly: boolean): { label: string; detail: string } {
  const ro = forcedReadOnly ? ' Actions are turned off for this Headlamp.' : '';
  switch (p) {
    case 'operator':
      return { label: forcedReadOnly ? 'Operator (read-only view)' : 'Operator', detail: `Can see and change every org's clusters.${ro}` };
    case 'readonly':
      return { label: 'Read-only admin', detail: 'Can see every org; changes are not allowed.' };
    case 'tenant':
      return { label: `Tenant: ${org ?? 'your org'}`, detail: `Sees only this org's namespaces and clusters.${ro}` };
    case 'tenant-readonly':
      return { label: `Tenant: ${org ?? 'your org'} (read-only)`, detail: "Sees only this org's clusters; changes are not allowed." };
    default:
      return { label: 'Access not checked', detail: "The Supervisor didn't answer the access check; actions rely on the dry run." };
  }
}

export function classify(canListAll: boolean, canPatch: boolean): Persona {
  if (canListAll) return canPatch ? 'operator' : 'readonly';
  return canPatch ? 'tenant' : 'tenant-readonly';
}

/** The user name behind an identity (Kubernetes 1.28+ SelfSubjectReview); undefined if not answered. */
export async function whoAmI(writer: SupervisorWriter): Promise<string | undefined> {
  try {
    const res: any = await writer.send(
      {
        method: 'POST',
        path: '/apis/authentication.k8s.io/v1/selfsubjectreviews',
        contentType: 'application/json',
        body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' },
      },
      false
    );
    const name = res?.status?.userInfo?.username;
    return typeof name === 'string' && name ? name.replace(/^(sso|wcp):/, '') : undefined;
  } catch {
    return undefined;
  }
}

/** Asks the Supervisor what this identity may do. */
export async function detectPersona(
  s: SupervisorConfig,
  writer: SupervisorWriter,
  probeNamespace: string | undefined,
  forcedReadOnly: boolean
): Promise<PersonaInfo> {
  try {
    const listAll = s.mode === 'vcfa' ? false : await can(writer, 'list', 'clusters', 'cluster.x-k8s.io');
    const ns = probeNamespace ?? s.namespaces[0];
    const patch = ns ? await can(writer, 'patch', 'clusters', 'cluster.x-k8s.io', ns) : false;
    const persona = classify(listAll, patch);
    const user = await whoAmI(writer);
    return { persona, user, canWrite: patch && !forcedReadOnly, canListAll: listAll, ...describePersona(persona, s.org, forcedReadOnly) };
  } catch {
    return { persona: 'unknown', canWrite: !forcedReadOnly, canListAll: false, ...describePersona('unknown', s.org, forcedReadOnly) };
  }
}
