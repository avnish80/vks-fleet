# vks-fleet Helm chart

Headlamp with the vks-fleet plugin, the sign-in refresher and (optionally) the vCenter collector. The same deployment as `deploy/` (kustomize), as a chart.

```bash
VERSION=1.33.4   # the release you're installing (see the GitHub releases)
kubectl create namespace vks-fleet
# TLS is verified: most Supervisors and vCenters use vCenter's own CA (https://<vcenter>/certs/download.zip).
kubectl -n vks-fleet create secret generic vks-fleet-ca --from-file=ca.crt=vcenter-ca.pem
kubectl -n vks-fleet create secret generic vks-fleet-vsphere \
  --from-literal=username='svc-vks-fleet@vsphere.local' --from-literal=password='…'

# The plugin: either apply the release ConfigMap (works air-gapped)…
kubectl -n vks-fleet apply --server-side -f \
  https://github.com/avnish80/vks-fleet/releases/download/v$VERSION/vks-fleet-plugin-configmap.yaml
helm install vks-fleet https://github.com/avnish80/vks-fleet/releases/download/v$VERSION/vks-fleet-$VERSION.tgz \
  -n vks-fleet --set refresher.supervisors=10.0.0.2 --set caSecret=vks-fleet-ca

# …or let the pod download it at start-up
helm install vks-fleet … --set plugin.source=download --set refresher.supervisors=10.0.0.2 --set caSecret=vks-fleet-ca
```

The most used values: `refresher.supervisors` (required), `settings` (preset plugin settings), `service.type` and `service.loadBalancerSourceRanges`, `ingress.*`, and `collector.enabled` with `collector.vcenter` (plus a `vks-fleet-vcenter` Secret with a read-only account). See `values.yaml` for all of them.

**Everyone who can open this Headlamp acts as the refresher's vSphere account.** Expose it only to operators, and give the account only the rights they need (read-only is enough for every view; actions need edit rights on the Supervisor namespaces).

**TLS:** the refresher and the collector verify certificates. Without `caSecret`, they trust only public CAs, which most Supervisors don't use. `refresher.insecure=true` and `collector.insecure=true` skip verification, for lab certificates only.
