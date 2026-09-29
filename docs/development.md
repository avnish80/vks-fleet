# Development and reference

[← Back to the README](../README.md)

## Tests

```bash
npx tsx --test tests/*.test.ts
```

`tests/` uses Node's built-in test runner; `tsx` is the only tool needed. It covers:

- **An end-to-end run** of the plugin's real fetchers and rules on the demo fleet: fleet, orgs, persona, inventory, context matching, Pod Security default, compliance, kube-bench, issues, demo writes.
- **Focused rule tests,** including regressions found in real use:
  - unreadable data scored as passing
  - false Pod Security findings on VKS
  - kube-bench misdetecting VKS as TKGI
  - a stuck node scan crashing
- **The request limiter** and the "not installed" memory.

The GitHub build runs them before building. **A failing test stops the release.**

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
  issues.ts             Issues: findings and signals folded into causes; Copy diagnosis
  checks.ts             Best-practice scorecard per cluster
  timeline.ts           History rebuilt from timestamps
  runbooks.ts           Pre-filled commands for each kind of issue
  report.ts             Fleet report: Markdown and CSV
  headroom.ts           Quota headroom, what-if, upgrade surge
  planner.ts            Upgrade waves: readiness, suggestions, status and gating
  baseline.ts           Fleet standard, drift per cluster, fixes
  cleanup.ts            Leftovers on the Supervisor
  backups.ts            Velero status per cluster
  access.ts             Namespace access and connection instructions
  persona.ts            Who is signed in, from SelfSubjectAccessReview
  vcfa.ts               VCF Automation org contexts and per-namespace routing
  scope.ts              Org scoping for the switcher
  inventory.ts          VMs, load balancers, VPC networking, storage, Supervisor nodes
  inventoryIssues.ts    Issues and runbooks for those
  ip.ts                 IPv4 and CIDR helpers
  clusterScan.ts        Applications, security posture and GitOps from each signed-in cluster
  scanIssues.ts         Issues and runbooks for those
  showback.ts           Per-org allocation report
  pss.ts                Pod Security Standards evaluator (baseline, restricted)
  guestActions.ts       In-cluster actions: Pod Security, network policies, package update/pause/reconcile
  silences.ts           Silences and maintenance mode
  awareness.ts          Since-last-visit and command palette helpers
  compliance.ts         CIS-aligned controls, evidence parsing and evaluation
  complianceReport.ts   Drift, compliance issues, evidence exports
  nodeScan.ts           kube-bench Jobs, result parsing and history
  nodeScanRunner.ts     Node scan orchestration (namespace, Jobs, results, clean-up)
  isolation.ts          Tenant isolation report
  scanners.ts           Trivy Operator and PolicyReport/OpenReports parsing, fleet CVE aggregation
  scannerIssues.ts      Issues from scanner reports
  components/InvestigatePage.tsx  Investigate: timeline beside the walk-down
  preflight.ts          Change impact analysis: checks, capacity during and after, blast radius, verdict
  fleetHero.ts          The fleet page's hero band: at a glance, needs you now, the next 30 days
  hostmap.ts            The Supervisor by host, and what a host failure takes down
  explain.ts            Walk-down across layers (pod → node → Machine → VM → host → namespace → Supervisor), host patterns
  incident.ts           Incident timeline, summary with a suggested trigger, post-mortem draft
  vcenterStatus.ts      vCenter's view from the collector: reading, matching, scoring, issues
  elevation.ts          Read by default, elevate to change: time-boxed, with a reason; change contexts; stamping
  supervisorHealth.ts   Supervisor health: leases, service pods and leftovers, placement, backlog, score, issues, clean-up
  compare.ts            Right-sizing (requests vs p95 use, node count, overcommit) and the same app across clusters
  observability.ts      Monitoring-stack discovery, Prometheus queries via the API proxy, panels, forecasts, alerts as issues
  provision.ts          VM and cluster manifests, capacity preview, create plans, YAML output
  packageInstall.ts     Package install and removal plans (VCF CLI style)
  valuesSchema.ts       Values form from a package's OpenAPI schema
  demo/                 Demo mode: a small Kubernetes API over in-memory objects (router.ts) and the fictional fleet (supervisor.ts, guest.ts)
  api/limiter.ts        Concurrency caps and per-cluster request statistics
  api/served.ts         Remembers resources that aren't installed and which API versions answer
  components/Guard.tsx  Error boundary: a failing section shows what failed, the page keeps working
tests/                  Node test runner suites (demo pipeline, rules, limiter)
  fleetContext.tsx      Shared page data: settings, fleet, personas, selected org
  packages.ts           Package inventory, updates and fleet drift
  search.ts             Fleet-wide search: query parsing, Supervisor and in-cluster matching
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
  settings/             ConfigStore wrapper, settings form, preset config.json loader
deploy/                 In-cluster operator deployment (kustomize) and the sign-in refresher
  components/           FleetView, Overview, charts, ClusterDetail, MachineDetail, ActionDialog, shared bits
  index.tsx             Sidebar, routes, settings registration
```

Everything except the hooks, `api/headlampClient.ts`, `settings/` and `components/` is plain TypeScript with no Headlamp import, so it can be unit-tested with a fake `SupervisorClient`, or reused later by a server-side aggregator.

## Extending to CAPI v1beta2

Add `capi/v1beta2.ts` that produces the same `FleetCluster` model, and choose between the two translators in `fleet.ts`.

## Known limits

- **CAPI version:** the plugin reads `cluster.x-k8s.io/v1beta1`. Current Supervisors prefer v1beta2 but still serve v1beta1. A v1beta2 translator can be added next to `capi/v1beta1.ts`.
- **Leftover timeouts:** a drain timeout under 5 minutes, or any volume-detach timeout, left on a pool with nothing deleting becomes a warning finding, so an unblocking fix isn't forgotten.
- **Upgrade availability:** read from `tanzukubernetesreleases` (falling back to `kubernetesreleases`), skipping releases marked not ready or incompatible. The next minor version is preferred, since VKS upgrades one minor at a time.
- **Packages and search** also fan out from the browser: packages every 3 minutes per signed-in cluster, search once per query across nine kinds (up to 50 hits per kind per cluster).
- **Inside-cluster checks:** these fan out from the browser, at half the fleet refresh rate. Fine for tens of clusters; a larger fleet should use the server-side aggregator. Pod checks read at most 1000 pods per cluster.
- **Tokens expire:** tokens from `kubectl vsphere login` last about a working day. Expired ones show as "Sign-in expired".
