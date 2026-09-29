# vks-fleet — Headlamp plugin

A tenant-aware fleet view for VKS: clusters, VMs, networks, capacity, packages, security, compliance and vulnerabilities across one or more vSphere Supervisors, read through public Kubernetes APIs (Cluster API, VM Operator, NSX VPC, Carvel, VCF Automation's Kubernetes API). No fork of Headlamp. Nothing is installed in the clusters unless you ask for it: the optional kube-bench node scan, or a package install.

The same plugin serves every audience. What each person sees and can do is decided by their own RBAC, not by a mode in the UI:

- **Operators** with cluster-wide read on the Supervisor get every org, with rollups, a switcher and fleet-wide actions.
- **Read-only admins** see everything and change nothing.
- **Tenant users** (directly or through VCF Automation) see only their own org's namespaces and clusters.

**Try it without a lab:** Settings → Demo mode shows a fictional fleet (see [Demo mode](#demo-mode)).

> **Independent project.** vks-fleet is a personal open-source project. It is not a VMware or Broadcom product, and it is not affiliated with, endorsed by or supported by Broadcom. VMware, vSphere, VCF, VKS and related names are trademarks of Broadcom and are used here only to describe what the plugin works with. The plugin uses only publicly documented APIs.

## The pages

The sidebar has eleven entries. Five are hubs with tabs, each keeping what used to be separate pages under one header; every old link still opens the right tab.

| Entry | What's in it |
|---|---|
| **VKS fleet** | The fleet page: org cards, overview, clusters, issues |
| **Supervisor health** | The platform itself: controllers, services, placement, hosts, vCenter's view |
| **Namespaces** | Per-org namespaces, quotas, VMs, networks; New VM… and New cluster… |
| **Compute** | Nodes (machines) · VMs |
| **Network** | VPCs, subnets, load balancers, NSX objects |
| **Applications** | Apps across clusters, image drift, GitOps |
| **Observability** | Prometheus charts with change markers, forecasts, alerts, right-sizing, comparisons |
| **Investigate** | One cluster's timeline with a post-mortem draft, beside the walk-down through its layers |
| **Security** | Posture · Compliance · Vulnerabilities |
| **Lifecycle** | Packages · Upgrades |
| **Capacity & cost** | Capacity · Showback |
| **Governance** | Baseline · Cleanup · Access |

Search is one keystroke away everywhere: **Ctrl+K**.

**Built for fleets.** Pages that cover every cluster show a **fleet roll-up first** (for example, the compliance controls failing across the fleet: one failing in 17 of 20 clusters is one problem to fix once), then **one compact row per cluster** with its counts, clusters needing attention first. Expanding a row shows its first rows, most important first; **Show all** opens the full table in a dialog. Long lists (nodes, namespaces, repositories, issues) have a **filter box and paging**. To see every page at scale, turn on demo mode and set **Demo fleet size** to 20 or 50 clusters.

The plugin follows Headlamp's theme, light or dark: every colour comes from the theme, and charts, markers and status chips are legible on both.

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

- **Org cards** at the top of the fleet page, one per org plus "All orgs". Each shows its namespaces, clusters (and how many need attention), VMs, storage used against quota, and memory against the namespace limits. Click one to scope everything to that org, and again (or All orgs) to go back. Orgs with only VMs are included. With an org selected, an **org summary** shows its VCF Automation org quota and each namespace's class, memory against limit and storage, with shortcuts to Capacity, Security and Showback. The choice goes into the address (`?org=…`), so a link opens on the same org.
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

**Working with the fleet day to day:**

- **Ctrl+K (⌘K)** on any VKS fleet page opens a command palette: jump to any page, cluster, VM (by name or IP) or namespace, or search the fleet.
- **Since your last visit:** a banner on the fleet page lists issues that are new and ones that were resolved since you last marked them as seen.
- **Desktop notifications:** an opt-in browser notification for each new critical issue while the fleet page is open.
- **Silences:** mute one issue ("Silence…" on any issue card) or a whole cluster ("Maintenance…" on its page), for anything from an hour to 90 days, with a reason. Silenced issues move out of the counts but stay listed under "Silences", where they can be ended early. Silences live with the plugin settings, so an administrator can preset them.
- **A sign-in helper** on every page that reads inside clusters: which clusters can't be read (never signed in, or expired) and the exact login commands, with a single copy.

**Security** (sidebar: Security): a quick posture check per signed-in cluster. It's a first look, not a full audit:

- namespaces whose Pod Security level allows privileged pods, and those without a level
- privileged or host-level pods (host network, PID or IPC, hostPath volumes)
- cluster-admin granted to people or apps (system accounts are ignored)
- images from registries outside an **allowed list** (kept with the fleet baseline), and images on `latest`
- cert-manager certificates expiring within 21 days (critical within 7) or not ready

Also checked:

- cluster roles that allow everything, or read every Secret, bound to people or apps
- pods that may run as root
- namespaces without a NetworkPolicy
- services exposed outside the cluster (LoadBalancer and NodePort)

A **fleet matrix** shows every cluster against every check.

**Namespace actions** (each with a dry run):

- **Pod Security…** picks a level (baseline or restricted) and a mode (warn and audit only, or enforce), with a **preview** of exactly which running pods break it and why. The preview comes from the plugin's own evaluation of the Pod Security Standards.
- **Isolate** adds a NetworkPolicy that denies traffic from other namespaces.
- **Deny all** denies all incoming traffic.

**Accept…** silences a finding with a reason and an expiry (an accepted exception). **Export CSV** lists all findings, including accepted ones with their reasons, for audits.

Each finding is also an issue with a runbook. The runbooks use server-side dry runs, for example trying a Pod Security level before enforcing it.

**Compliance** (sidebar: Compliance): 53 checks aligned with the CIS Kubernetes Benchmark, evaluated through the Kubernetes API, with nothing installed in the clusters:

- **Control plane** (API server, controller manager, scheduler, etcd): flags read from the static pods' command lines. Covers authorization, admission plugins, profiling, TLS to etcd and kubelets, encryption at rest, and audit logging and retention.
- **Worker nodes:** each kubelet's live configuration (`nodes/<node>/proxy/configz`, up to six nodes per cluster). Covers anonymous auth, Webhook authorization, the client CA, the read-only port, streaming timeouts, certificate rotation and kernel defaults.
- **Policies:** RBAC (cluster-admin, Secret readers, wildcards, pod creation, bind/escalate/impersonate, system:masters), default service-account tokens, Pod Security (admission levels, privileged, host namespaces, escalation, root, capabilities, hostPath, host ports), network policies, Secrets as environment variables, seccomp, and use of the default namespace.

Each control shows its **owner**: **VKS** (platform configuration, set by VKS), **you** (how the cluster is used) or **shared**. So a report separates what the platform already handles from what the team must fix.

- **Honest scoring.** Checks that need a node-level scan (file permissions) are marked "needs node scan". Data that can't be read is "not readable". Neither ever counts as a pass, and every score says how many checks it covers.
- **The page:** a fleet score, a clusters × sections matrix, filters (owner, level, failing only), and per control the evidence, the remediation, and **Waive…** (an accepted risk with a reason and an expiry of up to a year).
- **Drift:** save a baseline per cluster, and changes since then are shown. A control that goes from pass to fail becomes an issue.
- **Evidence exports** for auditors: Markdown (a summary plus every control per cluster, with waivers) and CSV.

Titles are the plugin's own, and each control references the CIS section it aligns with. This is not a certified CIS assessment.

**Node scan (kube-bench).** **Run node scan…** on a cluster's Compliance section runs **kube-bench**, the open-source CIS scanner, for the file-permission and ownership checks the API can't see:

- **What it creates:** a `vks-fleet-scan` namespace, labelled privileged for Pod Security, because kube-bench reads host files through host PID and read-only host paths. Then two short-lived Jobs: one on a control-plane node, which tolerates the control-plane taint, and one on a worker.
- **Dry run first,** then each step is shown as it happens. Image pull failures ("mirror the image for air-gapped sites") and scheduling problems are reported clearly.
- **Results** are summarised into the `vks-fleet-scan/kube-bench-results` ConfigMap, which keeps the last 5 runs per target **in the cluster itself**. The Jobs are deleted afterwards (and expire within the hour regardless).
- **In the benchmark:** the file-permission controls take their result from the latest scan, and the cluster section lists every kube-bench check (failures and warnings first) with what was found and the remediation.
- **The image** defaults to `docker.io/aquasec/kube-bench:latest`; set your own mirrored and pinned image in the dialog, and it's remembered.
- **The benchmark** defaults to `cis-1.10` and can be changed in the dialog. kube-bench guesses the benchmark from the Kubernetes version and mistakes VKS (`+vmware`) for TKGI, whose checks look for paths VKS nodes don't have. Results from such foreign benchmarks are flagged and not counted.
- **A slow or stuck scan** shows the pod's latest event as it waits (a large image pulling, or `FailedCreatePodSandBox` when pod networking is broken on the node) and reports it if the scan times out.

**Frameworks and OSCAL.** The Compliance page switches between **CIS-aligned** and **NSA/CISA hardening**, the NSA/CISA Kubernetes Hardening Guidance with its sections: pod security; network separation and hardening; authentication and authorization; audit logging; application practices. Two further controls:

- **Read-only root filesystems.**
- **A resource quota or limit range per namespace with workloads,** which is NSA/CISA only.

Besides Markdown and CSV, **OSCAL** exports the results as OSCAL 1.1 Assessment Results (JSON): an observation per control with its evidence, findings for passes and failures, and waivers as risks with an approved deviation and its deadline. Compliance and GRC tools can take it in directly.

**Scanner reports (read-only).** The plugin gathers what security tools already write into the clusters:

- **Vulnerabilities** (sidebar), from **Trivy Operator**:
  - totals of critical and high CVEs
  - **the top CVEs across the fleet**: which clusters, images and workloads, and the fixed version when there is one
  - every scanned image with its counts
  - **secrets baked into images** (counts only; the matched text is never read into the plugin)
  - Trivy's workload configuration audits
  - a CSV export

  Clusters without Trivy Operator are listed with the Helm command to install it.
- **Owner tagging.** Images from VKS releases and standard packages (`vsphere/supervisor/…`, `vsphere/vksm/…`, `localhost:5000/tkg/…`), and images in platform namespaces, are **VKS-managed**: they're fixed by a newer package version or VKS release, not by rebuilding. The page shows **your images** by default, and a **VKS-managed images** summary grouped by source (for example "vks-standard-packages 3.7.0-20260618: 4 images, 70 critical, fixes published upstream"), with links to Packages and Upgrades. Configuration audits are split the same way. Only your images raise the critical-CVE warning; VKS-managed ones raise a single informational issue.
- **On the Compliance page:** Trivy's own compliance reports (its CIS and NSA runs), and **policy results** from Kyverno or any engine writing PolicyReports (`wgpolicyk8s.io`) or OpenReports (`openreports.io`), with the failing and warning results.
- **Issues:** images with critical CVEs (a warning when fixes exist), secrets found in images (critical), and failing policy results.

**Tenant isolation** (on the Compliance page, for operators and read-only admins): a per-org check, from the Supervisor's view, that orgs are separated:

- **Own VPC:** a VPC name and outbound NAT address not used by another org.
- **Public addresses not shared:** load balancer VIPs and VMs on public subnets.
- **Routed ranges don't overlap:** public ranges must not; transit-gateway ranges are flagged for review, since they only conflict if the orgs share a gateway. Private VPC ranges may repeat by design.
- **No shared subnets.**
- **No people with access to more than one org:** fine for platform administrators, worth checking otherwise.
- **Firewall policies present and applied.**

Failures become fleet issues, and a Markdown report can be downloaded.

**Pod Security cluster default.** VKS enforces the **restricted** level on namespaces without a Pod Security label, a cluster-wide default that isn't visible through the API. The plugin finds it with two server-side dry-run pod creations in an unlabelled namespace; they create nothing. Namespaces then show their effective level ("restricted (cluster default)"), and the compliance control counts namespaces by label and by default. The "no Pod Security label" finding only appears when the default couldn't be checked, for example for users who can't create pods. Enforcing a level the default already applies is still allowed: the label pins it, so a later change of default won't weaken the namespace.

**Two operational checks inside clusters:**

- **Default StorageClass:** none marked default means volume claims without a class stay Pending forever (many Helm charts rely on one); several defaults make it unpredictable. The issue comes with the command to set one.
- **Pods stuck on one node:** two or more pods stuck creating or terminating for over three minutes on the same node usually means that node's pod networking (Multus, then Calico or Antrea) has stalled. The runbook finds the node's CNI pods, restarts Multus there, and clears pods stuck terminating.

**Sign-in commands** use the signed-in user's name, so they run without editing.

**Keeping sign-ins fresh on a jump server.** Supervisor and cluster sign-ins last about 10 hours. A small script refreshes them (and the VCF Automation context) and restarts Headlamp; a systemd timer runs it every 45 minutes:

```bash
# /root/vks-refresh.sh (chmod 700): KUBECTL_VSPHERE_PASSWORD from /root/.vsphere-pass (chmod 600),
# then kubectl vsphere login for the Supervisor and each cluster, then: docker restart headlamp
# /etc/systemd/system/vks-refresh.service: Type=oneshot, Environment=HOME=/root, ExecStart=/root/vks-refresh.sh
# /etc/systemd/system/vks-refresh.timer:   OnBootSec=2min, OnUnitActiveSec=45min
systemctl enable --now vks-refresh.timer
```

Use a dedicated account with only the rights the plugin needs, not Administrator.

**Pages that read inside clusters** (Security, Applications, Packages, Compliance) say so plainly when the selected org has no VKS clusters, instead of waiting. **Orgs shown only by their ID** get a "Name this org" button on their card; names are kept with the plugin settings and apply everywhere.

**Installing packages.** On the Packages page, each **Catalog** entry has **Install…** for the clusters that offer it and don't have it yet:

- **Choose** the clusters, the version (from those every chosen cluster offers), the namespace (normally the repository's own) and the install name.
- **Values** come from a **form generated from the package's own values schema**: typed fields, allowed values as choices, defaults shown, descriptions as help. Only settings you change are sent. You can also switch to YAML, or leave everything as the package defaults.
- **The install** is set up the way the VCF CLI does it: a service account with the rights kapp-controller needs, the values in a Secret, and a PackageInstall pinned to the version. Everything is labelled `app.kubernetes.io/managed-by: vks-fleet`, with your reason recorded.
- **Checks:** already installed (update it instead), a version the cluster doesn't offer, a package that usually needs others first (for example Contour needs cert-manager), a namespace other than the repository's.
- **Every cluster is dry-run first,** then installed one after another, stopping at the first failure.

**Remove…** on an install you own deletes its PackageInstall; kapp-controller then removes what the package created, so you type the install's name to confirm. VKS-managed packages (CNI, CSI, sign-in and so on) can't be removed here. The service account, role and values Secret stay behind, because kapp-controller needs the account to finish; they can be deleted afterwards.

For applications generally, GitOps (Argo CD or Flux, which the plugin already reads) or Headlamp's App Catalog plugin are a better fit than one-off installs from a browser. VM and cluster requests with approvals and leases belong in VCF Automation's catalog.

**Packages** (sidebar: Packages), per signed-in cluster:

- **Installed packages,** marked **managed by VKS** (installed and upgraded with the cluster, so not changed here) or managed by you.
- **Actions** for yours, each with a dry run: **update** to any version the repositories offer, **pause or resume** reconciliation, and **reconcile now** (the same as `kctrl package installed kick`).
- **Across the fleet:** the drift matrix has **Update all**, which updates a package to one version in every cluster, one at a time, after a dry run of each.
- **Package repositories** with their source and sync state, and a **catalog** of what the repositories offer and where it's installed.

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

## Investigate

**Investigate** (sidebar, **Investigate** on any cluster issue, or from a cluster's charts) is one page for one cluster and one window (6 hours, 24 hours or 3 days), with two halves:

**What happened**, on the left: the fleet's own changes and conditions, Alertmanager alerts with their start times, warning events, unusual metrics, forecasts and the open issues, as one story. A short summary names the first symptom and, **if a change came within two hours before it, suggests it as a possible trigger**, stated as a suggestion; when nothing preceded it, it says so. **Copy as post-mortem draft** (or Download .md) gives a Markdown draft with summary, impact, a timeline table, the likely trigger, actions and follow-ups; the parts only people can fill in are marked, and a notice asks for review before sharing.

**The layers under a node**, on the right: the node as the cluster sees it, its Machine, its VM (power, class, zone), the ESXi host it runs on (from VM Operator's `status.host`), the namespace's memory overcommit and the Supervisor's health, each marked healthy, warning or unhealthy. **The deepest unhealthy layer is named as the likely one**: a problem low in the stack usually explains everything above it. Nodes with problems are marked in the picker and preselected; node names in the timeline can be walked down from; and when **most problem nodes are VMs on the same host**, that's called out first.

## Read by default, elevate to change

Everyday viewing needs no write rights, so it shouldn't have them. With **Settings → Read by default, elevate to change**:

- **Everything is read with a read-only sign-in:** the contexts as configured, for example `10.150.4.2` and `kubernetes-cluster-mnet`.
- **Changes need Elevate** (top bar), with **a reason** and **a time limit** (5 to 60 minutes). While elevated, the bar shows the countdown and **Drop**. Elevation ends when the time is up, when dropped, or when the page reloads, and it's never saved.
- **While elevated, only change requests** switch to the admin sign-in: `10.150.4.2-admin` (or the context set per Supervisor) and `<cluster>-admin`. Reads stay read-only.
- **Every change made while elevated records when and why** (`vks-fleet/elevated`, `vks-fleet/elevation-reason`) on the objects it creates or merge-patches, so the change audit shows it.
- **Actions stay visible in read-only mode.** Their dialogs start with an inline **Elevate** step; dry runs need write rights too, so they run after it.

**Setting it up on a jump server:**

1. In vCenter, create a read-only SSO user (for example `fleet-viewer@wld.sso`) and give it **Can view** on the vSphere namespaces. VKS maps that to read-only access inside the clusters too, while *Can edit* maps to cluster-admin.
2. Store both passwords in root-only files, `/root/.vsphere-pass-read` and `/root/.vsphere-pass-admin` (`chmod 600`).
3. Use [`deploy/jump-server/vks-refresh.sh`](deploy/jump-server/vks-refresh.sh) instead of the single-account script. It signs in the admin first and renames its contexts with `-admin` (a second `kubectl vsphere login` would otherwise overwrite them), then signs in the read-only account under the plain names, and restarts Headlamp. Run it from the same systemd timer.
4. Turn the setting on. Each Supervisor's change context defaults to `<context>-admin` and can be set explicitly.

On a shared, in-cluster deployment, per-user sign-in (OIDC) is the stronger end state: everyone signs in as themselves, and elevation becomes signing in with an admin role.

## Supervisor health

**Supervisor health** (sidebar, near the top) watches the platform itself, from what its API lets an administrator read. The Supervisor's `/readyz` and `/metrics` aren't exposed through its endpoint, and even an SSO administrator can't list leases or admission webhooks cluster-wide, so it works from the outside. Per Supervisor:

- **A health score** (0–100) and headline tiles: control-plane nodes, ESXi hosts, controllers, services, stuck objects, and the API response time the plugin measures itself.
- **Controllers alive:** the leader-election leases of Cluster API, the vSphere provider, kubeadm bootstrap and control plane, the runtime extension and the VKS controller (in the `svc-tkg-…` namespace), plus VM Operator, NSX and CSI where readable. A controller that **stops renewing its lease is stuck or gone even if its pod shows Running**: that's a critical issue, as is a lease with no leader.
- **Supervisor services** (vSphere Pods): running pods and their hosts, restarts, and pods failing with no replacement. **`ProviderFailed` pods** (the ESXi host couldn't run the vSphere Pod) left behind next to a running replacement are shown as leftovers, with **Clean up…** (dry run first; only the failed pods are deleted).
- **Placement:** service pods per ESXi host. When **every service pod runs on one host while others are Ready**, that's a resilience warning: pods rescheduled after a host problem stay where they landed.
- **The control plane** and hosts, the **reconcile backlog** by kind (clusters, machines, VMs, load balancers, NSX objects, subnets, volumes, with the one stuck longest), and **warning events by reason**.

**From vCenter** (with the vCenter collector): the Supervisor's own status lives in vCenter. The collector ([`deploy/collector`](deploy/collector)) signs in with a **read-only vCenter account** and writes it into a ConfigMap the plugin reads through the normal Kubernetes connection, so the browser never talks to vCenter or holds its credentials. It adds:

- the **configuration and Kubernetes status**, with vCenter's messages (the Workload Management view)
- the **control-plane VMs** (power state, size)
- **Supervisor Services** as vCenter sees them (version, state, messages)
- the **ESXi hosts** of the cluster (connection, power)
- **triggered alarms**, optionally: they need the `pyvmomi` library, since alarms aren't available over REST

These feed the health score and raise issues, including a notice if the collector stops writing.

**Utilisation** (with `pyvmomi`): the collector also samples vCenter's performance counters for the **control-plane VMs and ESXi hosts** every 5 minutes (CPU, memory, disk and network, averaged over the last 5 minutes), and the control-plane VM's **guest disks** through VMware Tools. It keeps **a rolling 24 hours** in the ConfigMap itself, so the Supervisor health page shows current values per VM and host and **charts for the last day**, with no database. The control-plane disk gets a **forecast** ("full in about 3 days"). A control-plane VM with a disk over 80% or memory over 90%, or a host over 90%, takes points off the health score and raises an issue: etcd and the API server live on that VM, and a full disk there stops the whole Supervisor. (The Supervisor's metrics API isn't exposed to administrators, so vCenter is the only source for this.)

**The account:** a vCenter SSO user with the built-in **Read-only** role at the vCenter root (propagated). If the Workload Management calls answer 403, the role also needs the Namespaces *view* privilege.

**Running it in a cluster** (every 5 minutes, next to Headlamp's in-cluster deployment):

```bash
kubectl -n vks-fleet create secret generic vks-fleet-vcenter \
  --from-literal=username=vks-fleet-ro@vsphere.local --from-literal=password='…'
# set VCENTER in deploy/collector/collector.env, then:
kubectl apply -k deploy/overlays/vcenter
```

**Or from a jump server** (writing into any cluster the plugin can read, for example `kubernetes-cluster-9yfw`):

```bash
kubectl --context kubernetes-cluster-9yfw create namespace vks-fleet
printf '%s' 'the-password' > /root/.vcenter-pass-ro && chmod 600 /root/.vcenter-pass-ro
pip install pyvmomi   # optional, for alarms

cat > /etc/systemd/system/vks-vcenter.service <<'UNIT'
[Unit]
Description=vks-fleet vCenter collector
[Service]
Type=oneshot
Environment=HOME=/root
Environment=VCENTER=vc-wld01-a.site-a.vcf.lab VCENTER_USERNAME=vks-fleet-ro@vsphere.local VCENTER_PASSWORD_FILE=/root/.vcenter-pass-ro
Environment=VCENTER_INSECURE=true KUBE_CONTEXT=kubernetes-cluster-9yfw OUTPUT_NAMESPACE=vks-fleet
ExecStart=/usr/bin/python3 /root/collect.py
UNIT
cat > /etc/systemd/system/vks-vcenter.timer <<'UNIT'
[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
cp deploy/collector/collect.py /root/collect.py
systemctl daemon-reload && systemctl enable --now vks-vcenter.timer
```

Then, in **Settings → vCenter collector**, set the context (`kubernetes-cluster-9yfw`); the namespace and ConfigMap default to `vks-fleet` and `vks-fleet-vcenter`. Each vCenter record is matched to its Supervisor by API address, then by its ESXi hosts (which are also the Supervisor's nodes, with the same names; the reliable match, since vCenter lists management addresses rather than the load-balanced one), or directly when there's one of each.

## Observability

**Observability** (sidebar) reads each cluster's own **Prometheus** and **Alertmanager** through the Kubernetes API's service proxy: the same connection and permissions as the rest of the plugin, with no extra endpoints, credentials or Grafana needed. VCF Operations isn't required.

- **Finding the stack:** the VKS Prometheus package (`prometheus-server`, `alertmanager` in `tanzu-system-monitoring`), kube-prometheus-stack, or a plain `prometheus` service. node-exporter and kube-state-metrics are detected too.
- **Enable monitoring…** on clusters without Prometheus installs the VKS Prometheus package from the cluster's own repository, through the package install flow: values form, dry run. It needs a default StorageClass (or `prometheus.pvc.storageClassName` in its values).
- **Fleet overview:**
  - clusters monitored, alerts firing, things running out within 7 days, the slowest API server
  - per cluster: node CPU and memory peaks, API p99 latency and 5xx rate, container restarts in the last hour, alert count
- **The page is ordered for operators:** the clusters first, the selected cluster's charts and right-sizing right below, then the app comparison and upgrade safety, alerts, and **Running out** last as a collapsible section.
- **Charts** use smooth curves with soft fills. Hovering shows a crosshair and every series' value at that moment; thresholds are labelled; the fleet's changes appear as markers that explain themselves on hover. **Expand** (or clicking a chart) opens a larger view: ranges from 1 hour to 30 days, per-series statistics (min, average, p95, max, latest, with those over the warning level marked), the changes in that window, **what the panel means** for an operator, and the PromQL behind it.
- **Per-cluster panels** (1 h to 30 d): node CPU, memory and disk; API server latency and errors; etcd database size; container restarts; busiest pods; volume fill; network errors. A panel without data says what would collect it ("needs kube-state-metrics"), and alternative metric names are tried where exporters differ.
- **Changes drawn on every chart:** the fleet's own changes in that cluster (node replacements, upgrades, conditions, the plugin's actions) appear as dashed markers, labelled on hover. A spike and its likely cause show up side by side.
- **Forecasts instead of thresholds:** from the last six hours' trend, *when* a volume, a node's disk, etcd or a node's memory runs out, for example "streaming/data-kafka-1 runs out in about 3 days". Under 7 days is a warning issue; under 2 days is critical.
- **Alerts:** Alertmanager's active alerts (not silenced or inhibited; Watchdog left out) become issues on the fleet page, grouped by alert name, with severity from their labels.

**Compare** (on the same page):

- **Unusual for this time:** each cluster's headline numbers (node CPU and memory, API latency and errors) are compared with the same time a week earlier. A real jump (1.5× and a minimum difference) gets an "unusual for this time" badge, so normal daily peaks don't.
- **Upgrade safety: deprecated APIs in use.** The API server counts requests to deprecated APIs, with the release that removes each one. The page lists them per cluster against the newest release on the Supervisor, and the **Upgrade Planner** warns when a cluster's target would remove an API still in use. It's real traffic, not a manifest scan; the count covers calls since the API server last started.
- **Right-sizing** (in each cluster's detail): what workloads ask for against what they use (95th percentile over the last week), with requests suggested at p95 plus 30%. Workloads asking for far more than they use, and those using more than they ask, are flagged. With a single worker pool, it also works out how many nodes the right-sized requests need, and **what that frees in the namespace, including memory overcommit before and after**. Short history is flagged ("only 20 hours so far").
- **The same app across clusters:** workloads with the same name and image in several clusters, compared on CPU and memory per replica and restarts, with differences called out ("checkout uses 2.7× the CPU per replica", "Restarts only in checkout", "Different versions"). It queries every cluster, so it runs when you ask.

**Exporters without a server.** On VKS the managed Prometheus add-on may run only node-exporter and kube-state-metrics, with no server to store or query them. The page says so, and **Add a Prometheus server…** gives the commands that add one (with Alertmanager) in its own namespace, scraping the existing exporters without touching the managed add-on.

Queries are cached for a minute per cluster, the panels only load for the cluster you open, and the summary refreshes every 5 minutes. They also go through the request limiter, like everything else. Querying through the proxy needs the `services/proxy` permission in the monitoring namespace: operators normally have it; tenants may not.

## Creating VMs and clusters

A namespace's page has **New VM…** and **New cluster…**.

**A VM:**
- **VM class:** those assigned to the namespace, with their sizes.
- **Image:** namespaced or Supervisor-wide, ready ones only.
- **Storage class** and **network:** the namespace default, or one of its subnets or subnet sets.
- **Power state**, and optionally **an SSH public key** for a default user (set up with cloud-init; no password login).

**A cluster:**
- **Start from a copy of a working cluster** (recommended): its cluster class, variables and networking are known to be right. Or start from scratch.
- **Then choose** the Kubernetes release, one or three control-plane nodes and their VM class, and **node pools** (name, size, VM class).

**The preview updates as you type.** It shows the effect on the namespace:
- configured vCPU and memory, now and after, against the namespace's limits
- **memory overcommit before and after** (for example 2.0× → 2.6×)
- whether it fits the Supervisor's ResourceQuota
- guaranteed classes whose reservation would exceed the limit

The checks catch taken or invalid names, VM classes not assigned to the namespace, and a template from another namespace.

**Three ways out:**
- **Create…**, with a server-side dry run first, through the Supervisor (or VCF Automation's namespace proxy for tenants), so the platform's own quotas, class assignments and policies still decide.
- **Copy YAML** and **Download YAML**, for GitOps: commit it, and Argo CD or Flux applies it. These work for read-only users too.

VM and cluster requests that need approvals, leases or cost controls belong in VCF Automation's catalog; this is for the quick, well-understood cases, and for producing clean manifests.

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

## Demo mode

**Settings → Demo mode** replaces your Supervisors with a fictional fleet: one Supervisor, two orgs (acme and globex) and four clusters. It's for screenshots, talks, and trying the plugin without a lab. A **DEMO** marker shows in the top bar while it's on, and your Supervisor settings come back when it's switched off.

Each cluster has deliberate problems, so every page has something to show:

| Cluster | What it demonstrates |
|---|---|
| payments | The healthy one: hardened workloads, network policies, daily backups, Trivy reports, a saved kube-bench run |
| Supervisor | Every service pod on one ESXi host while four are Ready, a ProviderFailed leftover to clean up, six controller leases renewing |
| checkout | A node disk filling in about 38 hours, crash-loop and disk alerts from Alertmanager, a node stuck draining behind a PodDisruptionBudget, a crash-looping pod, a privileged pod, a cluster-admin grant, a partly failed backup, a failing package, images with critical CVEs |
| sandbox | A Kubernetes version behind (upgrade available), no default StorageClass, no monitoring (to try Enable monitoring) |
| analytics | Control-plane certificates expiring in 18 days, two node pools, Kyverno policy failures, a Kafka volume filling in about 3 days (Prometheus forecast) |

Every request goes to in-memory data through the same code paths as real clusters, including the Pod Security probe (VKS's restricted default). **Dry runs work**, so action dialogs can be tried end to end. **Real changes are always refused.**

## At scale

What one open browser tab costs:

- **Requests per refresh.** Steady state, with the default intervals:

  | | Requests | Every |
  |---|---|---|
  | Supervisor: fleet | about 13 | 30 s |
  | Supervisor: inventory | about 8 | each refresh |
  | Per cluster: workload health | about 10 | 30 s |
  | Per cluster: security and compliance scan | about 18 | 5 min |
  | Per cluster: packages | 4 | 3 min |
  | Per cluster: scanner reports | about 4 | 10 min |
  | Per cluster: backups | 2 | 5 min |

  That's about 25 requests per minute per cluster, roughly 0.4 per second on each cluster's API server. For 50 clusters, about 20 per second from one tab.
- **Capped concurrency:** at most 6 requests at once per cluster and 24 overall; the rest queue.
- **Remembered lookups:** a resource type that isn't installed (answering "not found") isn't asked for again for 10 minutes, and the API version that answered is tried first. Named objects are always fetched, and newly installed tools show up within 10 minutes. On repeat refreshes this cut the Supervisor inventory from about 61 requests to 8.
- **Hidden tabs don't poll.** Refreshes pause and catch up when the tab is shown again. A failed refresh keeps the last good data.
- **Diagnostics** (bottom of Settings) shows requests, errors, average and slowest times and the last error, per cluster, since the tab was opened. Use it to judge load, or to spot a slow or failing cluster.
- **A failing section doesn't blank the page.** Each page, and the fleet page's org cards, overview and issues, show what failed with **Try again** and **Copy details** (for a bug report); the rest keeps working.

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
