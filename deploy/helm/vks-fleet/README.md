# vks-fleet Helm chart

Headlamp with the vks-fleet plugin, inside a cluster (a small management VKS cluster works well), plus a job that keeps its sign-ins fresh and, optionally, the vCenter collector.

Everything below runs from any machine with `kubectl` and `helm` pointed at that cluster.

## Install in three steps

**1. A namespace, and the account Headlamp signs in with.** Use a dedicated vSphere account with *Can view* on the vSphere namespaces: in a shared Headlamp, everyone acts as this account (see [Security](#security)).

```bash
kubectl create namespace vks-fleet
kubectl -n vks-fleet create secret generic vks-fleet-vsphere \
  --from-literal=username='svc-vks-fleet@vsphere.local' --from-literal=password='…'
```

**2. Choose how to handle certificates.** Supervisors usually have a certificate from vCenter's own CA, which nothing trusts by default. Pick one:

- **Secure (recommended):** trust vCenter's CA.

  ```bash
  VCENTER=vcenter.example.com
  curl -fsk -o vc-certs.zip "https://$VCENTER/certs/download.zip"   # -k only for this download: it fetches the CA itself
  unzip -q -o vc-certs.zip -d vc-certs && cat vc-certs/certs/lin/*.0 > vcenter-ca.pem
  kubectl -n vks-fleet create secret generic vks-fleet-ca --from-file=ca.crt=vcenter-ca.pem
  TLS="--set tls.caSecret=vks-fleet-ca"
  ```

- **Quick, for labs:** skip certificate checks.

  ```bash
  TLS="--set tls.insecure=true"
  ```

**3. Install, and sign in for the first time.**

```bash
VERSION=1.34.2                 # the release to install
SUPERVISOR=10.0.0.2            # your Supervisor's address (several: "10.0.0.2 10.0.0.3")

helm install vks-fleet "https://github.com/avnish80/vks-fleet/releases/download/v$VERSION/vks-fleet-$VERSION.tgz" \
  -n vks-fleet --set plugin.source=download --set refresher.supervisors="$SUPERVISOR" $TLS

kubectl -n vks-fleet create job --from=cronjob/vks-fleet-refresher first-sign-in
kubectl -n vks-fleet logs -f job/first-sign-in
```

The log ends with *"Kubeconfig stored in Secret …; Headlamp restarted"*. After that, the refresher signs in again every 6 hours.

## Open it

- **Port-forward** (simplest): `kubectl -n vks-fleet port-forward svc/vks-fleet-headlamp 4466:80`, then http://localhost:4466 on the same machine.
- **A load balancer:** add `--set service.type=LoadBalancer` to the install (or `helm upgrade vks-fleet … --reuse-values --set service.type=LoadBalancer`), then open the address in `kubectl -n vks-fleet get svc vks-fleet-headlamp`. Restrict who can reach it with `--set "service.loadBalancerSourceRanges={10.1.2.3/32}"`.
- **An ingress:** `--set ingress.enabled=true --set ingress.host=fleet.example.com`, ideally behind authentication (see [Security](#security)).

Then **Settings → Plugins → vks-fleet → Add Supervisor**, pick the Supervisor's context, and open **VKS fleet**. The settings page's setup status says whether everything connects.

## Options

| Value | What it does |
|---|---|
| `refresher.supervisors` | Supervisor addresses (required) |
| `refresher.clusters` | `all` (default), `none`, or a list such as `team-a-ns1/kubernetes-cluster-a1b2` |
| `tls.caSecret` | a Secret with vCenter's CA (key `ca.crt`), used by the refresher, the collector and Headlamp |
| `tls.insecure` | `true` skips certificate checks (lab certificates only) |
| `plugin.source` | `download` (from the GitHub release) or `configMap` (offline: apply the release's `vks-fleet-plugin-configmap.yaml` first) |
| `settings` | preset plugin settings (Supervisors, org names, baseline…) |
| `service.*`, `ingress.*` | how Headlamp is exposed |
| `collector.enabled`, `collector.vcenter` | the vCenter collector (needs a `vks-fleet-vcenter` Secret with a read-only vCenter account) |
| `headlamp.image.tag` | the Headlamp release (tested with v0.45.0) |

All of them: [values.yaml](values.yaml).

## Security

- **Everyone who can open this Headlamp acts as its sign-in account.** Use a read-only account, make changes through *read by default, elevate to change*, and put authentication in front of shared access. Details and an example: [SECURITY.md](../../../SECURITY.md#shared-installations).
- **The pods meet Kubernetes' "restricted" Pod Security level**, which VKS enforces by default, so no namespace labels are needed.

## If something doesn't work

| What you see | Why, and what to do |
|---|---|
| Headlamp pod stuck in `ContainerCreating`, *secret … kubeconfig not found* | The refresher hasn't run yet: run the `first-sign-in` job above |
| The sign-in log shows `x509` or *certificate signed by unknown authority* | The Supervisor's certificate isn't trusted: use `tls.caSecret` with vCenter's CA, or `tls.insecure=true` for a lab |
| Settings shows *"its certificate isn't trusted"* | Same cause, seen from Headlamp: same fix (then run `first-sign-in` again) |
| Pods rejected with *violates PodSecurity* | You're on a chart older than v1.34.1: upgrade |
| *"another operation (install/upgrade/rollback) is in progress"* | An interrupted attempt left the release half-done: `helm -n vks-fleet history vks-fleet`, then roll back to the last `deployed` revision, or uninstall and install again |
| *Sign-in failed* for the Supervisor | Check the account in `vks-fleet-vsphere`, and that it has *Can view* on the namespaces |

Uninstall: `helm -n vks-fleet uninstall vks-fleet`, then `kubectl delete namespace vks-fleet`.
