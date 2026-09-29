"""
vks-fleet vCenter collector.

Reads the Supervisor's own view from vCenter with a read-only account and
writes it into a ConfigMap the plugin reads through the normal Kubernetes
connection (the browser never talks to vCenter or holds its credentials):

  - each Supervisor's config and Kubernetes status, with vCenter's messages
    (the Workload Management view);
  - its control-plane VMs (power state and size);
  - its Supervisor Services (version and state);
  - the ESXi hosts of its cluster (connection, power);
  - optionally, triggered alarms on the cluster, its hosts and the
    control-plane VMs (needs the pyvmomi library; skipped without it);
  - optionally (pyvmomi too), utilisation of the control-plane VMs and hosts:
    CPU, memory, disk and network from vCenter's performance counters, and
    the control-plane VM's guest disks (VMware Tools), with a rolling 24-hour
    history kept in the ConfigMap itself;
  - optionally (pyvmomi too), placement: which ESXi host each VM in the
    Supervisor's cluster runs on (VM Operator doesn't always report it).

Standard library only for the REST part. Runs as a CronJob every few minutes
(deploy/collector.yaml) or from a jump server's timer.

Environment:
  VCENTER               vCenter address, e.g. vc-wld01-a.site-a.vcf.lab
  VCENTER_USERNAME      a read-only account
  VCENTER_PASSWORD      its password (or VCENTER_PASSWORD_FILE)
  VCENTER_INSECURE      "true" to skip TLS verification (lab certificates)
  OUTPUT_NAMESPACE      where the ConfigMap goes (default: this pod's namespace, else vks-fleet)
  OUTPUT_CONFIGMAP      its name (default vks-fleet-vcenter)
  KUBE_CONTEXT          outside a cluster: kubectl context to write it with (else printed)
  ALARMS                "false" to skip alarms even when pyvmomi is available
"""
import base64
import datetime
import json
import os
import pathlib
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

CP_VM_PREFIX = "SupervisorControlPlaneVM"


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def iso(t):
    return t.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class VCenter:
    """A minimal vCenter REST client (vSphere Automation API)."""

    def __init__(self, host, username, password, insecure=False):
        self.base = f"https://{host}"
        self.username = username
        self.password = password
        self.token = None
        self.ctx = ssl.create_default_context()
        if insecure:
            self.ctx.check_hostname = False
            self.ctx.verify_mode = ssl.CERT_NONE

    def request(self, method, path):
        req = urllib.request.Request(self.base + path, method=method)
        req.add_header("Accept", "application/json")
        if self.token:
            req.add_header("vmware-api-session-id", self.token)
        else:
            basic = base64.b64encode(f"{self.username}:{self.password}".encode()).decode()
            req.add_header("Authorization", f"Basic {basic}")
        with urllib.request.urlopen(req, context=self.ctx, timeout=30) as resp:
            body = resp.read()
            return json.loads(body) if body else None

    def login(self):
        self.token = self.request("POST", "/api/session")

    def logout(self):
        try:
            self.request("DELETE", "/api/session")
        except Exception:
            pass

    def get(self, path):
        """GET, with None for "not found" (an API this vCenter doesn't have)."""
        try:
            return self.request("GET", path)
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return None
            raise


def _messages(*lists):
    out = []
    for items in lists:
        for m in items or []:
            text = (m.get("details") or {}).get("default_message") or m.get("message") or ""
            if text:
                out.append({"severity": str(m.get("severity") or "INFO").upper(), "text": text[:400]})
    return out


def parse_supervisor(summary, detail, hosts, services, vms):
    """One Supervisor's record, from vCenter's (differently shaped, version-dependent) answers."""
    detail = detail or {}
    endpoints = [e for e in [detail.get("api_server_management_endpoint")] + list(detail.get("api_servers") or []) if e]
    return {
        "id": summary.get("cluster") or summary.get("supervisor"),
        "name": summary.get("cluster_name") or detail.get("name") or summary.get("cluster"),
        "configStatus": str(detail.get("config_status") or summary.get("config_status") or "UNKNOWN").upper(),
        "kubernetesStatus": str(detail.get("kubernetes_status") or summary.get("kubernetes_status") or "UNKNOWN").upper(),
        "messages": _messages(detail.get("messages"), detail.get("kubernetes_status_messages")),
        "apiEndpoints": endpoints,
        "controlPlaneVMs": [
            {"name": v.get("name"), "power": v.get("power_state"), "cpus": v.get("cpu_count"), "memoryMiB": v.get("memory_size_MiB")}
            for v in vms or []
            if str(v.get("name", "")).startswith(CP_VM_PREFIX)
        ],
        "hosts": [{"name": h.get("name"), "connection": h.get("connection_state"), "power": h.get("power_state")} for h in hosts or []],
        "services": [
            {
                "id": s.get("supervisor_service"),
                "version": s.get("current_version") or s.get("desired_version"),
                "state": str(s.get("config_status") or s.get("state") or "UNKNOWN").upper(),
                "messages": _messages(s.get("messages")),
            }
            for s in services or []
        ],
        "alarms": [],
    }


def collect(vc, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    out = {"collectedAt": iso(now), "vcenter": vc.base.replace("https://", ""), "supervisors": [], "errors": []}
    clusters = vc.get("/api/vcenter/namespace-management/clusters") or []
    for c in clusters:
        cid = c.get("cluster")
        q = urllib.parse.quote(str(cid))
        try:
            detail = vc.get(f"/api/vcenter/namespace-management/clusters/{q}")
            hosts = vc.get(f"/api/vcenter/host?clusters={q}")
            services = vc.get(f"/api/vcenter/namespace-management/clusters/{q}/supervisor-services")
            vms = vc.get(f"/api/vcenter/vm?clusters={q}")
            out["supervisors"].append(parse_supervisor(c, detail, hosts, services, vms))
        except Exception as err:  # one Supervisor failing doesn't lose the others
            out["errors"].append(f"{cid}: {err}")
    return out


def add_alarms(status, host, username, password, insecure, existing_history=None, now=None):
    """Triggered alarms and utilisation via pyvmomi (not available over REST). Quietly skipped without it."""
    if os.environ.get("ALARMS", "").lower() == "false":
        return
    try:
        from pyVim.connect import Disconnect, SmartConnect  # type: ignore
        from pyVmomi import vim  # type: ignore
    except ImportError:
        status.setdefault("notes", []).append("Alarms and utilisation not collected (pyvmomi not installed).")
        return
    kwargs = {"host": host, "user": username, "pwd": password}
    if insecure:
        kwargs["disableSslCertValidation"] = True
    si = SmartConnect(**kwargs)
    try:
        try:
            add_metrics(status, si, vim, existing_history, now or datetime.datetime.now(datetime.timezone.utc))
        except Exception as err:
            status["errors"].append(f"metrics: {err}")
        try:
            add_placement(status, si, vim)
        except Exception as err:
            status["errors"].append(f"placement: {err}")
        content = si.RetrieveContent()
        for sup in status["supervisors"]:
            view = content.viewManager.CreateContainerView(content.rootFolder, [vim.ClusterComputeResource], True)
            cluster = next((x for x in view.view if x._moId == sup["id"]), None)
            view.Destroy()
            if not cluster:
                continue
            # Control-plane VMs can sit in nested resource pools: search the whole cluster.
            vm_view = content.viewManager.CreateContainerView(cluster, [vim.VirtualMachine], True)
            cp_vms = [vm for vm in vm_view.view if vm.name.startswith(CP_VM_PREFIX)]
            vm_view.Destroy()
            entities = [cluster] + list(cluster.host) + cp_vms
            for e in entities:
                for a in e.triggeredAlarmState or []:
                    sup["alarms"].append(
                        {"entity": e.name, "name": a.alarm.info.name, "status": str(a.overallStatus), "time": iso(a.time), "acknowledged": bool(a.acknowledged)}
                    )
    finally:
        Disconnect(si)


HISTORY_HOURS = 24
METRIC_COUNTERS = {"cpuPct": "cpu.usage.average", "memPct": "mem.usage.average", "diskKBps": "disk.usage.average", "netKBps": "net.usage.average"}


def _counter_ids(perf_manager):
    ids = {}
    for c in perf_manager.perfCounter:
        name = f"{c.groupInfo.key}.{c.nameInfo.key}.{c.rollupType}"
        for key, wanted in METRIC_COUNTERS.items():
            if name == wanted:
                ids[key] = c.key
    return ids


def _sample(perf_manager, ids, entity, vim, samples=15):
    """The average of the latest real-time samples (20 s each) for each metric."""
    metric_ids = [vim.PerformanceManager.MetricId(counterId=cid, instance="") for cid in ids.values()]
    spec = vim.PerformanceManager.QuerySpec(entity=entity, metricId=metric_ids, intervalId=20, maxSample=samples)
    out = {}
    for result in perf_manager.QueryPerf(querySpec=[spec]) or []:
        for series in result.value:
            key = next((k for k, cid in ids.items() if cid == series.id.counterId), None)
            vals = [v for v in series.value if v is not None and v >= 0]
            if key and vals:
                avg = sum(vals) / len(vals)
                out[key] = round(avg / 100, 1) if key.endswith("Pct") else round(avg)
    return out


def _guest_disks(vm):
    disks = []
    for d in getattr(vm.guest, "disk", None) or []:
        if d.capacity:
            disks.append({"path": d.diskPath, "capacityBytes": int(d.capacity), "freeBytes": int(d.freeSpace or 0)})
    return disks


def merge_history(existing, entities, now, hours=HISTORY_HOURS):
    """Append this run's sample to the rolling history and drop what's older than the window."""
    cutoff = (now - datetime.timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    history = [h for h in (existing or []) if h.get("t", "") >= cutoff]
    sample = {"t": iso(now), "v": {}}
    for e in entities:
        worst = max((100 * (1 - d["freeBytes"] / d["capacityBytes"]) for d in e.get("disks", []) if d["capacityBytes"]), default=None)
        sample["v"][e["name"]] = [e.get("cpuPct"), e.get("memPct"), e.get("diskKBps"), e.get("netKBps"), round(worst, 1) if worst is not None else None]
    history.append(sample)
    return history


def add_metrics(status, si, vim, existing_history, now):
    """Utilisation of the control-plane VMs and hosts (pyvmomi); the previous history is carried forward."""
    content = si.RetrieveContent()
    pm = content.perfManager
    ids = _counter_ids(pm)
    entities = []
    for sup in status["supervisors"]:
        view = content.viewManager.CreateContainerView(content.rootFolder, [vim.ClusterComputeResource], True)
        cluster = next((x for x in view.view if x._moId == sup["id"]), None)
        view.Destroy()
        if not cluster:
            continue
        vm_view = content.viewManager.CreateContainerView(cluster, [vim.VirtualMachine], True)
        cp_vms = [vm for vm in vm_view.view if vm.name.startswith(CP_VM_PREFIX)]
        vm_view.Destroy()
        for vm in cp_vms:
            e = {"kind": "vm", "name": vm.name, "supervisor": sup["id"], "disks": _guest_disks(vm)}
            e.update(_sample(pm, ids, vm, vim))
            entities.append(e)
        for h in cluster.host:
            e = {"kind": "host", "name": h.name, "supervisor": sup["id"]}
            e.update(_sample(pm, ids, h, vim))
            entities.append(e)
    status["metrics"] = {"sampledAt": iso(now), "entities": entities, "history": merge_history(existing_history, entities, now)}


def placement_of(vms, host_names):
    """VM name → host, from (name, host moId, power) triples; hosts outside the cluster are dropped."""
    out = []
    for name, host_id, power in vms:
        host = host_names.get(host_id)
        if host:
            out.append({"name": name, "host": host, "power": power})
    return sorted(out, key=lambda x: x["name"])


def add_placement(status, si, vim):
    """Which host each VM in each Supervisor's cluster runs on."""
    content = si.RetrieveContent()
    entries = []
    for sup in status["supervisors"]:
        view = content.viewManager.CreateContainerView(content.rootFolder, [vim.ClusterComputeResource], True)
        cluster = next((x for x in view.view if x._moId == sup["id"]), None)
        view.Destroy()
        if not cluster:
            continue
        host_names = {h._moId: h.name for h in cluster.host}
        vm_view = content.viewManager.CreateContainerView(cluster, [vim.VirtualMachine], True)
        triples = []
        for vm in vm_view.view:
            try:
                rt = vm.runtime
                triples.append((vm.name, rt.host._moId if rt.host else None, str(rt.powerState)))
            except Exception:
                continue
        vm_view.Destroy()
        for e in placement_of(triples, host_names):
            e["supervisor"] = sup["id"]
            entries.append(e)
    status["placement"] = {"vms": entries}


def read_existing(namespace, name):
    """The ConfigMap as it is now (for the rolling history); None when there isn't one."""
    try:
        if os.environ.get("KUBERNETES_SERVICE_HOST"):
            cm = in_cluster_request("GET", f"/api/v1/namespaces/{namespace}/configmaps/{name}")
        elif os.environ.get("KUBE_CONTEXT"):
            out = subprocess.run(["kubectl", "--context", os.environ["KUBE_CONTEXT"], "-n", namespace, "get", "configmap", name, "-o", "json"], capture_output=True, check=True)
            cm = json.loads(out.stdout)
        else:
            return None
        return json.loads(cm["data"]["status.json"])
    except Exception:
        return None


def configmap(status, name):
    return {
        "apiVersion": "v1",
        "kind": "ConfigMap",
        "metadata": {"name": name, "labels": {"app.kubernetes.io/part-of": "vks-fleet", "app.kubernetes.io/name": "vks-fleet-vcenter"}},
        "data": {"status.json": json.dumps(status, separators=(",", ":"))},
    }


def in_cluster_request(method, path, body=None, content_type="application/json"):
    sa = pathlib.Path("/var/run/secrets/kubernetes.io/serviceaccount")
    token = (sa / "token").read_text()
    host = os.environ["KUBERNETES_SERVICE_HOST"]
    port = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
    ctx = ssl.create_default_context(cafile=str(sa / "ca.crt"))
    req = urllib.request.Request(f"https://{host}:{port}{path}", method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", content_type)
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def write(cm, namespace):
    if os.environ.get("KUBERNETES_SERVICE_HOST"):
        base = f"/api/v1/namespaces/{namespace}/configmaps"
        try:
            in_cluster_request("PUT", f"{base}/{cm['metadata']['name']}", cm)
        except urllib.error.HTTPError as err:
            if err.code != 404:
                raise
            in_cluster_request("POST", base, cm)
        log(f"wrote {namespace}/{cm['metadata']['name']}")
    elif os.environ.get("KUBE_CONTEXT"):
        subprocess.run(
            ["kubectl", "--context", os.environ["KUBE_CONTEXT"], "-n", namespace, "apply", "-f", "-"],
            input=json.dumps(cm).encode(),
            check=True,
            stdout=subprocess.DEVNULL,
        )
        log(f"wrote {namespace}/{cm['metadata']['name']} via {os.environ['KUBE_CONTEXT']}")
    else:
        print(json.dumps(cm, indent=2))


def main():
    host = os.environ["VCENTER"]
    user = os.environ["VCENTER_USERNAME"]
    password = os.environ.get("VCENTER_PASSWORD") or pathlib.Path(os.environ["VCENTER_PASSWORD_FILE"]).read_text().strip()
    insecure = os.environ.get("VCENTER_INSECURE", "").lower() == "true"
    namespace = os.environ.get("OUTPUT_NAMESPACE") or os.environ.get("POD_NAMESPACE") or "vks-fleet"
    vc = VCenter(host, user, password, insecure)
    vc.login()
    try:
        status = collect(vc)
    finally:
        vc.logout()
    name = os.environ.get("OUTPUT_CONFIGMAP", "vks-fleet-vcenter")
    existing = read_existing(namespace, name)
    try:
        add_alarms(status, host, user, password, insecure, (existing or {}).get("metrics", {}).get("history"))
    except Exception as err:
        status["errors"].append(f"alarms: {err}")
    write(configmap(status, name), namespace)
    log(f"{len(status['supervisors'])} Supervisor(s), {len(status['errors'])} error(s)")


if __name__ == "__main__":
    main()
