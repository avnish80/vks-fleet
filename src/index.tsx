import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { ClusterDetail } from './components/ClusterDetail';
import { MachineDetail } from './components/MachineDetail';
import { AppsPage } from './components/InsightPages';
import { ObservabilityPage } from './components/ObservabilityPage';
import { SupervisorHealthPage } from './components/SupervisorHealthPage';
import { InvestigatePage } from './components/InvestigatePage';
import { CapacityHub, ComputeHub, GovernanceHub, LifecycleHub, SecurityHub } from './components/Hubs';
import { NamespaceDetail, NamespacesPage, NetworkPage, VmDetail } from './components/NamespacePages';
import { PageFrame } from './components/PersonaBar';
import { SearchPage } from './components/SearchPage';
import { FleetView } from './components/FleetView';
import { PLUGIN_NAME } from './config';
import { APPS_ROUTE, COMPLIANCE_ROUTE, INVESTIGATE_ROUTE, OBSERVABILITY_ROUTE, SUPERVISOR_HEALTH_ROUTE, VULNS_ROUTE, NAMESPACE_BASE, NAMESPACE_PATH, NETWORK_PATH, SECURITY_ROUTE, SHOWBACK_PATH, VM_BASE, VM_PATH } from './routes';
import { ACCESS_PATH, BASELINE_PATH, CAPACITY_PATH, CLEANUP_PATH, CLUSTER_PATH, FLEET_PATH, MACHINE_PATH, MACHINES_PATH, PACKAGES_PATH, PREFLIGHT_PATH, SEARCH_ROUTE, UPGRADES_PATH } from './routes';
import { SettingsPanel } from './settings/SettingsPanel';

// The fleet spans clusters, so it lives in Headlamp's home sidebar and its
// routes are not prefixed with /c/<cluster>. noAuthRequired: Headlamp's route
// auth check is per selected cluster, and these pages have none selected (the
// check would never finish and the page would stay blank). The plugin does its
// own per-Supervisor requests and shows auth failures in the view instead.
const SIDEBAR = { item: 'vks-fleet', sidebar: 'HOME' };

registerSidebarEntry({
  parent: null,
  name: 'vks-fleet',
  label: 'VKS fleet',
  url: FLEET_PATH,
  icon: 'mdi:server-network',
  useClusterURL: false,
  sidebar: 'HOME',
});

for (const child of [
  { name: 'vks-fleet-supervisor-health', label: 'Supervisor health', url: SUPERVISOR_HEALTH_ROUTE, icon: 'mdi:heart-pulse' },
  { name: 'vks-fleet-namespaces', label: 'Namespaces', url: NAMESPACE_BASE, icon: 'mdi:folder-network-outline' },
  { name: 'vks-fleet-compute', label: 'Compute', url: MACHINES_PATH, icon: 'mdi:server' },
  { name: 'vks-fleet-network', label: 'Network', url: NETWORK_PATH, icon: 'mdi:lan' },
  { name: 'vks-fleet-apps', label: 'Applications', url: APPS_ROUTE, icon: 'mdi:apps' },
  { name: 'vks-fleet-observability', label: 'Observability', url: OBSERVABILITY_ROUTE, icon: 'mdi:chart-timeline-variant' },
  { name: 'vks-fleet-investigate', label: 'Investigate', url: INVESTIGATE_ROUTE, icon: 'mdi:magnify-scan' },
  { name: 'vks-fleet-security', label: 'Security', url: SECURITY_ROUTE, icon: 'mdi:shield-lock-outline' },
  { name: 'vks-fleet-lifecycle', label: 'Lifecycle', url: PACKAGES_PATH, icon: 'mdi:package-variant-closed' },
  { name: 'vks-fleet-capacity', label: 'Capacity & cost', url: CAPACITY_PATH, icon: 'mdi:gauge' },
  { name: 'vks-fleet-governance', label: 'Governance', url: BASELINE_PATH, icon: 'mdi:ruler-square' },
]) {
  registerSidebarEntry({ parent: 'vks-fleet', ...child, useClusterURL: false, sidebar: 'HOME' });
}

registerRoute({
  path: SEARCH_ROUTE,
  sidebar: SIDEBAR,
  name: 'vks-fleet-search',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <SearchPage />
    </PageFrame>
  ),
});

for (const page of [
  { path: NAMESPACE_BASE, name: 'vks-fleet-namespaces', component: () => (<PageFrame><NamespacesPage /></PageFrame>) },
  { path: NAMESPACE_PATH, name: 'vks-fleet-namespace', item: 'vks-fleet-namespaces', component: () => (<PageFrame><NamespaceDetail /></PageFrame>) },
  { path: VM_BASE, name: 'vks-fleet-vms', item: 'vks-fleet-compute', component: () => (<PageFrame><ComputeHub /></PageFrame>) },
  { path: VM_PATH, name: 'vks-fleet-vm', item: 'vks-fleet-compute', component: () => (<PageFrame><ComputeHub><VmDetail /></ComputeHub></PageFrame>) },
  { path: NETWORK_PATH, name: 'vks-fleet-network', component: () => (<PageFrame><NetworkPage /></PageFrame>) },
  { path: APPS_ROUTE, name: 'vks-fleet-apps', component: () => (<PageFrame><AppsPage /></PageFrame>) },
  { path: SECURITY_ROUTE, name: 'vks-fleet-security', component: () => (<PageFrame><SecurityHub /></PageFrame>) },
  { path: COMPLIANCE_ROUTE, name: 'vks-fleet-compliance', item: 'vks-fleet-security', component: () => (<PageFrame><SecurityHub /></PageFrame>) },
  { path: VULNS_ROUTE, name: 'vks-fleet-vulns', item: 'vks-fleet-security', component: () => (<PageFrame><SecurityHub /></PageFrame>) },
  { path: OBSERVABILITY_ROUTE, name: 'vks-fleet-observability', component: () => (<PageFrame><ObservabilityPage /></PageFrame>) },
  { path: SUPERVISOR_HEALTH_ROUTE, name: 'vks-fleet-supervisor-health', component: () => (<PageFrame><SupervisorHealthPage /></PageFrame>) },
  { path: INVESTIGATE_ROUTE, name: 'vks-fleet-investigate', component: () => (<PageFrame><InvestigatePage /></PageFrame>) },
  { path: SHOWBACK_PATH, name: 'vks-fleet-showback', item: 'vks-fleet-capacity', component: () => (<PageFrame><CapacityHub /></PageFrame>) },
  { path: UPGRADES_PATH, name: 'vks-fleet-upgrades', item: 'vks-fleet-lifecycle', component: () => (<PageFrame><LifecycleHub /></PageFrame>) },
  { path: PREFLIGHT_PATH, name: 'vks-fleet-preflight', item: 'vks-fleet-lifecycle', component: () => (<PageFrame><LifecycleHub /></PageFrame>) },
  { path: CAPACITY_PATH, name: 'vks-fleet-capacity', component: () => (<PageFrame><CapacityHub /></PageFrame>) },
  { path: BASELINE_PATH, name: 'vks-fleet-baseline', item: 'vks-fleet-governance', component: () => (<PageFrame><GovernanceHub /></PageFrame>) },
  { path: CLEANUP_PATH, name: 'vks-fleet-cleanup', item: 'vks-fleet-governance', component: () => (<PageFrame><GovernanceHub /></PageFrame>) },
  { path: ACCESS_PATH, name: 'vks-fleet-access', item: 'vks-fleet-governance', component: () => (<PageFrame><GovernanceHub /></PageFrame>) },
]) {
  registerRoute({
    path: page.path,
    sidebar: { item: (page as { item?: string }).item ?? page.name, sidebar: 'HOME' },
    name: page.name,
    exact: true,
    useClusterURL: false,
    noAuthRequired: true,
    component: page.component,
  });
}

registerRoute({
  path: MACHINES_PATH,
  sidebar: { item: 'vks-fleet-compute', sidebar: 'HOME' },
  name: 'vks-fleet-machines',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <ComputeHub />
    </PageFrame>
  ),
});

registerRoute({
  path: PACKAGES_PATH,
  sidebar: { item: 'vks-fleet-lifecycle', sidebar: 'HOME' },
  name: 'vks-fleet-packages',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <LifecycleHub />
    </PageFrame>
  ),
});

registerRoute({
  path: FLEET_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <FleetView />
    </PageFrame>
  ),
});

registerRoute({
  path: CLUSTER_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet-cluster',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <ClusterDetail />
    </PageFrame>
  ),
});

registerRoute({
  path: MACHINE_PATH,
  sidebar: { item: 'vks-fleet-compute', sidebar: 'HOME' },
  name: 'vks-fleet-machine',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <ComputeHub>
        <MachineDetail />
      </ComputeHub>
    </PageFrame>
  ),
});

// Settings are saved as they're edited through ConfigStore, so no Save button.
registerPluginSettings(PLUGIN_NAME, SettingsPanel, false);
