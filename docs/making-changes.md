# Making changes safely

[← Back to the README](../README.md)

## Pre-flight: change impact analysis

**Lifecycle → Pre-flight** (or **Pre-flight** on an Upgrade Planner row) answers *what will this change do, and is it safe to start?* before an **upgrade**, a **node pool scale**, or a **pool's VM class change**:

- **The change:** the version path VKS allows, the releases the Supervisor offers, a single control-plane node's brief API gap.
- **Health gates:** a paused cluster, a rollout already running, a node stuck deleting (a new rollout would queue behind it), Cluster API controllers whose leases stopped renewing, the Supervisor's health.
- **Capacity while it runs and after:** a rolling update adds one VM per node pool at a time; the namespace's memory overcommit and quota are checked for the peak, and for the new size afterwards.
- **Blast radius, read from the cluster:** the nodes replaced or removed, the pods, workloads and namespaces that move, **single-replica workloads** with a brief outage, pods with no controller (evicted, not recreated), pinned pods, and **PodDisruptionBudgets** allowing no disruptions (drains wait on them). The control plane is counted apart; its static pods come back with it.
- **For upgrades:** deprecated APIs still in use that the target removes (from Prometheus), and the packages you manage, to check against the target (VKS's own move with the release).

A verdict (**clear to go**, **go ahead with care**, **stop**) comes with a recommendation. **Continue to the change…** opens the usual action dialog with its dry run for upgrades and scaling, and stays disabled on a stop. A VM class change gives the YAML to set in the Cluster's spec or its GitOps source.

## Read by default, elevate to change

Everyday viewing needs no write rights, so it shouldn't have them. With **Settings → Read by default, elevate to change**:

- **Everything is read with a read-only sign-in:** the contexts as configured, for example `10.0.0.2` and `kubernetes-cluster-c3d4`.
- **Changes need Elevate** (top bar), with **a reason** and **a time limit** (5 to 60 minutes). While elevated, the bar shows the countdown and **Drop**. Elevation ends when the time is up, when dropped, or when the page reloads, and it's never saved.
- **While elevated, only change requests** switch to the admin sign-in: `10.0.0.2-admin` (or the context set per Supervisor) and `<cluster>-admin`. Reads stay read-only.
- **Every change made while elevated records when and why** (`vks-fleet/elevated`, `vks-fleet/elevation-reason`) on the objects it creates or merge-patches, so the change audit shows it.
- **Actions stay visible in read-only mode.** Their dialogs start with an inline **Elevate** step; dry runs need write rights too, so they run after it.

**Setting it up on a jump server:**

1. In vCenter, create a read-only SSO user (for example `fleet-viewer@vsphere.local`) and give it **Can view** on the vSphere namespaces. VKS maps that to read-only access inside the clusters too, while *Can edit* maps to cluster-admin.
2. Store both passwords in root-only files, `/root/.vsphere-pass-read` and `/root/.vsphere-pass-admin` (`chmod 600`).
3. Use [`deploy/jump-server/vks-refresh.sh`](../deploy/jump-server/vks-refresh.sh) instead of the single-account script. It signs in the admin first and renames its contexts with `-admin` (a second `kubectl vsphere login` would otherwise overwrite them), then signs in the read-only account under the plain names, and restarts Headlamp. Run it from the same systemd timer.
4. Turn the setting on. Each Supervisor's change context defaults to `<context>-admin` and can be set explicitly.

On a shared, in-cluster deployment, per-user sign-in (OIDC) is the stronger end state: everyone signs in as themselves, and elevation becomes signing in with an admin role.

## Actions

**What a dry run guarantees, and what it doesn't.** Each write is sent with `?dryRun=All` first, so anything the API (and the VKS admission webhooks) would refuse is caught before anything changes. It reserves nothing: conditions can change before you apply. A change made of several writes isn't a transaction either: if a later write fails, the earlier ones have already taken effect, and the dialog says exactly that (*"Step 2 of 3 failed (…). Already applied, and not undone: … 1 later step was not sent."*), so you can check the object before trying again.

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
