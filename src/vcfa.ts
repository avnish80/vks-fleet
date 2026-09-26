/**
 * VCF Automation tenant access. An org user's contexts (from `vcf context
 * create`) are named "<org>:<namespace>:<project>" and point at VCFA's
 * per-namespace proxy (…/proxy/k8s/namespaces/urn:vcloud:namespace:<id>).
 * Each namespace is its own endpoint, so requests are routed to the context
 * that serves the namespace in their path.
 */
import { HeadlampClusterInfo } from './contexts';
import { SupervisorConfig } from './types';

const PROXY = /\/proxy\/k8s\/namespaces\//;

export interface VcfaContext {
  context: string;
  org: string;
  namespace: string;
  project: string;
}

export function parseVcfaContext(c: HeadlampClusterInfo): VcfaContext | undefined {
  const parts = c.name.split(':');
  if (parts.length !== 3 || !parts.every(Boolean)) return undefined;
  if (c.server && !PROXY.test(c.server)) return undefined;
  const [org, namespace, project] = parts;
  return { context: c.name, org, namespace, project };
}

/** One Supervisor entry per VCFA org found among Headlamp's contexts. */
export function discoverVcfaOrgs(contexts: HeadlampClusterInfo[]): SupervisorConfig[] {
  const byOrg = new Map<string, VcfaContext[]>();
  for (const c of contexts) {
    const v = parseVcfaContext(c);
    if (v) byOrg.set(v.org, [...(byOrg.get(v.org) ?? []), v]);
  }
  return Array.from(byOrg.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([org, list]) => {
      const namespaceContexts: Record<string, string> = {};
      for (const v of list.sort((a, b) => a.context.localeCompare(b.context))) {
        if (!namespaceContexts[v.namespace]) namespaceContexts[v.namespace] = v.context;
      }
      const namespaces = Object.keys(namespaceContexts).sort();
      const namespaceProjects: Record<string, string> = {};
      for (const v of list) if (!namespaceProjects[v.namespace]) namespaceProjects[v.namespace] = v.project;
      const orgCtx = contexts.find(c => c.name === org);
      return {
        id: `vcfa-${org.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')}`.replace(/-+$/, ''),
        headlampCluster: namespaceContexts[namespaces[0]],
        displayName: `${org} (VCFA)`,
        namespaces,
        tenantLabelKey: '',
        tenantNames: {},
        mode: 'vcfa' as const,
        org,
        namespaceContexts,
        namespaceProjects,
        orgContext: orgCtx?.name,
      };
    });
}

/** The namespace a Kubernetes API path addresses, if any. */
export function namespaceOfPath(path: string): string | undefined {
  const m = /\/namespaces\/([^/?]+)/.exec(path);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/** Which Headlamp cluster (context) should serve a request for this Supervisor entry. */
export function contextFor(s: SupervisorConfig, path: string): string {
  if (s.mode === 'vcfa' && s.namespaceContexts) {
    const ns = namespaceOfPath(path);
    if (ns && s.namespaceContexts[ns]) return s.namespaceContexts[ns];
  }
  return s.headlampCluster;
}
