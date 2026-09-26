# vks-fleet — Headlamp plugin

A tenant-aware fleet view of VKS clusters, read from the Cluster API objects on a vSphere Supervisor. No fork of Headlamp, and nothing is installed on the workload clusters.

The same plugin serves both audiences. What each person sees is decided by their Supervisor RBAC, not by a mode in the UI:

- An **operator** with cluster-wide read on the Supervisor gets every namespace, grouped by tenant, plus tenant and Kubernetes-version rollups.
- A **tenant user** gets a 403 on the cluster-wide list, so the plugin reads only the namespaces configured in settings and shows just their clusters.

Phase 1 reads one Supervisor. The code is built for several (see "Extending to multiple Supervisors").

## Ways to run it

- **Operator deployment (recommended):** Headlamp inside a cluster (for example a small management VKS cluster), with the plugin from a ConfigMap, preset settings, and a job that keeps the Supervisor and cluster sign-ins fresh. See [`deploy/README.md`](deploy/README.md).
- **Desktop app or a jump server:** the plugin tarball in Headlamp's plugins folder, as described below.

**Preset settings:** a `config.json` in the plugin folder (same fields as the settings page) configures every browser that has no settings of its own. The deployment ships it from a ConfigMap. On a jump server you can drop one into `~/headlamp-plugins/vks-fleet/config.json`. The settings page shows when a preset is in use, and offers "Copy to edit" to override it for that browser.

## Who is signed in

The Supervisor's permissions are the boundary; the plugin adapts its view to them. At the top of every plugin page a bar shows who is signed in, worked out from the Supervisor's own answers to "can I?" checks:

| Persona | Signed in as | Sees | Can do |
|---|---|---|---|
| **Operator** | an admin account on the Supervisor | every org, with an **Org** switcher | every action |
| **Read-only admin** | an account that can list everywhere but not change clusters | every org, with an **Org** switcher | nothing: actions are hidden |
| **Tenant** | an org user through VCF Automation | only that org's namespaces and clusters | what the org role allows (an org admin can act) |

- **The Org switcher** scopes every plugin page (overview, issues, clusters, machines, packages, search, capacity, upgrades, baseline, cleanup, access) and is remembered between pages. When an operator narrows to one org, a note says actions still use operator rights.
- **Actions follow permissions:** buttons are hidden where the identity can't make changes.
- **Read-only view:** a setting (and the `readOnly` preset) turns actions off even for an account that could make changes, for example on a NOC screen.
- **Signed in as:** when this Headlamp holds more than one identity (for example the administrator context, a read-only account's context, and an org's VCF Automation contexts), the bar offers a switch between them. The plugin then reads and acts with the chosen account only, so the Supervisor or VCF Automation decides what's visible. The bar also shows the signed-in user name, from the API server's SelfSubjectReview.
  - `kubectl vsphere login` names the context after the Supervisor's address, so a second vSphere login overwrites the first. Rename after each login: `kubectl config rename-context 10.150.4.2 readonly@10.150.4.2`.
  - For shared instances, turn the switch off with `"identitySwitch": false` in the preset. A preset's `identitySwitch: false` and `readOnly: true` can't be undone from a browser.
- **Links to other views:** `"links": [{"label": "Read-only view", "url": "https://…"}]` in the preset (or the settings page) adds buttons to the bar, for moving between the per-persona instances.

**Keeping VCF Automation contexts signed in on a jump server.** Access tokens last about an hour, and `vcf context refresh` prompts for the API token, so cron re-creates the context from a file only root can read:

```bash
read -s TOKEN && printf '%s' "$TOKEN" > /root/.vcfa-org2-token && chmod 600 /root/.vcfa-org2-token && unset TOKEN
# crontab -e
*/45 * * * * vcf context create org2 --endpoint https://<vcf-automation> --api-token "$(cat /root/.vcfa-org2-token)" --tenant-name <org> --insecure-skip-tls-verify >/dev/null 2>&1 && docker restart headlamp
```

**Tenants through VCF Automation.** Org users live in VCF Automation, not vSphere SSO, so they sign in with the VCF CLI:

```bash
vcf context create org2 --endpoint https://<vcf-automation> --api-token <token> --tenant-name <org> [--insecure-skip-tls-verify]
```

This creates contexts named `<org>:<namespace>:<project>`, each pointing at VCF Automation's proxy for one namespace. The plugin finds them by itself. With no Supervisor configured, the orgs are used automatically; otherwise the settings page offers **Add**. Each namespace's requests go to its own context, and the org name is the tenant name. VCF Automation tokens last about an hour: refresh with `vcf context refresh <context>` (for example from cron), or use the deployment's tenant overlay, which refreshes every 30 minutes.

## What it shows

**Everything on the overview is clickable** and leads to the data behind it:

- the Clusters tile opens the clusters that need attention
- Nodes ready opens the fleet-wide Machines page (problems first)
- Capacity scrolls to the capacity table; Tenants to the tenant rollup
- Issues opens the issues; Upgrades lists the clusters that can be upgraded
- a health slice or a version bar filters the cluster list
- certificate, score and package bars open their source
- heatmap cells open that cluster's timeline for that day

Filters live in the URL (`?health=degraded`, `?version=v1.36.2+vmware.2`, `?upgradable=1`, `?tenant=…`), so a filtered view can be shared.

**Overview** (top of the fleet page, follows the tenant filter):

- headline tiles: clusters, nodes ready, node capacity, tenants, findings, upgrades
- cluster health (donut) and clusters by tenant (stacked bars; click a tenant to filter)
- Kubernetes versions in use and node capacity by tenant
- days left on control-plane certificates
- recent changes made through the plugin, from the `vks-fleet/last-action` stamps
- an activity heatmap: clusters × the last 7 days, each cell counting that day's changes and coloured by the most serious one

The charts are plain SVG and CSS coloured from Headlamp's theme: no chart library, light and dark mode both work, and animations respect reduced-motion settings.

**Issues:** findings and signals folded into problems with a cause. Each issue shows the evidence, what it affects (clusters, tenants, nodes, pods), what to do, and links to the right pages, plus **Copy diagnosis**: a Markdown write-up for a ticket, a chat or an AI assistant. Rules built from real incidents:

- a node whose pod networking fails, with the CNI error and the pods stuck there (critical when platform pods such as DNS or sign-in are hit)
- a deletion stuck for more than 30 minutes, with the pool's timeouts and the pods on the node
- automatic repair stopped
- a cluster API that can't be reached, or an expired sign-in
- failing pods not explained by a network problem
- a Supervisor service with failing pods (critical for the VKS service itself)

- cluster DNS (CoreDNS) down or degraded
- volume claims stuck Pending
- LoadBalancer services still without an external IP
- disks failing to attach to a node VM (from Supervisor warnings; ignored for nodes being deleted)

Findings that no rule explains are shown as their own issue, so nothing is hidden.

**Runbooks:** each issue has step-by-step commands, pre-filled with its Supervisor and cluster contexts, namespace, node and pod, each with a Copy button (and Copy all). They're included in Copy diagnosis.

**Every issue is clickable.** Its title and **Go to** button open the exact place:

- the machine's page, for stuck, powered-off or failing nodes
- the cluster page scrolled to the right section, with the row highlighted: the node pool with leftover timeouts, the certificate line, the machines, the quota
- the right dialog already open: Upgrade for version and class issues, Resume for a paused cluster, Timeouts for a pool
- the service's pods in Headlamp, for Supervisor services

Cluster page links take `?focus=<row>&action=<dialog>&pool=<pool>#<section>`, so they can also be shared.

**Checks:** a best-practice scorecard per cluster (0 to 100; a warning counts half; checks that need a sign-in don't count until they can run).

- Resilience: control plane of 3, zone spread, pools of 2 or more, node repair configured, PodDisruptionBudgets on replicated workloads
- Lifecycle: version current, class current, certificate rotation
- Operations: not paused, no leftover timeouts, backup (Velero) installed
- Security: no privileged pods, resource limits set, no `:latest` images (user namespaces only)

The overview shows the lowest scores; the cluster page shows every check with how to fix it.

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

**Anatomy** (cluster page): a diagram of the cluster's VKS layers: tenant namespace, cluster (version, class, API endpoint), control plane and node pools (readiness, VM class, timeouts), and every machine with its VM (power, IP, zone, class). Coloured by health; deleting machines are dashed with how long; click a machine to open it or a pool to jump to its row. Machine and pool names drop the repeated cluster prefix (`np-1-7d8jrvmbxh`); the full name is in the tooltip.

**Change audit:** who last changed the Cluster object and which parts (for example "VCF Automation: spec.topology.version", "kubectl (patch): spec.paused", "vks-fleet plugin: spec.topology.workers"), read from its managed fields, so it survives after events expire. Changes made through the plugin are recorded as `vks-fleet`. They also appear in the timeline.

**Upgrade planner** (sidebar: Upgrades, or the Upgrades tile): every cluster with its current version and a target (next minor or newest patch from the Supervisor's releases), an optional class move, and readiness. Readiness uses the same checks as a single upgrade plus whether the namespace quota has room for what a rolling upgrade adds. Clusters go into waves; the suggested plan puts the smallest upgradable cluster in wave 1 as a canary and the rest in wave 2. A wave:

- starts only when every earlier wave has finished healthy (all nodes on the target, not upgrading, cluster healthy)
- is dry-run for every cluster first, and applied only if all pass
- is applied one cluster after another, stopping at the first failure, with a reason and "wave N" typed to confirm
- shows progress per cluster (nodes on the new version)

The plan is kept per browser.

**Quotas and limits.** In VCF 9 with VCF Automation, quotas aren't Kubernetes ResourceQuotas on the Supervisor. They live in VCF Automation:

- **Per namespace:** the `SupervisorNamespace` object (namespace class plus overrides): a CPU limit in MHz, a memory limit, storage per storage class, allowed VM classes, per zone.
- **Per org:** `RegionStorageClassQuota` (the storage quota per region, and how much of it is allocated to namespaces).

The plugin reads these through the org-level VCF Automation context (`<org>`, created by `vcf context create`) of every org whose context Headlamp holds, whichever identity is active. It reads them read-only, every 5 minutes. Namespaces managed in vCenter instead record their limits on the namespace (`vmware-system-resource-pool-cpu-limit` and `-memory-limit`), and those are used when set.

Limits cap what VMs actually use. Best-effort VM classes reserve nothing, so VMs can be **configured** well beyond the limit: the Capacity page shows the **overcommit ratio**. A namespace configured with 110 GiB but limited to 19.5 GiB is 5.6× overcommitted, and under load its VMs share the 19.5 GiB (ballooning and swapping). Overcommit above 2× is a warning and above 4× critical. An org that has allocated more than 85% of a storage quota is a warning.

**Capacity** (sidebar: Capacity, or the Node capacity tile), per Supervisor namespace:

- **A resource table:** CPU, memory and each storage class, with **Limit** (VCF Automation or vCenter), **Allocated** (what nodes and VMs are configured with; for storage, what volumes request), **Consumed** (in use now: metrics-server for CPU and memory, the storage quota for storage) and **Free**. It notes when guests use more memory than the limit, which means ESXi is reclaiming memory.
- **Quota sources** at the top: for each VCF Automation org, which context the quota was read through and whether that worked, expired, or found no org-level context.

- quota against use, as bars
- the VM classes the namespace can use, with sizes
- what each cluster holds, and what it's using (metrics-server)
- the extra a rolling upgrade takes while it runs (one new node per pool plus one control-plane node), and whether quota has room
- a **what-if**: pick a cluster, pool, VM class and count, and see whether it fits each quota

The vSphere cluster's own free capacity isn't visible through the Supervisor API, so without a quota only the namespace's use is shown.

**Utilisation** (cluster page, from metrics-server when installed): CPU and memory against allocatable per node, the busiest pods, and user pods that request no CPU or memory. Nodes above 90% become issues with a runbook; the overview shows the busiest nodes across the fleet.

**Fleet baseline** (sidebar: Baseline): the standard every cluster should meet, edited on the page and kept with the plugin settings (an administrator can preset it in `config.json`):

- control plane of 3
- minimum nodes per pool
- certificate rotation on
- node health checks
- newest cluster class
- how many minor versions behind are allowed
- zone spread
- allowed VM and storage classes
- a successful backup within N hours

A compliance matrix shows every cluster against every rule. Safe fixes are applied from the matrix with the usual checks and dry run: grow the control plane to 3, or turn on certificate rotation through the cluster's `kubernetes` variable. Other drift links to the right dialog (Scale for a pool, Upgrade for the version or class).

**Cleanup** (sidebar: Cleanup): leftovers on the Supervisor, each with inspect and delete commands to review. The plugin deletes nothing itself.

- VMs, load balancer services and volume claims that name a cluster that no longer exists. Only objects that say which cluster they belong to are judged, so VM Service VMs are never listed.
- Volume claims that are Lost or stuck Pending.
- Clusters stuck deleting.
- Idle clusters: older than a week with nothing running outside platform namespaces.

**Access** (sidebar: Access, and a section on each cluster page): who can reach each Supervisor namespace, from its role bindings, with system accounts hidden by default. Each cluster has ready-to-send **connection instructions** for developers.

**Backups** (cluster page, and an overview card): Velero schedules, recent backups, and the last success and failure per signed-in cluster. A failed latest backup, or no success within the baseline's window while backups are scheduled, becomes an issue with a runbook. The scorecard's backup check now uses this.

**Namespaces** (sidebar: Namespaces): everything in each org's Supervisor namespaces, not just clusters, grouped by org. For operators it opens with a **Supervisor** panel: control-plane nodes (a single one is flagged as not highly available), ESXi hosts, versions. Each namespace page has:

- **A network map:** the VPC (private ranges, outbound NAT), each subnet with its range, usage and what's attached, and the public addresses in use.
- **The namespace's clusters, VMs and load balancers.**
- **Subnets and subnet sets** with address usage, counted from what's actually using addresses in that namespace (private ranges repeat across VPCs, so usage never mixes namespaces).
- **Security policies, static routes, NAT bindings and IP allocations,** and whether each applied.
- **Storage:** the storage policy quota per namespace, split by VM disks, snapshots and volumes, and the volumes with what uses each.
- **Access,** as on the cluster page.

**VMs** (sidebar: VMs): every VM Service VM, meaning VMs not belonging to a cluster (cluster nodes are on Machines). Each VM page shows state, class, image, IP and zone; interfaces and their subnets; the load balancers exposing it; disks, snapshots and conditions. Actions, with the usual checks and dry run: **Power on/off** (soft shutdown first), **Restart**, **Take snapshot**.

**Network** (sidebar: Network): the **load balancer map**, every VIP and what it serves (a cluster's API, a Service inside a cluster read from VKS's labels, or VMs by selector), plus all subnets by usage, VPCs, network objects, and NSX errors for operators.

New issues, each with a runbook:

- VMs not ready, off, or with snapshots older than a week
- subnets over 85% or 95% used, or not ready
- load balancers without an IP after 5 minutes
- network objects that didn't apply, and NSX errors
- storage quotas over 85%
- Supervisor nodes not ready

**Search** covers VMs (name, IP, image) and VIPs. For an IP it also names the subnet containing it, and whose VPC that is. The overview adds a **Subnet usage** card.

VPC networking (NSX VPCs, as in VCF 9) is supported. On Supervisors using other networking, the rest still works and the network sections say so. Everything reads through the same routing as the clusters, so VCF Automation tenants see their org's namespaces.

**Applications** (sidebar: Applications), across every signed-in cluster:

- Deployments, StatefulSets and DaemonSets outside platform namespaces, grouped by app name (`app.kubernetes.io/name`, `app`, or the workload's name), showing where each runs, readiness and images.
- **Image drift:** the same image at different versions in different clusters, for example `web` 1.4 in one and 1.5 in another. It's raised as a low-priority issue, since a staged rollout is often intended.
- **GitOps:** Argo CD Applications (sync and health) and Flux Kustomizations and HelmReleases (ready, suspended), with their revisions. Degraded or failed ones become issues with a runbook; out-of-sync is noted.

**Security** (sidebar: Security): a quick posture check per signed-in cluster. It's a first look, not a full audit:

- namespaces whose Pod Security level allows privileged pods, and those without a level
- privileged or host-level pods (host network, PID or IPC, hostPath volumes)
- cluster-admin granted to people or apps (system accounts are ignored)
- images from registries outside an **allowed list** (kept with the fleet baseline), and images on `latest`
- cert-manager certificates expiring within 21 days (critical within 7) or not ready

Each finding is also an issue with a runbook. The runbooks use server-side dry runs, for example trying a Pod Security level before enforcing it.

**Showback** (sidebar: Showback): what each org holds right now, for reporting and chargeback:

- cluster nodes and VM Service VMs sized by VM class (vCPU, memory)
- storage quota use and volumes
- load balancers and public addresses

Export as CSV (one row per org, dated) or Markdown. History over time needs the planned companion service.

**Expired sign-ins** are stated plainly, with the exact command: `vcf context refresh <org>` for VCF Automation tenants, `kubectl vsphere login …` for Supervisor sign-ins. A red banner appears in the bar at the top of every page.

**Machines page:** every machine across the fleet with its state, VM, IP, zone and version; machines that need a look come first.

**Export report:** Markdown (summary, issues needing action, clusters, tenants, versions) or CSV (one row per cluster), for the clusters currently shown.

**Timeline:** rebuilt from what the Supervisor records (creation, nodes added and deleting, condition changes, plugin actions, Supervisor events) with no storage needed. The cluster page lists it by day; the overview shows the last 7 days as one lane per cluster, with every dot clickable.

**Packages** (sidebar: VKS fleet, then Packages): the Carvel PackageInstalls in every signed-in cluster, which is how VKS and users install add-ons (CNI, CSI, sign-in, cert-manager, Velero):

- headline counts: installed, failing, updates available, drifting
- failing packages with kapp-controller's error
- a **version matrix** (package × cluster) showing where versions differ, newest in green
- newer versions offered by each cluster's package repositories

Failing packages become issues (critical for core packages such as the CNI, CSI or sign-in), and the scorecard gains "Packages reconcile" and "Packages up to date". The overview shows failing and drifting packages; each cluster page lists its packages.

**Search** (sidebar: VKS fleet, then Search, or **Search the fleet** on the fleet page): one box across the Supervisor and every signed-in cluster.

- a name or namespace (also matches container images): `nfs`, `nginx`
- a label selector, sent to the API server: `app=web`, `tier=db,env!=prod`
- an IP address: pod, service, load balancer, node, machine or cluster API endpoint
- `kind:pod`, `kind:machine` and so on to narrow

Results link to the plugin's cluster and machine pages, or to Headlamp's own page for the object. The query stays in the URL, so searches can be shared.

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

- **Upgrade:** pick a target from the releases the Supervisor actually offers, one minor version at a time, and optionally move to the newer ClusterClass. The preflight checks:
  - blocking: already upgrading, paused, failed, stuck machines, automatic repair stopped
  - warnings: single control plane, pool drain timeouts, PodDisruptionBudgets currently allowing no disruptions (checked live inside the cluster), nearly-full quota

  The version change is a guarded JSON patch (it fails if the version changed meanwhile). The cluster page then shows upgrade progress per control plane and node pool.
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

## Multiple Supervisors

Add as many Supervisors as you like in the plugin settings, each with its own namespaces, tenant label and tenant names. Every cluster key and URL carries the Supervisor ID, and they're read in parallel: an unreachable Supervisor shows an error banner and "Unreachable" in the overview while the rest of the fleet keeps working. With more than one, the fleet page adds a Supervisor filter, a Supervisor column and a "Clusters by Supervisor" chart.

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
- **Leftover timeouts:** a drain timeout under 5 minutes, or any volume-detach timeout, left on a pool with nothing deleting becomes a warning finding, so an unblocking fix isn't forgotten.
- **Upgrade availability:** read from `tanzukubernetesreleases` (falling back to `kubernetesreleases`), skipping releases marked not ready or incompatible. The next minor version is preferred, since VKS upgrades one minor at a time.
- **Packages and search** also fan out from the browser: packages every 3 minutes per signed-in cluster, search once per query across nine kinds (up to 50 hits per kind per cluster).
- **Inside-cluster checks:** these fan out from the browser, at half the fleet refresh rate. Fine for tens of clusters; a larger fleet should use the server-side aggregator. Pod checks read at most 1000 pods per cluster.
- **Tokens expire:** tokens from `kubectl vsphere login` last about a working day. Expired ones show as "Sign-in expired".
