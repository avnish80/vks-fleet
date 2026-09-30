# The Supervisor

[← Back to the README](../README.md)

## Supervisor health

**Supervisor health** (sidebar, near the top) watches the platform itself, from what its API lets an administrator read. The Supervisor's `/readyz` and `/metrics` aren't exposed through its endpoint, and even an SSO administrator can't list leases or admission webhooks cluster-wide, so it works from the outside. Per Supervisor:

- **A health score** (0–100) and headline tiles: control-plane nodes, ESXi hosts, controllers, services, stuck objects, and the API response time the plugin measures itself.
- **Controllers alive:** the leader-election leases of Cluster API, the vSphere provider, kubeadm bootstrap and control plane, the runtime extension and the VKS controller (in the `svc-tkg-…` namespace), plus VM Operator, NSX and CSI where readable. A controller that **stops renewing its lease is stuck or gone even if its pod shows Running**: that's a critical issue, as is a lease with no leader.
- **Supervisor services** (vSphere Pods): running pods and their hosts, restarts, and pods failing with no replacement. **`ProviderFailed` pods** (the ESXi host couldn't run the vSphere Pod) left behind next to a running replacement are shown as leftovers, with **Clean up…** (dry run first; only the failed pods are deleted).
- **Hosts:** one compact card per ESXi host with its CPU and memory, alarms, and **what runs there**: the Supervisor's control-plane VM, Supervisor service pods, each cluster's nodes (its control-plane node marked), and VM Service VMs. **Clicking a host shows what its failure would take down** until vSphere HA restarts its VMs: the Supervisor API if its control plane is there, services with every pod on it (down) or some (degraded), clusters losing nodes or their whole control plane, and VMs. When **every service pod runs on one host while others are Ready**, that's flagged: pods rescheduled after a host problem stay where they landed. Where VM Operator doesn't report a VM's host (VCF 9.1 doesn't), the vCenter collector's **placement** fills it in, which also feeds Investigate's walk-down and host patterns.
- **The control plane** and hosts, the **reconcile backlog** by kind (clusters, machines, VMs, load balancers, NSX objects, subnets, volumes, with the one stuck longest), and **warning events by reason**.

**From vCenter** (with the vCenter collector): the Supervisor's own status lives in vCenter. The collector ([`deploy/collector`](../deploy/collector)) signs in with a **read-only vCenter account** and writes it into a ConfigMap the plugin reads through the normal Kubernetes connection, so the browser never talks to vCenter or holds its credentials. It adds:

- the **configuration and Kubernetes status**, with vCenter's messages (the Workload Management view)
- the **control-plane VMs** (power state, size)
- **Supervisor Services** as vCenter sees them (version, state, messages)
- the **ESXi hosts** of the cluster (connection, power)
- **triggered alarms**, optionally: they need the `pyvmomi` library, since alarms aren't available over REST

These feed the health score and raise issues, including a notice if the collector stops writing.

**Utilisation** (with `pyvmomi`): the collector also samples vCenter's performance counters for the **control-plane VMs and ESXi hosts** every 5 minutes (CPU, memory, disk and network, averaged over the last 5 minutes), and the control-plane VM's **guest disks** through VMware Tools. It keeps **a rolling 24 hours** in the ConfigMap itself, so the Supervisor health page shows current values per VM and host and **charts for the last day**, with no database. The control-plane disk gets a **forecast** ("full in about 3 days"). A control-plane VM with a disk over 80% or memory over 90%, or a host over 90%, takes points off the health score and raises an issue: etcd and the API server live on that VM, and a full disk there stops the whole Supervisor. (The Supervisor's metrics API isn't exposed to administrators, so vCenter is the only source for this.)

### Tracking the Supervisor: your options

**Without the collector,** Supervisor health still shows everything the Supervisor's own API allows: controllers and their leases, Supervisor services and where their pods run, ESXi hosts as nodes, the reconcile backlog, warning events, and the API's responsiveness. What needs vCenter is its status and messages, the control-plane VMs, alarms, utilisation, and which host each VM runs on.

**With the collector,** two choices: where it **runs** (anything that reaches vCenter and has `kubectl` access), and where it **saves** its results (a ConfigMap, in any namespace the plugin can read). The plugin only runs in the browser, so the results have to live somewhere Headlamp can read. That doesn't have to be an extra cluster:

| Option | The collector runs | It saves to | Extra infrastructure | Best for |
|---|---|---|---|---|
| **Supervisor namespace** | on a jump server (systemd timer) | a vSphere Namespace owned by the platform team, read through the Supervisor's own context | none | jump-server setups: nothing beyond the Supervisor |
| **An existing cluster** | on a jump server | a namespace in a VKS cluster the platform team owns (a management or tools cluster) | none, if such a cluster exists | teams that already run one |
| **In-cluster** | as a CronJob next to Headlamp (Helm chart or kustomize) | the namespace Headlamp runs in | the cluster Headlamp runs in | shared Headlamp deployments |

Whichever you choose:

- **Keep it where only operators can read.** The ConfigMap holds infrastructure details (hosts, alarms, the control-plane VM, VM placement), and everyone with access to its namespace can read it. **Don't use a tenant's namespace**; create a small vSphere Namespace for the platform team (for example `platform-ops`) with permissions for operators only.
- **The writer needs edit rights** in that namespace. With *read by default, elevate to change*, the plain Supervisor context is the read-only account, so point the collector at the **admin** context (for example `10.0.0.2-admin`) while the plugin reads through the plain one.
- **Create the namespace first.** The collector says so plainly if it can't write (a missing namespace, missing rights, or an expired sign-in).

For the Supervisor-namespace option on a jump server, set `KUBE_CONTEXT` to the Supervisor's context and `OUTPUT_NAMESPACE` to the platform namespace in the service below, and in **Settings → vCenter collector** choose the same context and namespace.

**The account:** a vCenter SSO user with the built-in **Read-only** role at the vCenter root (propagated). If the Workload Management calls answer 403, the role also needs the Namespaces *view* privilege.

**Running it in a cluster** (every 5 minutes, next to Headlamp's in-cluster deployment):

```bash
kubectl -n vks-fleet create secret generic vks-fleet-vcenter \
  --from-literal=username=vks-fleet-ro@vsphere.local --from-literal=password='…'
# set VCENTER in deploy/collector/collector.env, then:
kubectl apply -k deploy/overlays/vcenter
```

**Or from a jump server** (writing into a platform-owned Supervisor namespace or any cluster the plugin can read; the example uses a cluster, `kubernetes-cluster-a1b2`):

```bash
kubectl --context kubernetes-cluster-a1b2 create namespace vks-fleet
printf '%s' 'the-password' > /root/.vcenter-pass-ro && chmod 600 /root/.vcenter-pass-ro
pip install pyvmomi   # optional, for alarms

cat > /etc/systemd/system/vks-vcenter.service <<'UNIT'
[Unit]
Description=vks-fleet vCenter collector
[Service]
Type=oneshot
Environment=HOME=/root
Environment=VCENTER=vcenter.example.com VCENTER_USERNAME=vks-fleet-ro@vsphere.local VCENTER_PASSWORD_FILE=/root/.vcenter-pass-ro
Environment=VCENTER_INSECURE=true KUBE_CONTEXT=kubernetes-cluster-a1b2 OUTPUT_NAMESPACE=vks-fleet
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

Then, in **Settings → vCenter collector**, choose the context where it saves (the Supervisor's, or `kubernetes-cluster-a1b2` in the example) and the namespace; the ConfigMap's name defaults to `vks-fleet-vcenter`. Each vCenter record is matched to its Supervisor by API address, then by its ESXi hosts (which are also the Supervisor's nodes, with the same names; the reliable match, since vCenter lists management addresses rather than the load-balanced one), or directly when there's one of each.
