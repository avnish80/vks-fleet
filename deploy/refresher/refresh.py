"""
vks-fleet sign-in refresher.

Signs in to each Supervisor (and every VKS cluster the account can see) with
the vSphere plugin downloaded from the Supervisor itself, stores the resulting
kubeconfig as a Secret in this cluster, and restarts Headlamp to pick it up.
Standard library only; runs as a CronJob every few hours, inside the token
lifetime.

Environment:
  SUPERVISORS          Supervisor API addresses, space or comma separated
  CLUSTERS             all | none | ns/name,ns/name,...
  VSPHERE_USERNAME     account to sign in with
  VSPHERE_PASSWORD
  KUBECONFIG_SECRET    Secret to write (default vks-fleet-kubeconfig)
  HEADLAMP_DEPLOYMENT  Deployment to restart (default headlamp)
  POD_NAMESPACE        where both live
"""
import io
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
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


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit(f"Command failed: {' '.join(e.cmd[:4])}…: {(e.stderr or e.stdout or '').strip()[:400]}")
