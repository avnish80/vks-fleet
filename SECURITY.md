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
- **In-cluster deployment:** the refresher signs in with a dedicated vSphere account stored in a Kubernetes Secret, and writes the kubeconfig to another Secret that only the Headlamp pod mounts. **Everyone who can open that Headlamp acts as that account**, so expose it only to operators, behind authentication, and give the account only the rights they need: see [Shared installations](#shared-installations).
- **vCenter collector:** uses a **read-only** vCenter account, kept in a Secret (in-cluster) or a root-only file (jump server). The browser never contacts vCenter; the collector writes what it read into a ConfigMap. TLS verification can be turned off for lab certificates (`VCENTER_INSECURE=true`); don't in production.
- **Settings** (Supervisors, org names, baselines, silences) are kept in the browser's local storage, or preset by an administrator in `config.json`. They contain no secrets.

## Shared installations

A Headlamp deployed in a cluster (the Helm chart or `deploy/`) signs in with **one dedicated account**, through the kubeconfig the refresher maintains. Headlamp doesn't know who is using it: **everyone who can open it acts as that account**, with that account's rights. Per-person rights apply only when each person runs Headlamp with their own sign-in (the desktop app, or their own instance).

So for a shared installation:

1. **Give the dedicated account read-only rights** (*Can view* on the vSphere namespaces), and make changes through **read by default, elevate to change**, with a separate admin sign-in, a reason and a time limit (see [Making changes safely](docs/making-changes.md#read-by-default-elevate-to-change)).
2. **Put authentication in front of it.** Don't expose the Service directly. Any authenticating reverse proxy works; for example [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) with your identity provider, restricted to the operators' group, forwarding to Headlamp's Service:

   ```bash
   # oauth2-proxy in front of Headlamp: only members of the platform group get through.
   oauth2-proxy \
     --provider=oidc --oidc-issuer-url=https://idp.example.com \
     --client-id=vks-fleet --client-secret-file=/secrets/client-secret \
     --cookie-secret-file=/secrets/cookie-secret --email-domain='*' \
     --allowed-group=platform-operators \
     --upstream=http://vks-fleet-headlamp.vks-fleet.svc.cluster.local:80 \
     --http-address=0.0.0.0:4180
   ```

   Then expose oauth2-proxy (not Headlamp) through your ingress or load balancer, and keep Headlamp's Service `ClusterIP`.
3. **Limit the network** as well where you can (`service.loadBalancerSourceRanges`, network policies).

## TLS

The sign-in refresher (in-cluster and on a jump server) and the vCenter collector **verify certificates by default**. Supervisors and vCenters usually use vCenter's own CA (download it from `https://<vcenter>/certs/download.zip`): give it to them as `CA_FILE` (the chart's `tls.caSecret`); the refresher also writes it into the kubeconfig, so Headlamp trusts it too. Skipping verification takes an explicit switch (the chart's `tls.insecure`; `SUPERVISOR_INSECURE`, `VCENTER_INSECURE` or `VCFA_INSECURE` for the scripts; `INSECURE` in the jump-server script), meant for lab certificates only.

## Changes and their guarantees

Every action runs a **server-side dry run** of each write first, so anything the API would refuse is caught before anything changes. A dry run doesn't reserve anything, though: conditions can change between the dry run and the change. And a change made of several writes isn't a transaction. If a later write fails, the earlier ones have already taken effect; the plugin then says which steps were applied, which failed, and which weren't sent.

## Supported versions

Only the latest release gets fixes.
