# vks-fleet — Headlamp plugin

A tenant-aware fleet view of VKS clusters, read from the Cluster API objects on a vSphere Supervisor. No fork of Headlamp, and nothing is installed on the workload clusters.

The same plugin serves both audiences. What each person sees is decided by their Supervisor RBAC, not by a mode in the UI:

- An **operator** with cluster-wide read on the Supervisor gets every namespace, grouped by tenant, plus tenant and Kubernetes-version rollups.
- A **tenant user** gets a 403 on the cluster-wide list, so the plugin reads only the namespaces configured in settings and shows just their clusters.

Phase 1 reads one Supervisor. The code is built for several (see "Extending to multiple Supervisors").

## Setup

This folder holds only `src/`. Scaffold the plugin so you get the `package.json` and `tsconfig.json` that match your Headlamp release, then drop the source in:

```bash
npx --yes @kinvolk/headlamp-plugin create vks-fleet
cd vks-fleet
rm -rf src && cp -r /path/to/this/src ./src
npm run tsc      # type-check against the real Headlamp types first
npm start        # dev mode; the Headlamp desktop app picks up the plugin
```

The plugin name must stay `vks-fleet`, because the settings store is keyed by it.

In Headlamp, add the Supervisor as a cluster (the kubeconfig context your VCF CLI or `kubectl vsphere login` created). Then open **Settings → Plugins → vks-fleet**:

| Setting | Meaning |
|---|---|
| Headlamp cluster for the Supervisor | The cluster name exactly as Headlamp shows it. |
| Supervisor ID | Stable, lowercase ID used in cluster links. Set once. |
| Namespaces | Read when the account can't list cluster-wide (tenant users). |
| Tenant label key | Namespace label whose value names the tenant. Empty means each namespace is its own tenant. |

**Tenant label:** check which labels VCFA puts on the Supervisor namespaces it creates, and use a stable one. If nothing reliable exists, label the namespaces yourself. Namespaces without the label appear under their own name, with a note in the UI.

## What it reads

All reads target the Supervisor only:

- `cluster.x-k8s.io/v1beta1` Clusters and MachineDeployments
- `controlplane.cluster.x-k8s.io/v1beta1` KubeadmControlPlanes
- Namespaces (only when a tenant label key is set)

Each list tries cluster-wide first. On a 403 it falls back to the configured namespaces. A denied namespace, a missing MachineDeployment list or unreadable labels become warnings, and the rest of the view still renders. A 401 (expired token) marks that Supervisor as failed without logging the user out of anything else.

## Code layout

Views never touch raw CAPI objects or Headlamp's API directly.

```
src/
  types.ts              Config and the normalized FleetCluster model; clusterKey()
  config.ts             Settings normalization = the Supervisor registry
  api/client.ts         SupervisorClient interface (GET a path on one Supervisor)
  api/headlampClient.ts The only ApiProxy call in the plugin
  api/scopedList.ts     Cluster-wide list with per-namespace fallback on 403
  capi/v1beta1.ts       CAPI v1beta1 → FleetCluster (health, upgrade, replicas)
  tenancy.ts            Namespace → tenant resolver (swappable)
  fleet.ts              fetchSupervisor() (never throws), fetchFleet() fan-out
  summary.ts            Totals, tenant rollups, version spread
  useFleet.ts           Polling hook
  routes.ts             URLs built from supervisor/namespace/name
  settings/             ConfigStore wrapper and settings form
  components/           FleetView, ClusterDetail, shared bits
  index.tsx             Sidebar, routes, settings registration
```

Everything above `useFleet.ts` except `api/headlampClient.ts` is plain TypeScript with no Headlamp import, so it can be unit-tested with a fake `SupervisorClient`, or reused later by a server-side aggregator.

## Extending to multiple Supervisors

These are already multi-Supervisor:

- The config stores an array.
- Every cluster key and URL carries the Supervisor ID.
- `fetchFleet` fans out in parallel and isolates failures per Supervisor.
- The UI adds a Supervisor column and filter once there's more than one.

What's left:

1. `settings/SettingsPanel.tsx`: render the form per entry, with add and remove.
2. Optionally, a Supervisor filter in `FleetView.tsx` next to the tenant filter.

Nothing else should need to change.

## Extending to CAPI v1beta2

Add `capi/v1beta2.ts` that produces the same `FleetCluster` model, and choose between the two translators in `fleet.ts`.

## Verify first

I couldn't compile this against Headlamp's real types in the environment where it was written. The pure logic was type-checked and exercised against fake operator, tenant and expired-token Supervisors. The Headlamp-specific pieces to confirm on your release are:

- `ApiProxy.request(path, { cluster }, false)` in `api/headlampClient.ts`
- `ConfigStore(...).useConfig()` in `settings/store.ts`
- The `sidebar: 'HOME'` and `useClusterURL: false` options in `index.tsx`
- The `SectionBox` `headerProps.actions`, `SimpleTable`, `StatusLabel` and `NameValueTable` props used in `components/`

`npm run tsc` will flag any mismatch.

## Known limits (phase 1)

- The Supervisor token comes from the kubeconfig and expires. An in-cluster, multi-user deployment needs an OIDC flow; that's deliberately kept out of the plugin code.
- Workload-level rollups (pods, deployments) need the Layer 2 aggregator and are not included.
- Upgrade detection compares the topology version with the control plane and MachineDeployment versions, and reads the `TopologyReconciled` condition's `UpgradePending` reasons.
