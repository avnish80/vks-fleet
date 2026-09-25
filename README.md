# vks-fleet — Headlamp plugin

A tenant-aware fleet view of VKS clusters, read from the Cluster API objects on a vSphere Supervisor. No fork of Headlamp, and nothing is installed on the workload clusters.

The same plugin serves both audiences. What each person sees is decided by their Supervisor RBAC, not by a mode in the UI:

- An **operator** with cluster-wide read on the Supervisor gets every namespace, grouped by tenant, plus tenant and Kubernetes-version rollups.
- A **tenant user** gets a 403 on the cluster-wide list, so the plugin reads only the namespaces configured in settings and shows just their clusters.

Phase 1 reads one Supervisor. The code is built for several (see "Extending to multiple Supervisors").

## What it shows

**Overview** (top of the fleet page, follows the tenant filter):

- headline tiles: clusters, nodes ready, node capacity, tenants, findings, upgrades
- cluster health (donut) and clusters by tenant (stacked bars; click a tenant to filter)
- Kubernetes versions in use and node capacity by tenant
- days left on control-plane certificates
- recent changes made through the plugin, from the `vks-fleet/last-action` stamps

The charts are plain SVG and CSS coloured from Headlamp's theme: no chart library, light and dark mode both work, and animations respect reduced-motion settings.

**Findings:** things an operator should know or do, each with what to do about it. They're computed from everything below, fleet-wide and per cluster:

- node VMs powered off
- automatic node repair stopped
- machines stuck deleting or provisioning
- control-plane certificates expiring, or rotation turned off
- paused clusters
- versions two or more minors behind, and available upgrades
- newer cluster classes
- a single control-plane node
- all nodes in one zone (when the Supervisor has several)
- namespace quotas over 80%
- Supervisor services with failing pods

**Fleet page:** every VKS cluster, grouped by tenant (VCFA organization by default), with:

- health, including problems the Supervisor can see, such as a machine stuck deleting
- Kubernetes version, and whether a newer release is available
- control plane and worker readiness
- a one-line summary from inside the cluster (nodes, failing pods, unavailable deployments)
- a link that opens the cluster in Headlamp's own views

With more than one tenant it adds a tenant rollup (including node capacity in vCPU and memory, from VM class sizes) and the spread of Kubernetes versions. Operators with Supervisor-wide access also see the Supervisor services (VKS, Velero, CCI and the others), with pod health and a link to their pods and logs in Headlamp.

**Machine page** (click a node in the Machines table):

- what's happening, in plain words, from the machine's conditions. For a stuck deletion, this is usually the drain message naming the pods and PodDisruptionBudget.
- machine details, drain start time and certificate expiry
- the VM: power, class and size, image, IP, zone, and its conditions
- when signed in to the cluster: the node (ready, cordoned, pressure, taints, capacity) and every pod on it, flagging pods a PodDisruptionBudget blocks from draining and pods **pinned** to the node (a hostname selector or affinity, or recreated on it after the drain started, which usually means `nodeName` in the owner's template), with links to the node and pods in Headlamp
- machine conditions (including the detailed newer form), events and the raw object
- actions: Replace, or Unblock deletion when it's stuck, and the pool's timeouts

**Cluster page:**

- summary: tenant, versions, upgrade, class (and whether a newer one exists), OS, VM and storage class, API endpoint, pod and service networks, certificate expiry and rotation, automatic node repair status, node capacity
- inside the cluster: problem pods, deployments not fully available, pod network-setup failures grouped by node (with the actual CNI error), warnings from the last hour
- node pools, including autoscaling limits
- machines, each with its VM's power state, class and size
- namespace quota usage
- troubleshooting links into Headlamp: the Cluster object's YAML, the namespace's pods, and the VKS controller pods and logs
- add-ons
- conditions
- Supervisor events for the cluster and its machines
- the raw Cluster object

## Actions

The cluster page can make changes on the Supervisor:

- **Pause / Resume:** stop or restart reconciliation, for example during maintenance.
- **Scale** a node pool: blocked for autoscaled pools.
- **Replace** a node. VKS only lets users change one thing on a Machine, the `cluster.x-k8s.io/remediate-machine` annotation, so machines covered by a MachineHealthCheck are replaced through it. The health check drains, deletes and recreates the node within its own limits. Other machines fall back to deleting the Machine. Blocked for the only control-plane node, while paused, or while automatic repair has stopped.
- **Unblock deletion**, on machines stuck deleting: sets a drain or volume-detach timeout on the machine's pool (`nodeDrainTimeout` / `nodeVolumeDetachTimeout` in the cluster's topology). The machine page detects which stage it's stuck in and pre-selects it. Cluster API passes the timeout down to the pool's machines, so it unblocks a deletion that's already stuck. It only writes to the Cluster. Clear it afterwards; the pool row shows it until you do.

Every action works the same way:

1. Its checks are shown, and any blocking check disables it.
2. A server-side dry run shows whether the Supervisor (RBAC and VKS admission webhooks) would accept it.
3. Risky actions need a reason, and destructive ones need the cluster name typed to confirm.
4. It runs with the signed-in user's own credentials, so tenants can only act on their own clusters.
5. It stamps the Cluster with a `vks-fleet/last-action` annotation: the time, what was done and why.

All action rules live in `src/actions.ts` as plain data (checks plus the exact writes), separate from the UI.

## Seeing inside a cluster

Headlamp's own features (workloads, logs, shell, events, YAML editing, map) work on any cluster Headlamp can reach. The plugin doesn't copy them. It links to them, and it reads a small health summary through the same connection.

To give Headlamp a VKS cluster, sign in to it with your own account on the machine running Headlamp:

```bash
kubectl vsphere login --server=<supervisor> --vsphere-username <you@domain> \
  --insecure-skip-tls-verify \
  --tanzu-kubernetes-cluster-namespace <namespace> \
  --tanzu-kubernetes-cluster-name <cluster>
docker restart headlamp   # container setup: reload the kubeconfig
```

The plugin matches that context to the fleet row by the cluster's API endpoint, so names don't need to be unique. Everything inside the cluster is read with the signed-in user's own permissions.

The admin kubeconfig secrets on the Supervisor are deliberately not used. They would give every viewer cluster-admin and bypass tenant isolation.

**Tenant names:** VCFA labels namespaces with organization IDs only, so the fleet shows a shortened ID until you name it. Add names under Settings → Plugins → vks-fleet → Tenant names, one per line as `<ID> = <name>`. Grouping always uses the ID, so adding or changing a name never regroups clusters.

## Build with GitHub Actions (no local npm needed)

`.github/workflows/build.yml` scaffolds, type-checks and builds the plugin on GitHub's runners:

- A push to `main` produces a `vks-fleet` artifact on the workflow run.
- Pushing a `v*` tag creates a release with `vks-fleet.tar.gz` attached.

Install the release on the machine running Headlamp:

```bash
curl -LO https://github.com/avnish80/vks-fleet/releases/latest/download/vks-fleet.tar.gz
tar -xzf vks-fleet.tar.gz -C ~/headlamp-plugins/     # creates ~/headlamp-plugins/vks-fleet/
docker restart headlamp
```

The type-check step doesn't block the build. If it shows red, the log lists what to fix.

## Setup (local build)

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

**On the Supervisor** (the configured Headlamp cluster):

- `cluster.x-k8s.io/v1beta1`: Clusters, MachineDeployments, Machines, MachineHealthChecks, and the ClusterClasses in the class namespace
- `vmoperator.vmware.com` (newest served version): VirtualMachines and VirtualMachineClasses
- ResourceQuotas
- Supervisor-wide access only: pods in the `svc-*` namespaces
- `controlplane.cluster.x-k8s.io/v1beta1`: KubeadmControlPlanes
- Kubernetes releases (`tanzukubernetesreleases`, or `kubernetesreleases`), for upgrade availability
- Namespaces, for tenant labels
- On the cluster page only: the ClusterBootstrap (add-ons) and the namespace's events

Each list tries cluster-wide first. On a 403 it falls back to the configured namespaces. Anything optional that fails becomes a warning, and the rest of the view still renders. A 401 (expired token) marks that Supervisor as failed without logging the user out of anything else.

**Inside a workload cluster** (only through a context the user signed in with), all read-only:

- `/version`
- nodes
- pods (up to 1000)
- deployments
- Warning events

The context list itself comes from Headlamp's `/config` endpoint.

## Code layout

Views never touch raw CAPI objects or Headlamp's API directly.

```
src/
  types.ts              Config, FleetCluster and WorkloadHealth models; clusterKey()
  config.ts             Settings normalization = the Supervisor registry; tenant names
  api/client.ts         SupervisorClient interface (GET a path on one cluster)
  api/headlampClient.ts The only ApiProxy calls in the plugin (cluster requests, /config)
  api/scopedList.ts     Cluster-wide list with per-namespace fallback on 403
  capi/v1beta1.ts       CAPI v1beta1 → FleetCluster (health, issues, pools, machines, network)
  tenancy.ts            Namespace → tenant ID, and ID → display name
  releases.ts           Kubernetes releases and upgrade detection
  supervisor.ts         Node VMs, VM class sizes, capacity, quotas, class currency, Supervisor services
  findings.ts           Findings rules: severity, what's wrong, what to do
  actions.ts            Action plans: checks, confirmations and the exact writes
  machine.ts            Machine page data: machine, VM, events; node, pods, drain blockers, pinned pods
  overview.ts           Numbers behind the overview tiles and charts
  selector.ts           Kubernetes label selector matching
  quantity.ts           Kubernetes quantity parsing
  fleet.ts              fetchSupervisor() (never throws), fetchFleet() fan-out
  contexts.ts           Match fleet clusters to Headlamp contexts by API endpoint
  workload.ts           Health from inside a workload cluster
  extras.ts             Cluster-page extras: add-ons, events, raw object
  summary.ts            Totals, tenant rollups, version spread
  useFleet.ts, useWorkload.ts, useClusterExtras.ts   Polling hooks
  routes.ts             URLs built from supervisor/namespace/name
  settings/             ConfigStore wrapper and settings form
  components/           FleetView, Overview, charts, ClusterDetail, MachineDetail, ActionDialog, shared bits
  index.tsx             Sidebar, routes, settings registration
```

Everything except the hooks, `api/headlampClient.ts`, `settings/` and `components/` is plain TypeScript with no Headlamp import, so it can be unit-tested with a fake `SupervisorClient`, or reused later by a server-side aggregator.

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

These Headlamp and VKS details were checked in CI or against a real Supervisor:

- `ApiProxy.request`, `ConfigStore`, route and sidebar registration, and the common components (v0.1.x builds)
- `noAuthRequired` on the home routes (without it the page stays blank)
- VCFA's `vmware-system-vcf/organization-id` namespace label, and the CAPI and VKS resource names

New in v0.5.0 and still to confirm on a live system:

- Headlamp's node and pod pages at `/c/<cluster>/nodes/<name>` and `/c/<cluster>/pods/<ns>/<name>`
- `nodeDrainTimeout` in the v1beta1 topology being propagated to machines that are already deleting

From v0.4.0, still to confirm:

- writes through `ApiProxy.request` with `method`, `headers` and `body` (PATCH merge and JSON patches, DELETE), and `?dryRun=All`
- VKS admission webhooks accepting changes to `spec.topology.workers.machineDeployments[].replicas` and `spec.paused` through `cluster.x-k8s.io/v1beta1`

From v0.3.0, still to confirm:

- the Headlamp link formats: pod list filtered by namespace (`/c/<cluster>/pods?namespace=<ns>`) and custom-resource pages (`/c/<cluster>/customresources/clusters.cluster.x-k8s.io/<ns>/<name>`)
- MachineHealthCheck status fields and the VM class `spec.hardware` sizes

From v0.2.0, still to confirm:

- that Headlamp's `/config` response includes each cluster's `server` (if not, contexts are matched by cluster name, when the name is unique in the fleet)
- the release objects' version field (`spec.version`)
- the ClusterBootstrap package fields (`spec.cni.refName` and similar)

## Known limits

- **CAPI version:** the plugin reads `cluster.x-k8s.io/v1beta1`. Current Supervisors prefer v1beta2 but still serve v1beta1. A v1beta2 translator can be added next to `capi/v1beta1.ts`.
- **Upgrade availability:** read from `tanzukubernetesreleases` (falling back to `kubernetesreleases`), skipping releases marked not ready or incompatible. The next minor version is preferred, since VKS upgrades one minor at a time.
- **Inside-cluster checks:** these fan out from the browser, at half the fleet refresh rate. Fine for tens of clusters; a larger fleet should use the server-side aggregator. Pod checks read at most 1000 pods per cluster.
- **Tokens expire:** tokens from `kubectl vsphere login` last about a working day. Expired ones show as "Sign-in expired".
