#!/bin/bash
# Keeps the jump server's sign-ins fresh for vks-fleet with "read by default,
# elevate to change":
#   - the read-only account signs in under the plain context names
#     (10.150.4.2, kubernetes-cluster-mnet, …): everything is read with it;
#   - the admin account signs in under the same names plus a suffix
#     (10.150.4.2-admin, kubernetes-cluster-mnet-admin, …): only used for
#     changes, and only while someone has elevated in the plugin.
# kubectl vsphere login names contexts after the server or cluster, so the
# admin signs in first and its contexts are renamed; then the read-only
# account signs in under the plain names.
#
# Run it from a systemd timer every 45 minutes (see the README).
set -euo pipefail

S=10.150.4.2                                   # Supervisor
READ_USER=fleet-viewer@wld.sso                 # "Can view" on the vSphere namespaces
ADMIN_USER=administrator@wld.sso
READ_PASS_FILE=/root/.vsphere-pass-read        # chmod 600
ADMIN_PASS_FILE=/root/.vsphere-pass-admin      # chmod 600
SUFFIX=-admin                                  # must match the plugin's setting
# namespace/cluster pairs to sign in to
CLUSTERS="org2-ns1-mrrtd/kubernetes-cluster-mnet org2-ns1-mrrtd/kubernetes-cluster-9yfw"

login() { # user password-file [namespace cluster]
  export KUBECTL_VSPHERE_PASSWORD="$(cat "$2")"
  if [ $# -ge 4 ]; then
    kubectl vsphere login --server="$S" --vsphere-username "$1" --insecure-skip-tls-verify \
      --tanzu-kubernetes-cluster-namespace "$3" --tanzu-kubernetes-cluster-name "$4" >/dev/null
  else
    kubectl vsphere login --server="$S" --vsphere-username "$1" --insecure-skip-tls-verify >/dev/null
  fi
  unset KUBECTL_VSPHERE_PASSWORD
}
as_admin() { # context: rename to <context><suffix>, replacing an older one
  kubectl config delete-context "$1$SUFFIX" >/dev/null 2>&1 || true
  kubectl config rename-context "$1" "$1$SUFFIX" >/dev/null
}

# 1. The admin account, renamed with the suffix.
login "$ADMIN_USER" "$ADMIN_PASS_FILE"
as_admin "$S"
for nc in $CLUSTERS; do
  login "$ADMIN_USER" "$ADMIN_PASS_FILE" "${nc%/*}" "${nc#*/}"
  as_admin "${nc#*/}"
done
echo "admin sign-ins refreshed (…$SUFFIX)"

# 2. The read-only account, under the plain names.
login "$READ_USER" "$READ_PASS_FILE"
for nc in $CLUSTERS; do
  login "$READ_USER" "$READ_PASS_FILE" "${nc%/*}" "${nc#*/}"
done
echo "read-only sign-ins refreshed"

docker restart headlamp >/dev/null
echo "Headlamp restarted"
