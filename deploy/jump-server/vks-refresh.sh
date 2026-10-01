#!/bin/bash
# Keeps the jump server's sign-ins fresh for vks-fleet with "read by default,
# elevate to change":
#   - the read-only account signs in under the plain context names
#     (10.0.0.2, kubernetes-cluster-c3d4, …): everything is read with it;
#   - the admin account signs in under the same names plus a suffix
#     (10.0.0.2-admin, kubernetes-cluster-c3d4-admin, …): only used for
#     changes, and only while someone has elevated in the plugin.
# kubectl vsphere login names contexts after the server or cluster, so the
# admin signs in first and its contexts are renamed; then the read-only
# account signs in under the plain names.
#
# Run it from a systemd timer every 45 minutes (see the README).
set -euo pipefail

S=10.0.0.2                                   # Supervisor
READ_USER=fleet-viewer@vsphere.local                 # "Can view" on the vSphere namespaces
ADMIN_USER=administrator@vsphere.local
READ_PASS_FILE=/root/.vsphere-pass-read        # chmod 600
ADMIN_PASS_FILE=/root/.vsphere-pass-admin      # chmod 600
SUFFIX=-admin                                  # must match the plugin's setting
# TLS: certificates are verified. If the Supervisor's certificate is signed by vCenter's own CA
# (the usual case), point CA_FILE at that CA (https://<vcenter>/certs/download.zip).
CA_FILE=                                       # e.g. /root/vcenter-ca.pem
INSECURE=false                                 # true skips verification: lab certificates only
TLS_FLAG=""
[ "$INSECURE" = true ] && TLS_FLAG=--insecure-skip-tls-verify
[ -n "$CA_FILE" ] && export SSL_CERT_FILE="$CA_FILE"   # kubectl-vsphere trusts this bundle
# namespace/cluster pairs to sign in to
CLUSTERS="team-a-ns1/kubernetes-cluster-c3d4 team-a-ns1/kubernetes-cluster-a1b2"

login() { # user password-file [namespace cluster]
  export KUBECTL_VSPHERE_PASSWORD="$(cat "$2")"
  if [ $# -ge 4 ]; then
    kubectl vsphere login --server="$S" --vsphere-username "$1" $TLS_FLAG \
      --tanzu-kubernetes-cluster-namespace "$3" --tanzu-kubernetes-cluster-name "$4" >/dev/null
  else
    kubectl vsphere login --server="$S" --vsphere-username "$1" $TLS_FLAG >/dev/null
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
