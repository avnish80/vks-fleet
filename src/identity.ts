import { PluginConfig, SupervisorConfig } from './types';

export interface IdentityPlan {
  identities: SupervisorConfig[];
  canSwitch: boolean;
  active?: SupervisorConfig;
  /** The Supervisor entries the plugin reads with. */
  supervisors: SupervisorConfig[];
}

/**
 * Which identities this Headlamp holds (configured entries plus VCFA orgs
 * found in its contexts), whether the switch is offered, and which one is in use.
 */
export function identityPlan(settings: PluginConfig, discovered: SupervisorConfig[], wanted?: string): IdentityPlan {
  const identities = [
    ...settings.supervisors,
    ...discovered.filter(d => !settings.supervisors.some(x => x.id === d.id || x.headlampCluster === d.headlampCluster)),
  ];
  const canSwitch = settings.identitySwitch !== false && identities.length > 1;
  const active = canSwitch ? identities.find(i => i.id === wanted) ?? identities[0] : undefined;
  const supervisors = active ? [active] : settings.supervisors.length ? settings.supervisors : discovered;
  return { identities, canSwitch, active, supervisors };
}

/** "administrator@wld.sso (10.150.4.2)" or "org-admin (VCFA org2)". */
export function identityLabel(i: SupervisorConfig, user?: string): string {
  const where = i.mode === 'vcfa' ? `VCFA ${i.org ?? i.displayName ?? ''}`.trim() : i.displayName && i.displayName !== i.headlampCluster ? `${i.displayName}, ${i.headlampCluster}` : i.headlampCluster;
  return user ? `${user} (${where})` : where;
}
