/**
 * One place for what every plugin page needs: the settings (or VCFA orgs
 * discovered from the signed-in contexts), the fleet data (fetched once per
 * page), who is signed in, and the org the operator is looking at.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React, { createContext, ReactNode, useContext } from 'react';
import { headlampClient, listHeadlampClusters, supervisorClient, supervisorWriter } from './api/headlampClient';
import { fetchInventory } from './inventory';
import { fetchOrgLimits, NamespaceLimits, OrgQuota } from './limits';
import { detectPersona, PersonaInfo, whoAmI } from './persona';
import { ALL_ORGS, orgsOf, scopeInventory, scopeResults } from './scope';
import { usePluginConfig } from './settings/store';
import { Inventory, PluginConfig, SupervisorConfig, SupervisorResult } from './types';
import { useFleet } from './useFleet';
import { usePolling } from './usePolling';
import { discoverVcfaOrgs } from './vcfa';
import { identityPlan } from './identity';

const viewStore = new ConfigStore<{ org?: string; identity?: string }>('vks-fleet-view');
const useView = viewStore.useConfig();

export interface FleetData {
  config: PluginConfig;
  /** Every Supervisor's data, unscoped (for detail pages reached by link). */
  all: SupervisorResult[] | null;
  /** The same, narrowed to the selected org. */
  results: SupervisorResult[] | null;
  refresh: () => void;
  refreshing: boolean;
  /** Who is signed in, per Supervisor entry. */
  personas: Map<string, PersonaInfo>;
  /** The primary persona (first Supervisor), for the page badge. */
  persona?: PersonaInfo;
  canWrite: (supervisorId: string) => boolean;
  org: string;
  setOrg: (org: string) => void;
  orgs: Array<{ id: string; name: string; clusters: number }>;
  /** VCFA orgs found in Headlamp's contexts (used when nothing is configured). */
  discovered: SupervisorConfig[];
  /** Identities this Headlamp can act as (when switching is allowed). */
  identities: SupervisorConfig[];
  identity?: string;
  setIdentity: (id: string) => void;
  /** Whether the "Signed in as" switch is offered. */
  canSwitchIdentity: boolean;
  /** User name per identity, when the API server says. */
  userNames: Map<string, string>;
  /** VMs, networking and storage per Supervisor, narrowed to the selected org (null while loading). */
  inventory: Map<string, Inventory> | null;
  /** Namespace limits (from VCF Automation or the Supervisor), by namespace name. */
  limits: Map<string, NamespaceLimits>;
  /** Org quotas from VCF Automation. */
  orgQuotas: OrgQuota[];
  /** Orgs whose VCFA quotas couldn't be read, with why. */
  limitProblems: Array<{ org: string; error: string; expired?: boolean }>;
  /** Per VCFA org: which context the quota was read through, and how it went. */
  quotaSources: Array<{ org: string; context?: string; status: 'ok' | 'expired' | 'error' | 'no-context' | 'reading'; detail?: string }>;
}

const Ctx = createContext<FleetData | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const settings = usePluginConfig();
  const view = useView();
  const discovered =
    usePolling('vcfa-discovery', async () => discoverVcfaOrgs(await listHeadlampClusters()), 120) ?? [];
  const { identities, canSwitch: canSwitchIdentity, active, supervisors } = identityPlan(settings, discovered, view?.identity);
  const config: PluginConfig = { ...settings, supervisors };
  const identityKey = identities.map(i => `${i.id}:${i.headlampCluster}`).join('|');
  const userNames =
    usePolling(
      canSwitchIdentity ? `whoami|${identityKey}` : null,
      async () => {
        const names = await Promise.all(identities.map(async i => [i.id, await whoAmI(supervisorWriter(i))] as const));
        return new Map(names.filter((x): x is readonly [string, string] => !!x[1]).map(([k, v]) => [k, v] as [string, string]));
      },
      600
    ) ?? new Map<string, string>();
  const { results, refresh, refreshing } = useFleet(config.supervisors, config.refreshSeconds);

  const probeKey = config.supervisors.map(s => `${s.id}:${s.mode}:${s.headlampCluster}`).join('|');
  const firstNs = new Map(
    (results ?? []).map(r => [r.supervisor.id, r.clusters[0]?.namespace ?? r.supervisor.namespaces[0]] as [string, string | undefined])
  );
  const personas =
    usePolling(
      probeKey ? `${probeKey}|${config.readOnly}|${[...firstNs.values()].join(',')}` : null,
      async () =>
        new Map(
          await Promise.all(
            config.supervisors.map(
              async s => [s.id, await detectPersona(s, supervisorWriter(s), firstNs.get(s.id), !!config.readOnly)] as [string, PersonaInfo]
            )
          )
        ),
      300
    ) ?? new Map<string, PersonaInfo>();

  const orgs = orgsOf(results ?? []);
  const primary = config.supervisors[0] ? personas.get(config.supervisors[0].id) : undefined;
  const tenantView = primary?.persona === 'tenant' || primary?.persona === 'tenant-readonly';
  const wanted = view?.org ?? ALL_ORGS;
  const org = tenantView || !orgs.some(o => o.id === wanted) ? ALL_ORGS : wanted;

  // Namespace inventory: fetched once for every page, refreshed every minute.
  const invKey = (results ?? [])
    .filter(r => !r.error)
    .map(r => `${r.supervisor.id}:${r.scope}:${(r.namespaces ?? []).map(n => n.name).join(',')}`)
    .join('|');
  const inventoryAll = usePolling(
    invKey || null,
    async () =>
      new Map(
        await Promise.all(
          (results ?? [])
            .filter(r => !r.error)
            .map(async r => {
              const clusterNames = new Map<string, string[]>();
              for (const c of r.clusters) clusterNames.set(c.namespace, [...(clusterNames.get(c.namespace) ?? []), c.name]);
              const inv = await fetchInventory(
                supervisorClient(r.supervisor),
                r.supervisor,
                (r.namespaces ?? []).map(n => n.name),
                r.scope === 'cluster',
                clusterNames
              );
              return [r.supervisor.id, inv] as [string, Inventory];
            })
        )
      ),
    60
  );
  const scopedNs =
    org === ALL_ORGS
      ? undefined
      : new Set((results ?? []).flatMap(r => (r.namespaces ?? []).filter(n => n.tenantId === org).map(n => n.name)));
  const inventory = inventoryAll
    ? new Map(Array.from(inventoryAll.entries()).map(([k, v]) => [k, scopeInventory(v, scopedNs)] as [string, Inventory]))
    : null;

  // Quotas live in VCF Automation: read them (read-only) through every org-level
  // VCFA context this Headlamp holds, whichever identity is active.
  const allVcfa = identities.filter(i => i.mode === 'vcfa' && i.org);
  const vcfaOrgs = allVcfa.filter(i => i.orgContext);
  const orgKey = vcfaOrgs.map(i => `${i.org}:${i.orgContext}:${Object.values(i.namespaceProjects ?? {}).join(',')}`).join('|');
  const orgLimits = usePolling(
    orgKey || null,
    () =>
      Promise.all(
        vcfaOrgs.map(async i => ({
          org: i.org!,
          ...(await fetchOrgLimits(headlampClient(i.orgContext!), i.org!, Array.from(new Set(Object.values(i.namespaceProjects ?? {}).concat(['default-project']))))),
        }))
      ),
    300
  );
  const limits = new Map<string, NamespaceLimits>();
  for (const r of results ?? []) {
    for (const n of r.namespaces ?? []) {
      if (n.limits && (!scopedNs || scopedNs.has(n.name))) {
        limits.set(n.name, {
          namespace: n.name,
          source: 'supervisor',
          cpuLimitMHz: n.limits.cpuMHz,
          memoryLimitBytes: n.limits.memoryBytes,
          storage: [],
          vmClasses: [],
          zones: [],
        });
      }
    }
  }
  for (const o of orgLimits ?? []) for (const l of o.limits) if (!scopedNs || scopedNs.has(l.namespace)) limits.set(l.namespace, l);
  const orgName = orgs.find(o => o.id === org)?.name;
  const orgQuotas = (orgLimits ?? []).map(o => o.quota).filter((q): q is OrgQuota => !!q && (org === ALL_ORGS || q.org === orgName || q.org === org));
  const limitProblems = (orgLimits ?? []).filter(o => o.error).map(o => ({ org: o.org, error: o.error!, expired: o.expired }));
  const quotaSources: FleetData['quotaSources'] = Array.from(new Map(allVcfa.map(i => [i.org!, i])).values()).map(i => {
    if (!i.orgContext) return { org: i.org!, status: 'no-context' as const };
    const r = (orgLimits ?? []).find(o => o.org === i.org);
    if (!r) return { org: i.org!, context: i.orgContext, status: 'reading' as const };
    if (r.error) return { org: i.org!, context: i.orgContext, status: r.expired ? ('expired' as const) : ('error' as const), detail: r.error };
    return { org: i.org!, context: i.orgContext, status: 'ok' as const, detail: `${r.limits.length} namespace${r.limits.length === 1 ? '' : 's'}` };
  });

  const value: FleetData = {
    config,
    all: results,
    results: results ? scopeResults(results, org) : null,
    refresh,
    refreshing,
    personas,
    persona: primary,
    canWrite: id => (config.readOnly ? false : personas.get(id)?.canWrite ?? true),
    org,
    setOrg: o => viewStore.update({ org: o }),
    orgs,
    discovered,
    identities,
    identity: active?.id,
    setIdentity: id => viewStore.update({ identity: id, org: ALL_ORGS }),
    canSwitchIdentity,
    userNames,
    inventory,
    limits,
    orgQuotas,
    limitProblems,
    quotaSources,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFleetData(): FleetData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFleetData must be used inside FleetProvider');
  return v;
}
