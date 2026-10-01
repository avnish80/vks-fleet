# Changelog

Newest first. Versions are git tags; each release carries `vks-fleet.tar.gz` (the plugin) and `vks-fleet-plugin-configmap.yaml` (the same plugin for in-cluster deployments).

## 1.33.4

- **One Supervisor score everywhere:** the fleet page, Supervisor health and Investigate all show the score with vCenter's findings when the collector has data (the fleet page showed the API-only score: 84 where Supervisor health said 64).
- **The walk-down blames the Supervisor only when it's the cause:** it's judged by its controllers (not renewing means clusters aren't reconciled). A lower score from unrelated causes, such as a failed Supervisor service, is shown but no longer marked as the likely cause of a cluster's problem.
- **Demo:** each cluster's API answers `/version`, so no cluster shows *"Some details not readable"*.

## 1.33.3

From a review of every page in demo mode at 20 clusters:

- **Demo:** leases no longer go stale (the demo Supervisor dropped to 0/100 after a few minutes, which Investigate and Pre-flight then blamed); cloned clusters get valid, distinct addresses, their own networks, and Prometheus like the cluster they copy; control-plane nodes spread across hosts; certificate rotation is set (off in the sandbox, as a drift to find); volume metrics for every monitored cluster; checkout's workers have a second network, so the map shows a secondary network.
- **Since you last looked** keeps a separate memory in demo mode, so the demo never lists a real fleet's issues (or the other way round).
- **Settings** pauses the real-setup checks in demo mode, and says so.
- **At scale:** host cards show the six largest clusters and *+N more*; the activity heatmap lists only clusters that changed; Observability lists clusters with metrics first and folds the rest into one line; the Tenants table (a duplicate of the org cards) is gone from the fleet page.
- **Fixes:** a cluster's own subnet is matched exactly (`payments-2-…` was also counted as `payments`'s); Pre-flight no longer says vCPUs *fit* a GHz limit (different units: *not comparable*, with the reason); the Baseline Pod Security field's label no longer overlaps its value; *Alert* isn't repeated in Investigate's timeline; *1 update*; short host names in Investigate.

## 1.33.2

Fixes from a review on a real VCF 9.1 lab:

- **Access check under elevation:** with *read by default, elevate to change* on, the top bar said *Access not checked*: the access review went through the change path, which refuses everything until you elevate. Access reviews change nothing and now always use the read sign-in.
- **Network map:** grouping per cluster didn't happen on real data (the page passed only VM Service VMs, not cluster node VMs). Node VMs are now recognised by name too, against every cluster on the page; public addresses use short names.
- **Observability:** a slow panel (API server latency over 24 hours) gives up after 25 seconds with a message instead of loading forever; the coverage line appears as soon as the other panels are in.
- **Forecasts:** a node scraped twice no longer gives two forecasts anywhere (merged where they're computed); Investigate, the walk-down and pre-flight use short node and pool names.
- **Settings:** the elevation check counts only VKS clusters, not namespace contexts; context fields use the full width.
- **Fleet page:** the 30-day timeline keeps its size on a wide card; the Supervisor services table shows short host names.

## 1.33.1

- Fix: *Go to …* buttons on a cluster's page did nothing when clicked a second time (or when the address already pointed at that section); every click now scrolls to the section and highlights it.
- Issue cards no longer show links to the page they're on (such as *Open kubernetes-cluster-c3d4* on that cluster's own page).
- *Go to workloads* instead of *Go to inside the cluster*; the section is titled *Workloads inside the cluster*.

## 1.33.0

- **Observability:** etcd database size read through the API server when etcd's own metrics aren't reachable (they rarely are on VKS); a panel that isn't collected explains why and how to fix it; a coverage line above the charts ("9 of 10 panels collected", linking to the rest); node charts merge a node scraped twice into one series, and all node charts show the same short node names (IP addresses mapped to nodes).
- **Networks:** attachments grouped per cluster (*mnet · cluster + 4 nodes*), a cluster's nodes on another network marked as *secondary* (multi-NIC, as with Multus), subnets ordered (cluster networks, in use, public), unused subnets on one line, and short names throughout.

## 1.32.0

- The vCenter collector can save into a platform-owned Supervisor namespace, so no extra cluster is needed; the docs set out the options (Supervisor namespace, an existing cluster, in-cluster), and the settings say so.
- The collector reports a failed write in one plain line (a missing namespace, missing rights, an expired sign-in) instead of a traceback.

## 1.31.0

- Settings rebuilt for first-time setup: a **setup status** at the top (each Supervisor's clusters and namespaces or why not, VCF Automation sign-ins, the vCenter collector, elevation's admin contexts); context pickers instead of free text; org names found automatically, each with a name field; rarely needed fields under Advanced; changes as one choice (allow, elevate to change, read-only); display settings together; diagnostics collapsed.

## 1.30.0

- Launch readiness: Apache 2.0 licence, NOTICE, security note, contributing guide, issue templates, Helm chart, Artifact Hub metadata, neutral example configuration, and a first-run offer of demo mode.
- A short README telling the story (observe, detect, explain, predict, remediate, audit); the reference material moved into guides under `docs/`.

## 1.29.0

- Fleet page rebuilt so every number appears once: **Clusters at a glance** (one row per cluster, worst first: health, issues, score, baseline, backup, certificates, version, nodes) replaces six chart cards and the KPI tiles; cards appear only when they have something to show; Capacity and Supervisor services live on their own pages.
- Readable names: a shared cluster prefix is dropped (`kubernetes-cluster-a1b2` shows as `a1b2`), and nodes lose their cluster's prefix.
- *Needs you now* puts time-bound problems first (running out within a week, certificates within two), grouped per cluster.
- The 30-day timeline merges duplicates and includes certificates inside clusters.
- Fix: a certificate finding keeps one identity as its days count down (silences and "since you last looked" no longer break daily).

## 1.28.0

- **Baseline profiles** (prod, dev…) matched by label, cluster name, namespace or org; new rules for a target Kubernetes minor, required packages with minimum versions, and the Pod Security default; a desired-vs-actual view per cluster.
- Clusters carry their labels.

## 1.27.0

- Fleet page hero band: fleet score, **Needs you now**, and **the next 30 days** (certificate expiries, forecasts, the Supervisor's control-plane disk, silences ending).

## 1.26.0

- **Supervisor by host**: what runs on each ESXi host, its load and alarms, and what a host failure would take down.
- VM placement from vCenter (VM Operator doesn't always report a VM's host), feeding the walk-down and host patterns.

## 1.25.0

- **Pre-flight** for upgrades, pool scaling and VM class changes: health gates, capacity while it runs and after, blast radius (pods and workloads that move, single-replica workloads, blocking PDBs), deprecated APIs and packages, with a verdict.

## 1.24.0

- Pages at fleet scale: fleet roll-ups first, one compact row per cluster, full tables in dialogs, filters and paging.
- Demo fleet size (4 to 50 clusters).

## 1.23.x

- Supervisor utilisation from vCenter's performance counters: control-plane VM and hosts, with a rolling 24-hour history and a control-plane disk forecast.
- Expandable utilisation charts; readable "Running on"; charts fit the available history.

## 1.22.0

- Design pass: vCenter data as tables, dark mode throughout, bolder labels, consistent tables.

## 1.21.0

- Eleven sidebar entries: Compute, Security, Lifecycle, Capacity & cost and Governance hubs with tabs.

## 1.20.0

- Observability reordered for operators, with a chart detail view (ranges to 30 days, statistics, meaning, PromQL).
- **Investigate**: the incident timeline beside the walk-down.

## 1.19.0

- Modern charts with hover crosshairs; walk-down across layers (pod, node, Machine, VM, host, namespace, Supervisor); incident timeline with a post-mortem draft; host-based vCenter matching.

## 1.18.0

- **vCenter collector**: the Supervisor's own status, control-plane VMs, services, hosts and alarms, through a read-only account.

## 1.17.0

- **Read by default, elevate to change**: time-boxed elevation with a reason recorded on every change.

## 1.16.0

- **Supervisor health**: controller leases, service pods and ProviderFailed leftovers, placement, reconcile backlog, events, responsiveness, score.

## 1.15.0

- Compare: unusual-for-this-time badges, deprecated APIs in live traffic, right-sizing, the same app across clusters.

## 1.14.0

- Observability through each cluster's Prometheus: stack discovery, curated panels with change markers, forecasts, Alertmanager alerts as issues.

## 1.13.0

- Provisioning: New VM and New cluster with a capacity preview, YAML for GitOps, dry runs.

## 1.12.x

- Install and remove VKS packages with a values form from the package's schema, across clusters.

## 1.11.0

- Stabilisation: tests in CI, demo mode, error boundaries, request limiter, diagnostics.

## 1.10.x

- Trivy Operator and policy-engine results, NSA/CISA view, OSCAL export, vulnerabilities by owner (yours or VKS).

## 1.9.x

- kube-bench node scans, tenant isolation report, Pod Security cluster-default probe.

## 1.8.0

- CIS-aligned compliance with owner tagging, waivers, drift and evidence exports.

## 1.7.x

- Org cards; personas (operator, read-only, tenant); namespaces, VM Service VMs, VPC networking, storage quotas, applications, GitOps, security posture, showback, silences, Ctrl+K.

## 0.1 to 1.6

- The fleet view across Supervisors: health, machines, node pools, upgrades, scorecard, issues and actions, timeline, anatomy, packages, in-cluster deployment, heatmap, runbooks, change audit, upgrade planner, capacity, baseline, cleanup, access and backups.
