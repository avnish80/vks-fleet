"""
vks-fleet sign-in refresher.

Signs in to each Supervisor (and every VKS cluster the account can see) with
the vSphere plugin downloaded from the Supervisor itself, stores the resulting
kubeconfig as a Secret in this cluster, and restarts Headlamp to pick it up.
Standard library only; runs as a CronJob every few hours, inside the token
lifetime.

Two modes:
  MODE=supervisor (default): sign in to Supervisors with a vSphere account.
  MODE=vcfa: an org's view through VCF Automation. Exchanges the org's API
    token for an access token and writes one context per namespace, named
    "<label>:<namespace>:<project>" like the VCF CLI does.

Environment (supervisor mode):
  SUPERVISORS          Supervisor API addresses, space or comma separated
  CLUSTERS             all | none | ns/name,ns/name,...
  VSPHERE_USERNAME     account to sign in with
  VSPHERE_PASSWORD
  KUBECONFIG_SECRET    Secret to write (default vks-fleet-kubeconfig)
  HEADLAMP_DEPLOYMENT  Deployment to restart (default headlamp)
  POD_NAMESPACE        where both live

Environment (vcfa mode):
  VCFA_ENDPOINT        e.g. https://auto-a.site-a.vcf.lab
  VCFA_TENANT          the org's tenant name, e.g. Org2-CTGW
  VCFA_LABEL           short org name used in context names (default: VCFA_TENANT)
  VCFA_NAMESPACES      namespace=urn[@project], comma separated, e.g.
                       org2-ns1-mrrtd=urn:vcloud:namespace:cee559b7-…@default-project
  VCFA_API_TOKEN       the org user's API token (from Secret vks-fleet-vcfa)
  VCFA_INSECURE        "true" to skip TLS verification (lab certificates)
  VCFA_ORG_SERVER      optional: the org-level server address from your VCF CLI
                       context (kubectl config view), to add a "<label>" context
                       the plugin uses for the org's quotas
"""
import json
import io
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

WORK = pathlib.Path(os.environ.get("WORK_DIR") or tempfile.mkdtemp(dir="/work" if os.path.isdir("/work") else None))
BIN = WORK / "bin"
KUBECONFIG = WORK / "kubeconfig"


def log(*parts):
    print(*parts, flush=True)


def settings():
    sups = [s for s in os.environ.get("SUPERVISORS", "").replace(",", " ").split() if s]
    clusters = os.environ.get("CLUSTERS", "all").strip() or "all"
    return {
        "supervisors": sups,
        "clusters": clusters,
        "user": os.environ.get("VSPHERE_USERNAME", ""),
        "password": os.environ.get("VSPHERE_PASSWORD", ""),
        "secret": os.environ.get("KUBECONFIG_SECRET", "vks-fleet-kubeconfig"),
        "deployment": os.environ.get("HEADLAMP_DEPLOYMENT", "headlamp"),
        "namespace": os.environ.get("POD_NAMESPACE") or read_namespace(),
    }


def read_namespace():
    try:
        return pathlib.Path("/var/run/secrets/kubernetes.io/serviceaccount/namespace").read_text().strip()
    except OSError:
        return "vks-fleet"


def wanted_clusters(spec, listing):
    """Filters 'namespace name' lines by the CLUSTERS setting."""
    if spec == "none":
        return []
    pairs = [tuple(line.split()[:2]) for line in listing.splitlines() if len(line.split()) >= 2]
    if spec == "all":
        return pairs
    allowed = {x.strip() for x in spec.split(",") if x.strip()}
    return [p for p in pairs if f"{p[0]}/{p[1]}" in allowed]


def fetch_tools(server):
    """kubectl and kubectl-vsphere, from the Supervisor's own CLI tools download."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    url = f"https://{server}/wcp/plugin/linux-amd64/vsphere-plugin.zip"
    data = urllib.request.urlopen(url, context=ctx, timeout=120).read()
    BIN.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in ("kubectl", "kubectl-vsphere"):
                target = BIN / base
                target.write_bytes(z.read(name))
                target.chmod(0o755)
    missing = [b for b in ("kubectl", "kubectl-vsphere") if not (BIN / b).exists()]
    if missing:
        raise RuntimeError(f"{url} did not contain {', '.join(missing)}")


def run(args, cfg, use_kubeconfig=True, check=True, stdin=None):
    env = dict(os.environ)
    env["PATH"] = f"{BIN}:{env.get('PATH', '')}"
    env["HOME"] = str(WORK)
    env["KUBECTL_VSPHERE_PASSWORD"] = cfg["password"]
    if use_kubeconfig:
        env["KUBECONFIG"] = str(KUBECONFIG)
    else:
        # No kubeconfig: kubectl falls back to this pod's service account.
        env.pop("KUBECONFIG", None)
    return subprocess.run(args, env=env, check=check, capture_output=True, text=True, input=stdin)


def login(cfg, server, namespace=None, name=None):
    args = ["kubectl", "vsphere", "login", f"--server={server}", f"--vsphere-username={cfg['user']}", "--insecure-skip-tls-verify"]
    if name:
        args += ["--tanzu-kubernetes-cluster-namespace", namespace, "--tanzu-kubernetes-cluster-name", name]
    r = run(args, cfg, check=False)
    return r.returncode == 0, (r.stderr or r.stdout).strip()[:400]


def main():
    cfg = settings()
    if not cfg["supervisors"]:
        sys.exit("SUPERVISORS is empty.")
    if not cfg["user"] or not cfg["password"]:
        sys.exit("VSPHERE_USERNAME and VSPHERE_PASSWORD must be set (Secret vks-fleet-vsphere).")

    fetch_tools(cfg["supervisors"][0])
    signed_in = 0
    for sup in cfg["supervisors"]:
        ok, msg = login(cfg, sup)
        if not ok:
            log(f"Supervisor {sup}: sign-in failed: {msg}")
            continue
        signed_in += 1
        log(f"Supervisor {sup}: signed in")
        if cfg["clusters"] == "none":
            continue
        listing = run(
            ["kubectl", "--context", sup, "get", "clusters.cluster.x-k8s.io", "-A",
             "-o", "jsonpath={range .items[*]}{.metadata.namespace}{\" \"}{.metadata.name}{\"\\n\"}{end}"],
            cfg,
            check=False,
        )
        if listing.returncode:
            log(f"  listing clusters failed: {listing.stderr.strip()[:300]}")
            continue
        for ns, name in wanted_clusters(cfg["clusters"], listing.stdout):
            ok, msg = login(cfg, sup, ns, name)
            log(f"  {ns}/{name}: {'signed in' if ok else 'failed: ' + msg}")

    if not signed_in:
        sys.exit("No Supervisor sign-in succeeded; the existing kubeconfig was left in place.")

    manifest = run(
        ["kubectl", "create", "secret", "generic", cfg["secret"], f"--from-file=config={KUBECONFIG}",
         "-n", cfg["namespace"], "--dry-run=client", "-o", "yaml"],
        cfg,
        use_kubeconfig=False,
    ).stdout
    run(["kubectl", "apply", "-n", cfg["namespace"], "-f", "-"], cfg, use_kubeconfig=False, stdin=manifest)
    restart = run(["kubectl", "rollout", "restart", f"deployment/{cfg['deployment']}", "-n", cfg["namespace"]],
                  cfg, use_kubeconfig=False, check=False)
    log("Kubeconfig stored in Secret", cfg["secret"] + ";",
        "Headlamp restarted." if restart.returncode == 0 else f"restart failed: {restart.stderr.strip()[:200]}")


# ---------------- VCF Automation mode ----------------

def parse_vcfa_namespaces(spec):
    """'ns=urn[@project],…' → [(ns, urn, project)]."""
    out = []
    for item in [x.strip() for x in (spec or "").split(",") if x.strip()]:
        ns, _, rest = item.partition("=")
        urn, _, project = rest.partition("@")
        if ns and urn:
            out.append((ns.strip(), urn.strip(), (project or "default-project").strip()))
    return out


def vcfa_access_token(endpoint, tenant, api_token, insecure):
    """The VCF CLI's exchange: an API (refresh) token for a short-lived access token."""
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    body = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": api_token}).encode()
    req = urllib.request.Request(
        f"{endpoint.rstrip('/')}/tm/oauth/tenant/{urllib.parse.quote(tenant)}/token",
        data=body,
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
        data = json.loads(r.read().decode())
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"No access_token in the VCFA response (keys: {', '.join(data.keys())})")
    return token


def vcfa_kubeconfig(endpoint, label, namespaces, token, insecure, org_server=None):
    """A kubeconfig (JSON is valid YAML) with one context per namespace, like the VCF CLI writes."""
    clusters, contexts = [], []
    for ns, urn, project in namespaces:
        name = f"{label}:{ns}:{project}"
        cluster = {"server": f"{endpoint.rstrip('/')}/proxy/k8s/namespaces/{urn}"}
        if insecure:
            cluster["insecure-skip-tls-verify"] = True
        clusters.append({"name": name, "cluster": cluster})
        contexts.append({"name": name, "context": {"cluster": name, "user": f"{label}-user", "namespace": ns}})
    if org_server:
        cluster = {"server": org_server}
        if insecure:
            cluster["insecure-skip-tls-verify"] = True
        clusters.append({"name": label, "cluster": cluster})
        contexts.append({"name": label, "context": {"cluster": label, "user": f"{label}-user"}})
    return {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": clusters,
        "contexts": contexts,
        "users": [{"name": f"{label}-user", "user": {"token": token}}],
        "current-context": contexts[0]["name"] if contexts else "",
    }


def in_cluster_request(method, path, body=None, content_type="application/json"):
    """Talks to this cluster's API with the pod's service account (no kubectl needed)."""
    sa = pathlib.Path("/var/run/secrets/kubernetes.io/serviceaccount")
    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    ctx = ssl.create_default_context(cafile=str(sa / "ca.crt"))
    req = urllib.request.Request(
        f"https://{host}:{port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {(sa / 'token').read_text().strip()}", "Content-Type": content_type},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def store_kubeconfig_in_cluster(namespace, secret, deployment, kubeconfig_text):
    import base64
    obj = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {"name": secret, "namespace": namespace},
        "type": "Opaque",
        "data": {"config": base64.b64encode(kubeconfig_text.encode()).decode()},
    }
    status = in_cluster_request("PUT", f"/api/v1/namespaces/{namespace}/secrets/{secret}", obj)
    if status == 404:
        status = in_cluster_request("POST", f"/api/v1/namespaces/{namespace}/secrets", obj)
    if status not in (200, 201):
        raise RuntimeError(f"Writing Secret {secret} failed (HTTP {status})")
    import datetime
    patch = {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": datetime.datetime.utcnow().isoformat() + "Z"}}}}}
    status = in_cluster_request("PATCH", f"/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}", patch, "application/strategic-merge-patch+json")
    return status in (200, 201)


def vcfa_main():
    endpoint = os.environ.get("VCFA_ENDPOINT", "")
    tenant = os.environ.get("VCFA_TENANT", "")
    label = os.environ.get("VCFA_LABEL") or tenant
    api_token = os.environ.get("VCFA_API_TOKEN", "")
    insecure = os.environ.get("VCFA_INSECURE", "").lower() == "true"
    namespaces = parse_vcfa_namespaces(os.environ.get("VCFA_NAMESPACES", ""))
    if not (endpoint and tenant and api_token and namespaces):
        sys.exit("VCFA_ENDPOINT, VCFA_TENANT, VCFA_API_TOKEN and VCFA_NAMESPACES must be set.")
    token = vcfa_access_token(endpoint, tenant, api_token, insecure)
    log(f"VCF Automation: signed in to {tenant}")
    org_server = os.environ.get("VCFA_ORG_SERVER") or None
    kubeconfig = json.dumps(vcfa_kubeconfig(endpoint, label, namespaces, token, insecure, org_server), indent=2)
    if org_server:
        log(f"  context {label} (org level, for quotas)")
    for ns, _, project in namespaces:
        log(f"  context {label}:{ns}:{project}")
    cfg = settings()
    restarted = store_kubeconfig_in_cluster(cfg["namespace"], cfg["secret"], cfg["deployment"], kubeconfig)
    log("Kubeconfig stored in Secret", cfg["secret"] + ";", "Headlamp restarted." if restarted else "restart failed.")


if __name__ == "__main__":
    try:
        if os.environ.get("MODE", "supervisor").lower() == "vcfa":
            vcfa_main()
        else:
            main()
    except subprocess.CalledProcessError as e:
        sys.exit(f"Command failed: {' '.join(e.cmd[:4])}…: {(e.stderr or e.stdout or '').strip()[:400]}")
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from {e.url}: {e.read().decode(errors='replace')[:300]}")
