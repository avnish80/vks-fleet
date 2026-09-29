# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue. You'll get an acknowledgement within a few days; this is a personal project, so there's no formal response time.

## What the plugin can do

vks-fleet runs in your browser inside Headlamp and talks to Kubernetes APIs (Supervisors and VKS clusters) **as whoever Headlamp is signed in as**. It has no server of its own and no credentials of its own. It sends nothing anywhere else: no telemetry, no external calls.

**Reading** covers what the signed-in accounts can list: Cluster API objects, VM Operator objects, namespaces and their limits, NSX/VPC objects, and inside each VKS cluster nodes, pods, events, packages, policies, certificates and Prometheus (through the API server proxy).

**Changing** happens only through explicit actions, each opened from a dialog that lists its checks, runs a **server-side dry run** first where the API supports it, and needs a confirmation. The actions are: scale a node pool, upgrade a cluster, pause or resume, replace a node, set drain or delete timeouts, control-plane size, certificate rotation, VM power and snapshots, create a VM or cluster, install or remove packages, Pod Security labels and default-deny network policies, cleaning up failed Supervisor service pods, and running a kube-bench node scan (a short-lived Job). Nothing changes on its own.

**Every change is stamped** on the object it changes (a `vks-fleet/last-action` annotation) and appears in the change audit.

## Least privilege

- **Read by default, elevate to change** (Settings): everyday viewing uses a read-only sign-in; changes go through an admin sign-in only after you elevate, for a limited time, with a reason recorded on each change. See [Making changes safely](docs/making-changes.md#read-by-default-elevate-to-change).
- **Read-only mode** (Settings, or preset by an administrator) hides every action.
- **Tenant deployments** (`deploy/overlays/tenant`) see only their own namespaces.

## Credentials

- **Kubeconfig:** Headlamp's, as usual. The plugin never reads or stores tokens.
- **In-cluster deployment:** the refresher signs in with a dedicated vSphere account stored in a Kubernetes Secret, and writes the kubeconfig to another Secret that only the Headlamp pod mounts. **Everyone who can open that Headlamp acts as that account**, so expose it only to operators (for example with `loadBalancerSourceRanges`, or behind your own authentication proxy) and give the account only the rights they need.
- **vCenter collector:** uses a **read-only** vCenter account, kept in a Secret (in-cluster) or a root-only file (jump server). The browser never contacts vCenter; the collector writes what it read into a ConfigMap. TLS verification can be turned off for lab certificates (`VCENTER_INSECURE=true`); don't in production.
- **Settings** (Supervisors, org names, baselines, silences) are kept in the browser's local storage, or preset by an administrator in `config.json`. They contain no secrets.

## Supported versions

Only the latest release gets fixes.
