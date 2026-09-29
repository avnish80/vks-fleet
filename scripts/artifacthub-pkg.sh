#!/usr/bin/env bash
# Writes Artifact Hub package metadata for one release of the Headlamp plugin.
#   scripts/artifacthub-pkg.sh <version> <path to vks-fleet.tar.gz>
# CI attaches the result to each release as artifacthub-pkg.yml. To publish a
# version on Artifact Hub, save it as artifacthub/vks-fleet/<version>/artifacthub-pkg.yml
# and push; Artifact Hub reads that folder (see artifacthub/README.md).
set -euo pipefail
version="$1"
tarball="$2"
sum=$(sha256sum "$tarball" | cut -d' ' -f1)
cat <<YAML
version: ${version}
name: vks-fleet
displayName: VKS fleet
createdAt: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
description: A multi-cluster view for vSphere Kubernetes Service (VKS) fleets on vSphere Supervisors, for operators and tenants.
license: Apache-2.0
homeURL: https://github.com/avnish80/vks-fleet
keywords:
  - vks
  - vsphere
  - supervisor
  - cluster-api
  - fleet
  - vcf
links:
  - name: Source
    url: https://github.com/avnish80/vks-fleet
  - name: Changelog
    url: https://github.com/avnish80/vks-fleet/blob/main/CHANGELOG.md
maintainers:
  - name: Avnish Tripathi
    email: noreply@github.com
annotations:
  headlamp/plugin/archive-url: "https://github.com/avnish80/vks-fleet/releases/download/v${version}/vks-fleet.tar.gz"
  headlamp/plugin/archive-checksum: "SHA256:${sum}"
  headlamp/plugin/distro-compat: "in-cluster,web,app,docker-desktop"
YAML
