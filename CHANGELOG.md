# Changelog

Newest first. Versions are git tags; each release carries `vks-fleet.tar.gz` (the plugin) and `vks-fleet-plugin-configmap.yaml` (the same plugin for in-cluster deployments).

## Unreleased

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
