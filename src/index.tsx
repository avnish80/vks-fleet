import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { ClusterDetail } from './components/ClusterDetail';
import { MachineDetail } from './components/MachineDetail';
import { CapacityPage } from './components/CapacityPage';
import { MachinesPage } from './components/MachinesPage';
import { UpgradePlannerPage } from './components/UpgradePlannerPage';
import { PackagesPage } from './components/PackagesPage';
import { SearchPage } from './components/SearchPage';
import { FleetView } from './components/FleetView';
import { PLUGIN_NAME } from './config';
import { CAPACITY_PATH, CLUSTER_PATH, FLEET_PATH, MACHINE_PATH, MACHINES_PATH, PACKAGES_PATH, SEARCH_ROUTE, UPGRADES_PATH } from './routes';
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
  { name: 'vks-fleet-machines', label: 'Machines', url: MACHINES_PATH },
  { name: 'vks-fleet-upgrades', label: 'Upgrades', url: UPGRADES_PATH },
  { name: 'vks-fleet-capacity', label: 'Capacity', url: CAPACITY_PATH },
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
  component: () => <SearchPage />,
});

for (const page of [
  { path: UPGRADES_PATH, name: 'vks-fleet-upgrades', component: () => <UpgradePlannerPage /> },
  { path: CAPACITY_PATH, name: 'vks-fleet-capacity', component: () => <CapacityPage /> },
]) {
  registerRoute({
    path: page.path,
    sidebar: { item: page.name, sidebar: 'HOME' },
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
  component: () => <MachinesPage />,
});

registerRoute({
  path: PACKAGES_PATH,
  sidebar: { item: 'vks-fleet-packages', sidebar: 'HOME' },
  name: 'vks-fleet-packages',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => <PackagesPage />,
});

registerRoute({
  path: FLEET_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => <FleetView />,
});

registerRoute({
  path: CLUSTER_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet-cluster',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => <ClusterDetail />,
});

registerRoute({
  path: MACHINE_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet-machine',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => <MachineDetail />,
});

// Settings are saved as they're edited through ConfigStore, so no Save button.
registerPluginSettings(PLUGIN_NAME, SettingsPanel, false);
