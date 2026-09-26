import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { Baseline } from '../complianceReport';

/** Saved compliance baselines per cluster (this browser), for drift. */
export const complianceStore = new ConfigStore<{ baselines?: Record<string, Baseline> }>('vks-fleet-compliance');
export const useComplianceStore = complianceStore.useConfig();
