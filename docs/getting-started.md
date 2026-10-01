# Getting started

[← Back to the README](../README.md)

## Ways to run it

- **Headlamp desktop app or Docker:** extract the release's `vks-fleet.tar.gz` into Headlamp's plugins folder.
- **In a cluster (recommended for teams), with Helm:** Headlamp inside a cluster (for example a small management VKS cluster), with the plugin, preset settings, a job that keeps the Supervisor and cluster sign-ins fresh, and the optional vCenter collector. The chart is attached to each release (`vks-fleet-<version>.tgz`); see [deploy/helm/vks-fleet](../deploy/helm/vks-fleet/README.md).
- **In a cluster, with kustomize:** the same deployment as plain manifests; see [deploy/](../deploy/README.md).
- **From Artifact Hub** (once listed): Headlamp's plugin catalog installs it directly.

**Preset settings:** a `config.json` in the plugin folder (same fields as the settings page) configures every browser that has no settings of its own. The deployment ships it from a ConfigMap. On a jump server you can drop one into `~/headlamp-plugins/vks-fleet/config.json`. The settings page shows when a preset is in use, and offers "Copy to edit" to override it for that browser.

## Who is signed in

The Supervisor's permissions are the boundary; the plugin adapts its view to them. At the top of every plugin page a bar shows who is signed in, worked out from the Supervisor's own answers to "can I?" checks:

| Persona | Signed in as | Sees | Can do |
|---|---|---|---|
| **Operator** | an admin account on the Supervisor | every org, with an **Org** switcher | every action |
| **Read-only admin** | an account that can list everywhere but not change clusters | every org, with an **Org** switcher | nothing: actions are hidden |
| **Tenant** | an org user through VCF Automation | only that org's namespaces and clusters | what the org role allows (an org admin can act) |

- **Org cards** at the top of the fleet page, one per org plus "All orgs". Each shows its namespaces, clusters (and how many need attention), VMs, storage used against quota, and memory against the namespace limits. Click one to scope everything to that org, and again (or All orgs) to go back. Orgs with only VMs are included. With an org selected, an **org summary** shows its VCF Automation org quota and each namespace's class, memory against limit and storage, with shortcuts to Capacity, Security and Showback. The choice goes into the address (`?org=…`), so a link opens on the same org.
- **The Org switcher** scopes every plugin page (overview, issues, clusters, machines, packages, search, capacity, upgrades, baseline, cleanup, access) and is remembered between pages. When an operator narrows to one org, a note says actions still use operator rights.
- **Actions follow permissions:** buttons are hidden where the identity can't make changes.
- **Read-only:** one of the three choices under Settings → Changes (allow changes, read by default and elevate to change, read-only), also available as the `readOnly` preset. It turns actions off even for an account that could make changes, for example on a NOC screen.
- **Signed in as:** when this Headlamp holds more than one identity (for example the administrator context, a read-only account's context, and an org's VCF Automation contexts), the bar offers a switch between them. The plugin then reads and acts with the chosen account only, so the Supervisor or VCF Automation decides what's visible. The bar also shows the signed-in user name, from the API server's SelfSubjectReview.
  - `kubectl vsphere login` names the context after the Supervisor's address, so a second vSphere login overwrites the first. Rename after each login: `kubectl config rename-context 10.0.0.2 readonly@10.0.0.2`.
  - For shared instances, turn the switch off with `"identitySwitch": false` in the preset. A preset's `identitySwitch: false` and `readOnly: true` can't be undone from a browser.
- **Links to other views:** `"links": [{"label": "Read-only view", "url": "https://…"}]` in the preset (or the settings page) adds buttons to the bar, for moving between the per-persona instances.

**Keeping VCF Automation contexts signed in on a jump server.** Access tokens last about an hour, and `vcf context refresh` prompts for the API token, so cron re-creates the context from a file only root can read:

```bash
read -s TOKEN && printf '%s' "$TOKEN" > /root/.vcfa-org2-token && chmod 600 /root/.vcfa-org2-token && unset TOKEN
# crontab -e
*/45 * * * * vcf context create org2 --endpoint https://<vcf-automation> --api-token "$(cat /root/.vcfa-org2-token)" --tenant-name <org> --insecure-skip-tls-verify >/dev/null 2>&1 && docker restart headlamp
```

**Tenants through VCF Automation.** Org users live in VCF Automation, not vSphere SSO, so they sign in with the VCF CLI:

```bash
vcf context create org2 --endpoint https://<vcf-automation> --api-token <token> --tenant-name <org> [--insecure-skip-tls-verify]
```

This creates contexts named `<org>:<namespace>:<project>`, each pointing at VCF Automation's proxy for one namespace. The plugin finds them by itself. With no Supervisor configured, the orgs are used automatically; otherwise the settings page offers **Add**. Each namespace's requests go to its own context, and the org name is the tenant name. VCF Automation tokens last about an hour: refresh with `vcf context refresh <context>` (for example from cron), or use the deployment's tenant overlay, which refreshes every 30 minutes.

**Keeping sign-ins fresh on a jump server.** Supervisor and cluster sign-ins last about 10 hours. A small script refreshes them (and the VCF Automation context) and restarts Headlamp; a systemd timer runs it every 45 minutes:

```bash
# /root/vks-refresh.sh (chmod 700): KUBECTL_VSPHERE_PASSWORD from /root/.vsphere-pass (chmod 600),
# then kubectl vsphere login for the Supervisor and each cluster, then: docker restart headlamp
# /etc/systemd/system/vks-refresh.service: Type=oneshot, Environment=HOME=/root, ExecStart=/root/vks-refresh.sh
# /etc/systemd/system/vks-refresh.timer:   OnBootSec=2min, OnUnitActiveSec=45min
systemctl enable --now vks-refresh.timer
```

## Multiple Supervisors

Add as many Supervisors as you like in the plugin settings, each with its own namespaces, tenant label and tenant names. Every cluster key and URL carries the Supervisor ID, and they're read in parallel: an unreachable Supervisor shows an error banner and "Unreachable" in the overview while the rest of the fleet keeps working. With more than one, the fleet page adds a Supervisor filter, a Supervisor column and a "Clusters by Supervisor" chart.

## Demo mode

**Settings → Demo mode** replaces your Supervisors with a fictional fleet: one Supervisor, two orgs (acme and globex) and four clusters. It's for screenshots, talks, and trying the plugin without a lab. A **DEMO** marker shows in the top bar while it's on, and your Supervisor settings come back when it's switched off.

Each cluster has deliberate problems, so every page has something to show:

| Cluster | What it demonstrates |
|---|---|
| payments | The healthy one: hardened workloads, network policies, daily backups, Trivy reports, a saved kube-bench run |
| Supervisor | Every service pod on one ESXi host while four are Ready, a ProviderFailed leftover to clean up, six controller leases renewing |
| checkout | A node disk filling in about 38 hours, crash-loop and disk alerts from Alertmanager, a node stuck draining behind a PodDisruptionBudget, a crash-looping pod, a privileged pod, a cluster-admin grant, a partly failed backup, a failing package, images with critical CVEs |
| sandbox | A Kubernetes version behind (upgrade available), no default StorageClass, no monitoring (to try Enable monitoring) |
| analytics | Control-plane certificates expiring in 18 days, two node pools, Kyverno policy failures, a Kafka volume filling in about 3 days (Prometheus forecast) |

Every request goes to in-memory data through the same code paths as real clusters, including the Pod Security probe (VKS's restricted default). **Dry runs work**, so action dialogs can be tried end to end. **Real changes are always refused.**
