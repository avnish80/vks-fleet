# Operator deployment

This runs Headlamp with the vks-fleet plugin inside a Kubernetes cluster, typically a small management VKS cluster, so operators open a URL instead of each running Headlamp on a jump server with their own kubeconfig.

```
 operators ──► Service / LB ──► Headlamp pod ──► Supervisor(s)  ──► VKS clusters
                                   ▲    ▲
         vks-fleet-plugin ConfigMap┘    └ vks-fleet-kubeconfig Secret
         + preset settings (config.json)        ▲
                                                │ every 6 hours
                              vks-fleet-refresher CronJob
                              (kubectl + vSphere plugin downloaded from the Supervisor)
```

- **The plugin** comes from a ConfigMap published with every release. The cluster doesn't need to reach GitHub.
- **Preset settings** (`settings/config.json`: Supervisors, tenant label, org names) are shipped next to the plugin. Every browser starts configured; a browser can still override them in the plugin settings.
- **Sign-ins:** the refresher downloads `kubectl` and the vSphere plugin from the Supervisor's own CLI tools page, signs in with a dedicated vSphere account to each Supervisor and every VKS cluster it can see, stores the kubeconfig as a Secret, and restarts Headlamp. It runs every 6 hours, inside the roughly 10-hour token lifetime.

## Before you start

- **A cluster to run it in.** From its pods, that cluster must reach each Supervisor's API address (for example `10.150.4.2:443`) and each VKS cluster's API endpoint (for example `40.60.0.5:6443`). It must also be able to pull `ghcr.io/headlamp-k8s/headlamp` and `python:3.12-slim`; if it can't, mirror them into your registry and change `images:` in `kustomization.yaml`.
- **A dedicated vSphere SSO account for the refresher.** Headlamp acts as this account for **everyone** who opens it, so give it only what operators need:
  - read access is enough for every view
  - the actions (upgrade, scale, pause, replace, timeouts) need edit rights on the Supervisor namespaces
- **Somewhere to run `kubectl`** against the management cluster.

## Install

```bash
cd deploy

# 1. Namespace and the plugin (published with each release). Server-side apply,
#    because the plugin is too large for kubectl's last-applied annotation.
kubectl create namespace vks-fleet
kubectl -n vks-fleet apply --server-side -f \
  https://github.com/avnish80/vks-fleet/releases/latest/download/vks-fleet-plugin-configmap.yaml

# 2. The refresher's vSphere account (not stored in git)
kubectl -n vks-fleet create secret generic vks-fleet-vsphere \
  --from-literal=username='svc-vks-fleet@wld.sso' --from-literal=password='…'

# 3. Your Supervisors and tenant names
#    settings/config.json      what the plugin shows (same fields as the plugin settings page)
#    refresher/refresher.env   which Supervisors (and clusters) to sign in to

# 4. Deploy, then run the first sign-in now rather than waiting for the schedule
kubectl apply -k .
kubectl -n vks-fleet create job --from=cronjob/vks-fleet-refresher first-signin
kubectl -n vks-fleet logs -f job/first-signin
```

The Headlamp pod waits in `ContainerCreating` until the first sign-in has written its Secret, then starts.

## Personas: one instance each

Each Headlamp instance acts as one identity. For operators, read-only admins and tenants, run one instance per persona, each in its own namespace with its own URL:

| Overlay | Identity | Notes |
|---|---|---|
| `.` (base) | operator: a vSphere account with edit rights | as above |
| `overlays/readonly` | a vSphere account with view-only rights | `readOnly: true` preset as well, so actions stay off whatever the account can do |
| `overlays/tenant` | an org user through VCF Automation (API token) | the refresher runs in VCFA mode every 30 minutes; set `refresher.env` (endpoint, tenant name, namespaces with their URNs) and `config.json` |

Each preset sets `"identitySwitch": false`, so a shared instance never offers other identities, and viewers can't turn it back on. To let people move between instances, add links in each preset's `config.json`:

```json
"links": [
  { "label": "Read-only view", "url": "https://fleet-readonly.example.com" },
  { "label": "org2 view", "url": "https://fleet-org2.example.com" }
]
```

For the tenant overlay, find each namespace's URN in your VCF CLI context's server address:

```bash
kubectl config view -o jsonpath='{range .contexts[*]}{.name}{"  "}{end}'; echo
kubectl config view -o jsonpath='{.clusters[*].cluster.server}' | tr ' ' '\n' | grep proxy
```

Then create the API token Secret and apply:

```bash
kubectl create namespace vks-fleet-org2
kubectl -n vks-fleet-org2 apply --server-side -f https://github.com/avnish80/vks-fleet/releases/latest/download/vks-fleet-plugin-configmap.yaml
kubectl -n vks-fleet-org2 create secret generic vks-fleet-vcfa --from-literal=api-token='…'
kubectl apply -k overlays/tenant
kubectl -n vks-fleet-org2 create job --from=cronjob/vks-fleet-refresher first-signin
```

## Open it

For a pilot, port-forward from wherever you run `kubectl`:

```bash
kubectl -n vks-fleet port-forward svc/headlamp 4466:80
# then http://localhost:4466
```

To give operators a URL, use the load balancer overlay. **Set `loadBalancerSourceRanges` to your operators' subnet first**, because anyone who can reach it acts as the refresher's account:

```bash
kubectl apply -k overlays/loadbalancer
kubectl -n vks-fleet get svc headlamp      # EXTERNAL-IP
```

## Updating

- **A new plugin release:**

  ```bash
  kubectl -n vks-fleet apply --server-side -f https://github.com/avnish80/vks-fleet/releases/latest/download/vks-fleet-plugin-configmap.yaml
  kubectl -n vks-fleet rollout restart deployment/headlamp
  ```

- **Settings, or the refresher's list:** edit the files, run `kubectl apply -k .`, and restart Headlamp (or wait for the next refresh).
- **A new cluster:** the next refresh signs in to it automatically (with `CLUSTERS=all`). To sign in straight away: `kubectl -n vks-fleet create job --from=cronjob/vks-fleet-refresher signin-now`.

## Troubleshooting

- **Headlamp stays in `ContainerCreating`:** the Secret doesn't exist yet. Check the refresher job's logs.
- **"Supervisor … sign-in failed":** check the account and password in `vks-fleet-vsphere`, and that the pods can reach the Supervisor on port 443.
- **A cluster shows "Not signed in":** the refresher's account has no permission on that cluster's namespace, or the job logged a failure for it.
- **Clusters show "Sign-in expired":** the CronJob hasn't run for more than about 10 hours. Check with `kubectl -n vks-fleet get cronjob,jobs`.

## Security notes

- **One shared identity.** Everyone who can open this Headlamp acts as the refresher's vSphere account. Protect the URL: port-forward, tight source ranges, or an authenticating proxy in front. Per-user sign-in (OIDC, so the Supervisor's RBAC applies to each operator) is the next step on the roadmap.
- **No access to its own cluster.** Headlamp runs without a token for the cluster it lives in. The refresher can only write Secrets in its namespace and restart the `headlamp` Deployment.
- **Tokens are short-lived.** The Secret holds sign-in tokens that expire in about 10 hours, not the vSphere password.
