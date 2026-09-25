import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { ClusterDetail } from './components/ClusterDetail';
import { FleetView } from './components/FleetView';
import { PLUGIN_NAME } from './config';
import { CLUSTER_PATH, FLEET_PATH } from './routes';
import { SettingsPanel } from './settings/SettingsPanel';

// The fleet spans clusters, so it lives in Headlamp's home sidebar and its
// routes are not prefixed with /c/<cluster>.
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

registerRoute({
  path: FLEET_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet',
  exact: true,
  useClusterURL: false,
  component: () => <FleetView />,
});

registerRoute({
  path: CLUSTER_PATH,
  sidebar: SIDEBAR,
  name: 'vks-fleet-cluster',
  exact: true,
  useClusterURL: false,
  component: () => <ClusterDetail />,
});

// Settings are saved as they're edited through ConfigStore, so no Save button.
registerPluginSettings(PLUGIN_NAME, SettingsPanel, false);
