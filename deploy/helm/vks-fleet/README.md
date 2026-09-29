# vks-fleet Helm chart

Headlamp with the vks-fleet plugin, the sign-in refresher and (optionally) the vCenter collector. The same deployment as `deploy/` (kustomize), as a chart.

```bash
kubectl create namespace vks-fleet
kubectl -n vks-fleet create secret generic vks-fleet-vsphere \
  --from-literal=username='svc-vks-fleet@vsphere.local' --from-literal=password='…'

# The plugin: either apply the release ConfigMap (works air-gapped)…
kubectl -n vks-fleet apply --server-side -f \
  https://github.com/avnish80/vks-fleet/releases/download/v1.30.0/vks-fleet-plugin-configmap.yaml
helm install vks-fleet https://github.com/avnish80/vks-fleet/releases/download/v1.30.0/vks-fleet-1.30.0.tgz \
  -n vks-fleet --set refresher.supervisors=10.0.0.2

# …or let the pod download it at start-up
helm install vks-fleet … --set plugin.source=download --set refresher.supervisors=10.0.0.2
```

The most used values: `refresher.supervisors` (required), `settings` (preset plugin settings), `service.type` and `service.loadBalancerSourceRanges`, `ingress.*`, and `collector.enabled` with `collector.vcenter` (plus a `vks-fleet-vcenter` Secret with a read-only account). See `values.yaml` for all of them.

**Everyone who can open this Headlamp acts as the refresher's vSphere account.** Expose it only to operators, and give the account only the rights they need (read-only is enough for every view; actions need edit rights on the Supervisor namespaces).
