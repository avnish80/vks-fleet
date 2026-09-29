# Artifact Hub

The Headlamp plugin is listed on [Artifact Hub](https://artifacthub.io) from this folder.

1. **Once:** on artifacthub.io, add a repository of kind **Headlamp plugins** with the URL `https://github.com/avnish80/vks-fleet/tree/main/artifacthub`. Put the repository ID it shows into `artifacthub-repo.yml` to verify ownership.
2. **Each release:** CI attaches `artifacthub-pkg.yml` (with the tarball's checksum) to the GitHub release. Save it as `artifacthub/vks-fleet/<version>/artifacthub-pkg.yml` and push. Artifact Hub picks it up on its next scan.

Check the metadata against Artifact Hub's current documentation for Headlamp plugins before the first submission; the annotation names are the ones Headlamp's plugin catalog uses.
