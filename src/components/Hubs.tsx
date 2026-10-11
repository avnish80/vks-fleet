import React, { ReactNode } from 'react';
import { ACCESS_PATH, BASELINE_PATH, CAPACITY_PATH, CLEANUP_PATH, COMPLIANCE_ROUTE, MACHINES_PATH, PACKAGES_PATH, PREFLIGHT_PATH, SECURITY_OVERVIEW_ROUTE, SECURITY_ROUTE, SHOWBACK_PATH, UPGRADES_PATH, VM_BASE, VULNS_ROUTE } from '../routes';
import { AccessPage } from './AccessPanel';
import { BaselinePage } from './BaselinePage';
import { CapacityPage } from './CapacityPage';
import { CleanupPage } from './CleanupPage';
import { CompliancePage } from './CompliancePage';
import { Hub } from './Hub';
import { SecurityPage, ShowbackPage } from './InsightPages';
import { SecurityOverviewPage } from './SecurityOverview';
import { MachinesPage } from './MachinesPage';
import { VmsPage } from './NamespacePages';
import { PackagesPage } from './PackagesPage';
import { PreflightPage } from './PreflightPage';
import { UpgradePlannerPage } from './UpgradePlannerPage';
import { VulnerabilitiesPage } from './VulnerabilitiesPage';

export const ComputeHub = ({ children }: { children?: ReactNode }) => (
  <Hub
    title="Compute"
    blurb="The machines that make up every cluster, and the VM Service VMs beside them."
    tabs={[
      { label: 'Nodes', path: MACHINES_PATH, render: () => <MachinesPage /> },
      { label: 'VMs', path: VM_BASE, render: () => <VmsPage /> },
    ]}
  >
    {children}
  </Hub>
);

export const SecurityHub = ({ children }: { children?: ReactNode }) => (
  <Hub
    title="Security"
    blurb="How secure the fleet is in one place, then posture inside the clusters, CIS-aligned compliance with evidence, and image vulnerabilities from Trivy."
    tabs={[
      { label: 'Overview', path: SECURITY_OVERVIEW_ROUTE, render: () => <SecurityOverviewPage /> },
      { label: 'Posture', path: SECURITY_ROUTE, render: () => <SecurityPage /> },
      { label: 'Compliance', path: COMPLIANCE_ROUTE, render: () => <CompliancePage /> },
      { label: 'Vulnerabilities', path: VULNS_ROUTE, render: () => <VulnerabilitiesPage /> },
    ]}
  >
    {children}
  </Hub>
);

export const LifecycleHub = ({ children }: { children?: ReactNode }) => (
  <Hub
    title="Lifecycle"
    blurb="Packages in every cluster, Kubernetes upgrades planned in waves, and a pre-flight for any change before you start it."
    tabs={[
      { label: 'Packages', path: PACKAGES_PATH, render: () => <PackagesPage /> },
      { label: 'Upgrades', path: UPGRADES_PATH, render: () => <UpgradePlannerPage /> },
      { label: 'Pre-flight', path: PREFLIGHT_PATH, render: () => <PreflightPage /> },
    ]}
  >
    {children}
  </Hub>
);

export const CapacityHub = ({ children }: { children?: ReactNode }) => (
  <Hub
    title="Capacity & cost"
    blurb="Quotas, headroom and what-if per org, and what each org's allocation adds up to."
    tabs={[
      { label: 'Capacity', path: CAPACITY_PATH, render: () => <CapacityPage /> },
      { label: 'Showback', path: SHOWBACK_PATH, render: () => <ShowbackPage /> },
    ]}
  >
    {children}
  </Hub>
);

export const GovernanceHub = ({ children }: { children?: ReactNode }) => (
  <Hub
    title="Governance"
    blurb="The fleet standard and drift from it, leftovers on the Supervisor, and who has access where."
    tabs={[
      { label: 'Baseline', path: BASELINE_PATH, render: () => <BaselinePage /> },
      { label: 'Cleanup', path: CLEANUP_PATH, render: () => <CleanupPage /> },
      { label: 'Access', path: ACCESS_PATH, render: () => <AccessPage /> },
    ]}
  >
    {children}
  </Hub>
);
