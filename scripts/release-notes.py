#!/usr/bin/env python3
"""
The description of a GitHub release: what VKS fleet is, how to install it, what this
release changed (its section of CHANGELOG.md), and the validation scope.

  python3 scripts/release-notes.py 1.34.3 > release-notes.md
"""
import pathlib
import re
import sys

version = sys.argv[1].lstrip("v")
changelog = pathlib.Path(__file__).resolve().parent.parent.joinpath("CHANGELOG.md").read_text()

# This version's section: from "## <version>" (with or without a note in brackets) to the next "## ".
m = re.search(rf"^## {re.escape(version)}\b[^\n]*\n(.*?)(?=^## |\Z)", changelog, re.M | re.S)
changes = m.group(1).strip() if m else "See [CHANGELOG.md](https://github.com/avnish80/vks-fleet/blob/main/CHANGELOG.md)."
candidate = bool(m) and "release candidate" in m.group(0).splitlines()[0].lower()

print(f"""# VKS fleet v{version}{" (release candidate)" if candidate else ""}

**Operations and reliability for vSphere Kubernetes Service fleets.** An open-source [Headlamp](https://headlamp.dev) plugin that brings health, investigation, capacity forecasting and change planning together across your Supervisors and their VKS clusters.

- **Observe:** what needs attention across the fleet, and what runs out in the next 30 days
- **Investigate:** whether a problem is in Kubernetes, the VM or the ESXi host underneath
- **Predict:** capacity and reliability problems before they arrive
- **Pre-flight:** what an upgrade, a scale or a VM class change will do, before you start it
- **Act:** controlled changes, each with its checks and a server-side dry run

No VMware lab? Install the plugin and choose **Try the demo**.

## What's new

{changes}

## Install

- **Headlamp desktop app or Docker:** extract `vks-fleet.tar.gz` into Headlamp's plugins folder.
- **In a cluster:** the Helm chart, `vks-fleet-{version}.tgz` (see the [chart guide](https://github.com/avnish80/vks-fleet/blob/v{version}/deploy/helm/vks-fleet/README.md)), or `vks-fleet-plugin-configmap.yaml` with the [kustomize manifests](https://github.com/avnish80/vks-fleet/tree/v{version}/deploy).

## Validation

Tested against VMware Cloud Foundation 9.1 and vSphere Kubernetes Service 3.7 on Headlamp 0.45, including a clean Helm installation under restricted Pod Security with verified TLS, and live changes (scaling, pause and resume). Some write operations and larger fleets remain unverified: see [Validation status](https://github.com/avnish80/vks-fleet#validation-status).

---

A personal open-source project under the Apache 2.0 licence. Not affiliated with, endorsed by, or supported by Broadcom or VMware.""")
