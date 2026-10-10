# Changelog

Newest first. Versions are git tags; each release carries `vks-fleet.tar.gz` (the plugin) and `vks-fleet-plugin-configmap.yaml` (the same plugin for in-cluster deployments).

## 1.38.0 (release candidate)

Recommendations: the step the plugin suggests where it has no guaranteed fix.

- **Three states for an issue:** *Fix ready* (a guarded action reliably clears it), *Recommended* (a specific next step that is a planned change, or whose outcome isn't certain), and *Needs a decision* (only you can judge it). The recommended step is the issue's button, with why on hover.
- **Do these first**, on the Issues tab: the fleet's recommended steps, one line for the same step across clusters, with what it clears, the score points it brings back (only where a best-practice check measures it) and what it takes: one click, guided, or a change window. Urgent steps come first, then by effect. *Why* shows the reasoning and the clusters.
- **Fourteen steps**, each leading to an action, page or runbook that already exists: upgrade Kubernetes, move to the current cluster class, re-reconcile or update packages, get backups running or install Velero, set a default StorageClass, add a default-deny network policy, replace a node whose disk is filling up, expand a volume, add node capacity, clean up leftovers, spread pools across zones, turn on automatic node repair. Nothing is ever applied from the list.
- **Gaps without an issue are included:** a cluster with no backup tool, or a best-practice check that costs score points but raises no warning.
- **Simulate has three views:** *As it is*, *With fixes*, and *With fixes and recommendations*. The score, the wall and the issues follow. Upgrades and class changes are recommended but never counted: each is a project of its own.
- **The dashboard:** an item in *Needs you now* with a recommended step shows it, and a wall tile names it.
- **Fixed:** the *Trend starts today* note no longer wraps onto three lines.
- **Docs:** the install commands use this version.

## 1.37.0 (release candidate)

- **Every dashboard block has its own trend:** a small line of its figure over the last 30 days, and how it moved since your last visit: ▲ or ▼ with the amount, green when that is the good direction (fewer clusters needing attention, a higher Supervisor score) and red when it isn't, with the change in words on hover. Figures with no good direction (vCPU in the fleet) show the move without a colour.
- **From the history 1.36 started:** nothing new is stored. A block shows its trend from its second day in this browser; demo mode has a made-up month for every block.
- **One trend per measure:** a block whose figure can change meaning (Capacity: time left, or the busiest node; Lifecycle: failing packages, or upgrades; Governance: baseline, or backups) keeps a separate history for each, so a line never mixes two. Those three start their trends with this version.
- **Docs:** the install commands use this version.

## 1.36.0 (release candidate)

The fleet page is now a health dashboard: one screen, where every part opens the page that owns the detail.

- **Three tabs:** *Dashboard*, *Clusters* and *Issues*, each with its own address (`?tab=clusters`, `?tab=issues`). Older links to a section or a cluster filter open the tab that section moved to.
- **Dashboard:** the fleet score beside the fleet in one sentence (clusters needing attention, how the score moved since your last visit, the check that costs the most points); the three most urgent items of *Needs you now*, one line each; eight blocks; and a compact cluster wall.
- **Eight blocks**, each one number, a status dot and one line of reason, opening its page: Clusters, Supervisor, Capacity (how long until something fills up, otherwise the busiest node), Next 30 days, Lifecycle, Security, Governance (baseline and backups) and Network (the fullest subnet). A block shows `—` when the account can't read what it needs.
- **Score trend:** the fleet score over the last 30 days, kept in the browser only: one point a day, for 90 days, per Supervisor filter and org. Nothing is stored on a server; another browser starts its own history, and a new install shows *Trend starts today* until its second day. Demo mode comes with a made-up month.
- **What holds the score down** opens from the score instead of taking the top of the page.
- **Clusters tab:** the filter, *only clusters with problems*, **Export report**, *Clusters at a glance*, the activity heatmap and the org cards.
- **Issues tab:** what changed since you last looked, **Simulate fixes** (with the score before and after, and a wall of the fleet as it would be), the next 30 days as a timeline and a list with links, and the issues, open by default.
- **Gone from the fleet page**, because their own pages already show them: busiest nodes (Capacity & cost), subnet usage (Network), packages at different versions (Lifecycle), and the summary sentence that repeated the counts.
- **Plugin description:** Headlamp's plugin list says what the plugin is instead of *Your Headlamp plugin*.
- **Docs:** the install commands use this version.

## 1.35.2 (release candidate)

- **The score's reasons open:** click a line under *What holds the score down* for the clusters where that check isn't passing; each one links to that cluster's checks, with how to fix it, and the fix is named when the plugin has one. *Show all* lists the smaller reasons too.

## 1.35.1 (release candidate)

From the first run of the new fleet page on a live Supervisor and on the demo fleet:

- **One meaning of "needs attention":** a cluster needs attention when it has a critical issue, a warning about something failing or running out, or the Supervisor doesn't report it healthy. The score card, the sentence at the top, the org cards and the wall now all count it the same way. Before, a cluster with two critical issues could read *all healthy*, because only the Supervisor's view was counted.
- **Advisory-only tiles:** a cluster whose only open findings are posture and hygiene (a missing Pod Security level, an older version, a single control plane, scanner, policy and compliance findings) gets a dashed outline, not a filled tile, so the wall shows where something is wrong now.
- **The per-org cluster tables are gone:** the wall and *Clusters at a glance* already list every cluster. *Open in Headlamp* moved to *Clusters at a glance*, and the filter box and *Only clusters with problems* now filter the wall and that table.
- **Layout:** on a small fleet the 30-day timeline sits under the wall instead of leaving it empty; the score's reasons sit next to their bars; an org's name is no longer cut short by its status chip.
- **Docs:** the install commands use this version.

## 1.35.0 (release candidate)

The fleet page, rebuilt around the fleet itself:

- **Cluster wall:** every cluster is a tile, grouped by org and coloured by its worst open issue, naming that issue and whether a fix is ready. Tiles shrink for large fleets; a tile opens its cluster.
- **The score explains itself:** next to the fleet score, *What holds the score down* lists the best-practice checks that cost the most points across the fleet, and which of them the plugin can fix.
- **Simulate fixes:** a switch that shows the fleet as it would be after the fixes the plugin already has (unblocking or replacing a stuck or powered-off node, resuming a paused cluster, clearing leftover timeouts, turning on certificate rotation, a control plane of 3, a Pod Security level). The wall, the score and the issues update together. It only redraws the page: nothing is sent anywhere. Upgrades and package re-reconciles aren't counted as fixes.
- **Fix ready / Needs a decision** on every issue, in *Needs you now* and in the issues list; where a fix exists, its button opens the existing action with its checks and dry run.
- **Issues are one line each** until opened (**Details**), so a long list fits a screen; the cause, evidence, runbook, Investigate, Silence and Copy diagnosis are inside. A list of one opens by default.
- ***Needs you now* and *Next 30 days* share one card:** up to six items with their timing, and the timeline below without the repeated list.
- **Marks:** a vks-fleet mark, an icon per kind of issue, and the Kubernetes icon on cluster tiles (unmodified, from the CNCF artwork repository; see NOTICE).
- **Fixed:** an issue's button could read *Go to Go to it*.

## 1.34.3 (release candidate)

From the final pre-publication review:

- **The README's install puts the secure path first:** a complete, copyable Helm install that trusts vCenter's CA, with skipping certificate checks as a clearly labelled lab-only alternative.
- **Release pages explain the project:** each release's description is generated from a template (what VKS fleet is, the observe–investigate–predict–pre-flight–act workflow, how to install, the validation scope) plus that version's section of this changelog. Versions marked *release candidate* here are published as pre-releases automatically.
- **Artifact Hub:** the package metadata includes Headlamp version compatibility (0.45 and later).


## 1.34.2 (release candidate)

From the clean-install retest on VCF 9.1 (which passed: restricted Pod Security, verified TLS, Headlamp trusting the CA, with no manual steps):

- **Troubleshooting setup:** a new section in *Getting started* for an interrupted Helm install, certificates, and elevation without an admin sign-in; the chart guide's troubleshooting table covers the same.
- **Retries:** the vCenter collector retries a write, and the sign-in refresher a sign-in, whose connection dropped (twice, after 3 and 10 seconds). Real refusals (a missing namespace, a wrong password) still fail at once with their message.

## 1.34.1 (release candidate)

From a clean install of v1.34.0 from the release, and live write tests, on a VCF 9.1 lab:

- **The chart and the manifests meet restricted Pod Security,** which VKS enforces by default: v1.34.0's Headlamp pod was rejected. CI now renders the chart (default, secure and insecure) and checks every pod against the restricted level, and the kustomize manifests too.
- **Headlamp trusts vCenter's CA:** the refresher verified the Supervisor but Headlamp, reading the kubeconfig, didn't. The refresher now writes the CA into the kubeconfig, and the chart also gives Headlamp the CA Secret.
- **Simpler installs:** one `tls` setting in the chart, `tls.caSecret` (secure) or `tls.insecure` (labs); a three-step install guide with both paths, how to open it, and a troubleshooting table.
- **Settings:** a certificate problem is named as such (*"its certificate isn't trusted"*), with the fix, instead of *"not reachable"*.
- **Elevation:** Elevate refuses, with the reason, when the admin sign-in doesn't exist; a change sent to a missing admin context says so instead of *"The Supervisor would reject this change"*.
- **Short node names** in the cluster page's machine, sandbox-failure and pod tables, and the Machines page.
- **Validation status:** scaling a pool, pausing and resuming a cluster, and the clean Helm install are confirmed on a live system.

## 1.34.0 (release candidate)

Hardening for publication, from an external review:

- **TLS verified by default:** the sign-in refresher no longer skips certificate checks for the Supervisor (when downloading its CLI tools and signing in), and neither does the jump-server script. `CA_FILE` (the chart's `caSecret`, or an optional `vks-fleet-ca` Secret with kustomize) trusts vCenter's CA; the collector accepts it too. Skipping verification takes an explicit lab-only switch.
- **Shared installations:** the README no longer implies per-person rights for a shared in-cluster Headlamp (everyone acts as its one account). SECURITY.md has a *Shared installations* section with an authenticating-proxy example and a read-only default, plus *TLS* and *Changes and their guarantees*.
- **Changes made of several writes** report a failure partway exactly: which steps took effect (and weren't undone), which failed, which weren't sent. The docs state what a dry run does and doesn't guarantee.
- **Builds:** type-checking against the real Headlamp types now blocks a release; the plugin tooling is pinned (`@kinvolk/headlamp-plugin` 0.14) and Headlamp to v0.45.0 in the chart and manifests.
- **README:** a new description, a release-candidate note with a validation status (what's confirmed on a live system, what isn't, and the scale tested), and a copy-pasteable Helm command.
- **Docs:** screenshots from demo mode in the README and guides; the fleet-page description matches the page since 1.29 (no tiles, overview charts, capacity or tenants tables); the early "verify first" checklist replaced by what's confirmed on VCF 9.1 and what's still open (in the development guide); the Helm chart's install commands take a version instead of a pinned one.
- **Code:** the unused Overview component and its helpers removed.

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
