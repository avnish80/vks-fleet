import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { ClusterDetail } from './components/ClusterDetail';
import { MachineDetail } from './components/MachineDetail';
import { AccessPage } from './components/AccessPanel';
import { BaselinePage } from './components/BaselinePage';
import { CapacityPage } from './components/CapacityPage';
import { AppsPage, SecurityPage, ShowbackPage } from './components/InsightPages';
import { NamespaceDetail, NamespacesPage, NetworkPage, VmDetail, VmsPage } from './components/NamespacePages';
import { CleanupPage } from './components/CleanupPage';
import { MachinesPage } from './components/MachinesPage';
import { UpgradePlannerPage } from './components/UpgradePlannerPage';
import { PageFrame } from './components/PersonaBar';
import { PackagesPage } from './components/PackagesPage';
import { SearchPage } from './components/SearchPage';
import { FleetView } from './components/FleetView';
import { PLUGIN_NAME } from './config';
import { APPS_ROUTE, NAMESPACE_BASE, NAMESPACE_PATH, NETWORK_PATH, SECURITY_ROUTE, SHOWBACK_PATH, VM_BASE, VM_PATH } from './routes';
import { ACCESS_PATH, BASELINE_PATH, CAPACITY_PATH, CLEANUP_PATH, CLUSTER_PATH, FLEET_PATH, MACHINE_PATH, MACHINES_PATH, PACKAGES_PATH, SEARCH_ROUTE, UPGRADES_PATH } from './routes';
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
  { name: 'vks-fleet-search', label: 'Search', url: SEARCH_ROUTE },
  { name: 'vks-fleet-packages', label: 'Packages', url: PACKAGES_PATH },
  { name: 'vks-fleet-namespaces', label: 'Namespaces', url: NAMESPACE_BASE },
  { name: 'vks-fleet-machines', label: 'Machines', url: MACHINES_PATH },
  { name: 'vks-fleet-vms', label: 'VMs', url: VM_BASE },
  { name: 'vks-fleet-network', label: 'Network', url: NETWORK_PATH },
  { name: 'vks-fleet-apps', label: 'Applications', url: APPS_ROUTE },
  { name: 'vks-fleet-security', label: 'Security', url: SECURITY_ROUTE },
  { name: 'vks-fleet-showback', label: 'Showback', url: SHOWBACK_PATH },
  { name: 'vks-fleet-upgrades', label: 'Upgrades', url: UPGRADES_PATH },
  { name: 'vks-fleet-capacity', label: 'Capacity', url: CAPACITY_PATH },
  { name: 'vks-fleet-baseline', label: 'Baseline', url: BASELINE_PATH },
  { name: 'vks-fleet-cleanup', label: 'Cleanup', url: CLEANUP_PATH },
  { name: 'vks-fleet-access', label: 'Access', url: ACCESS_PATH },
]) {
  registerSidebarEntry({ parent: 'vks-fleet', ...child, useClusterURL: false, sidebar: 'HOME' });
}

registerRoute({
  path: SEARCH_ROUTE,
  sidebar: { item: 'vks-fleet-search', sidebar: 'HOME' },
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
  { path: VM_BASE, name: 'vks-fleet-vms', component: () => (<PageFrame><VmsPage /></PageFrame>) },
  { path: VM_PATH, name: 'vks-fleet-vm', item: 'vks-fleet-vms', component: () => (<PageFrame><VmDetail /></PageFrame>) },
  { path: NETWORK_PATH, name: 'vks-fleet-network', component: () => (<PageFrame><NetworkPage /></PageFrame>) },
  { path: APPS_ROUTE, name: 'vks-fleet-apps', component: () => (<PageFrame><AppsPage /></PageFrame>) },
  { path: SECURITY_ROUTE, name: 'vks-fleet-security', component: () => (<PageFrame><SecurityPage /></PageFrame>) },
  { path: SHOWBACK_PATH, name: 'vks-fleet-showback', component: () => (<PageFrame><ShowbackPage /></PageFrame>) },
  { path: UPGRADES_PATH, name: 'vks-fleet-upgrades', component: () => (
    <PageFrame>
      <UpgradePlannerPage />
    </PageFrame>
  ) },
  { path: CAPACITY_PATH, name: 'vks-fleet-capacity', component: () => (
    <PageFrame>
      <CapacityPage />
    </PageFrame>
  ) },
  { path: BASELINE_PATH, name: 'vks-fleet-baseline', component: () => (
    <PageFrame>
      <BaselinePage />
    </PageFrame>
  ) },
  { path: CLEANUP_PATH, name: 'vks-fleet-cleanup', component: () => (
    <PageFrame>
      <CleanupPage />
    </PageFrame>
  ) },
  { path: ACCESS_PATH, name: 'vks-fleet-access', component: () => (
    <PageFrame>
      <AccessPage />
    </PageFrame>
  ) },
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
  sidebar: { item: 'vks-fleet-machines', sidebar: 'HOME' },
  name: 'vks-fleet-machines',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <MachinesPage />
    </PageFrame>
  ),
});

registerRoute({
  path: PACKAGES_PATH,
  sidebar: { item: 'vks-fleet-packages', sidebar: 'HOME' },
  name: 'vks-fleet-packages',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <PackagesPage />
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
  sidebar: SIDEBAR,
  name: 'vks-fleet-machine',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => (
    <PageFrame>
      <MachineDetail />
    </PageFrame>
  ),
});

// Settings are saved as they're edited through ConfigStore, so no Save button.
registerPluginSettings(PLUGIN_NAME, SettingsPanel, false);
