/**
 * One place for what every plugin page needs: the settings (or VCFA orgs
 * discovered from the signed-in contexts), the fleet data (fetched once per
 * page), who is signed in, and the org the operator is looking at.
 */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React, { createContext, ReactNode, useContext } from 'react';
import { listHeadlampClusters, supervisorWriter } from './api/headlampClient';
import { detectPersona, PersonaInfo } from './persona';
import { ALL_ORGS, orgsOf, scopeResults } from './scope';
import { usePluginConfig } from './settings/store';
import { PluginConfig, SupervisorConfig, SupervisorResult } from './types';
import { useFleet } from './useFleet';
import { usePolling } from './usePolling';
import { discoverVcfaOrgs } from './vcfa';

const viewStore = new ConfigStore<{ org?: string }>('vks-fleet-view');
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
}

const Ctx = createContext<FleetData | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const settings = usePluginConfig();
  const discovered =
    usePolling('vcfa-discovery', async () => discoverVcfaOrgs(await listHeadlampClusters()), 120) ?? [];
  const config: PluginConfig = settings.supervisors.length ? settings : { ...settings, supervisors: discovered };
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

  const view = useView();
  const orgs = orgsOf(results ?? []);
  const primary = config.supervisors[0] ? personas.get(config.supervisors[0].id) : undefined;
  const tenantView = primary?.persona === 'tenant' || primary?.persona === 'tenant-readonly';
  const wanted = view?.org ?? ALL_ORGS;
  const org = tenantView || !orgs.some(o => o.id === wanted) ? ALL_ORGS : wanted;

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
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFleetData(): FleetData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFleetData must be used inside FleetProvider');
  return v;
}
