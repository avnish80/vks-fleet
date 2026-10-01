# VKS fleet

**Operations and reliability for vSphere Kubernetes Service (VKS) fleets.** A [Headlamp](https://headlamp.dev) plugin that brings health, investigation, capacity forecasting and change planning together across your Supervisors and their VKS clusters: understand what needs attention, trace a problem from a workload down to the ESXi host, and see what a change will do before you start it. Built for VCF platform operators, with a demo that needs no VMware lab.

> **Release candidate.** Tested on a real VCF 9.1 lab and in demo mode; some write paths aren't yet confirmed on a live system (see [Validation status](#validation-status)).
>
> **A personal open-source project.** Not affiliated with, endorsed by, or supported by Broadcom or VMware. Product names are used only to describe what it works with (see [NOTICE](NOTICE)). [Apache 2.0](LICENSE).

![The fleet page: fleet score, what needs you now, the next 30 days, and the orgs](docs/images/fleet.png)

**Try it in two minutes without a lab:** install the plugin, open *VKS fleet*, and choose **Try the demo**: a fictional fleet with realistic problems, where nothing is ever changed.

## What it does

Operating a fleet of VKS clusters means moving between the Supervisor, vCenter, each cluster's API and its Prometheus. vks-fleet reads all of them through their public APIs (Cluster API, VM Operator, NSX VPC, Carvel, Prometheus, and vCenter through a small collector) and follows the way an operator works:

**Observe.** The fleet page opens with a fleet score, **Needs you now** and **the next 30 days**, then one row per cluster with health, issues, best-practice score, baseline, backup, certificates, version and nodes. **Supervisor health** shows the platform itself: its controllers, services, control-plane VM and hosts, with vCenter's own view and 24 hours of utilisation. [Features](docs/features.md) · [The Supervisor](docs/supervisor.md)

![Supervisor health: hosts, what runs where, and what esx-01 failing would take down](docs/images/supervisor.png)

**Detect.** Issues are ranked, time-bound problems first, each with its cause and what to do: stuck nodes, drains blocked by PodDisruptionBudgets, crash loops, certificates, quota and overcommit, controllers that stopped reconciling, services running on a single host, CIS-aligned compliance, vulnerabilities from Trivy, and drift from your own baseline profiles.

**Explain.** **Investigate** puts one cluster's timeline (changes, alerts, events, anomalies) beside a **walk down the layers** under a node: pod, node, Machine, VM, ESXi host, namespace, Supervisor, with the deepest unhealthy layer named. It drafts the post-mortem too. [Observability and investigation](docs/observability.md)

![Investigate: what happened in checkout beside the layers under its troubled node](docs/images/investigate.png)

**Predict.** Prometheus forecasts (disks, memory, volumes), the Supervisor's control-plane disk, and certificate expiries land on a 30-day timeline. **Pre-flight** answers *what will this change do?* before an upgrade, a scale or a VM class change: capacity while it runs, the pods and workloads that move, what would block, and a verdict. [Making changes safely](docs/making-changes.md)

![Pre-flight for upgrading checkout: a blocker, the nodes and pods affected, and the namespace's capacity](docs/images/preflight.png)

**Remediate.** Upgrades, scaling, node replacement, timeouts, packages, VMs and clusters, each from a dialog with its checks, a server-side dry run and a confirmation. With **read by default, elevate to change**, changes need a time-limited elevation with a reason.

**Audit.** Every change is stamped on what it changed and shows in the change audit and the activity heatmap. Compliance exports evidence (Markdown, CSV, OSCAL).

## Who it's for

The same plugin serves everyone; what it shows and allows follows the RBAC of the account Headlamp signs in with, not a mode in the UI. **Operators** see every org, with fleet-wide actions. **Read-only admins** see everything and change nothing. **Tenants** (directly or through VCF Automation) see only their own org's namespaces and clusters.

**Personal or shared?** With Headlamp desktop, or a Headlamp each person runs with their own sign-in, every user acts with their own rights. A **shared in-cluster Headlamp** signs in with one dedicated account, so **everyone who can open it acts as that account**: put it behind authentication (see [SECURITY.md](SECURITY.md#shared-installations)), and give that account read-only rights, with changes going through elevation.

## Quick start

- **Headlamp desktop app or Docker:** extract the release's `vks-fleet.tar.gz` into Headlamp's plugins folder, restart Headlamp, and open *VKS fleet*.
- **In a cluster, with Helm:** the chart attached to each release, with a job that keeps sign-ins fresh and the optional vCenter collector:

  ```bash
  VERSION=1.34.0                 # the release to install
  SUPERVISOR=10.0.0.2            # your Supervisor's address
  helm install vks-fleet "https://github.com/avnish80/vks-fleet/releases/download/v$VERSION/vks-fleet-$VERSION.tgz" \
    -n vks-fleet --create-namespace --set plugin.source=download --set refresher.supervisors="$SUPERVISOR"
  ```

  It needs a Secret with the sign-in account first, and usually vCenter's CA (TLS is verified): see [the chart](deploy/helm/vks-fleet/README.md), or [deploy/](deploy/README.md) for kustomize.

Then connect a Supervisor (Settings → Plugins → vks-fleet). [Getting started](docs/getting-started.md) covers sign-ins, multiple Supervisors, orgs and demo mode.

## Security in brief

The plugin runs in your browser with Headlamp's sign-ins: no server, no credentials and no telemetry of its own. It changes nothing unless you run an action, and every action shows its checks and runs a dry run first (a dry run catches what the API would refuse; it isn't a guarantee that a multi-step change completes, and if one fails partway the plugin says which steps took effect). The sign-in refresher and the vCenter collector verify TLS certificates by default, and the collector uses a read-only account. Details, and how to report a problem privately: [SECURITY.md](SECURITY.md).

## Compatibility

Developed and tested against VMware Cloud Foundation 9.1 with vSphere Kubernetes Service 3.7 (Cluster API v1beta1), on Headlamp 0.45. Other versions may work; issues with version details are welcome.

### Validation status

- **On a real VCF 9.1 lab** (one Supervisor, two VKS clusters, VCF Automation tenants): every read and view, the vCenter collector, and patch-type changes with their dry runs.
- **Not yet confirmed on a live system:** pausing and scaling through the VKS admission webhooks, deletes, drain timeouts reaching machines already deleting, and some links into Headlamp's own pages. The [development guide](docs/development.md#confirmed-on-a-live-system-and-still-open) keeps the full list.
- **Scale:** demo mode exercises the pages at up to 50 clusters; a real fleet has been tested at 2. Checks run from the browser, which suits tens of clusters (see [known limits](docs/development.md#known-limits)).

## Documentation

- [Getting started](docs/getting-started.md): running it, sign-ins, multiple Supervisors, demo mode
- [Features](docs/features.md): every page and what it shows
- [The Supervisor](docs/supervisor.md): Supervisor health, hosts, the vCenter collector
- [Observability and investigation](docs/observability.md)
- [Making changes safely](docs/making-changes.md): pre-flight, elevation, actions, provisioning
- [Deployment](deploy/README.md) and the [Helm chart](deploy/helm/vks-fleet/README.md)
- [Development and reference](docs/development.md): building, tests, code layout, what it reads, what's confirmed on a live system, known limits
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
