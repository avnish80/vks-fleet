#!/usr/bin/env python3
"""
Checks that every pod in the given manifests meets Kubernetes' "restricted" Pod Security
level, which VKS enforces on unlabelled namespaces. Exits non-zero with a list of problems.

  python3 scripts/check-restricted.py rendered.yaml [more.yaml ...]

Covers what the restricted level requires: runAsNonRoot, a RuntimeDefault (or Localhost)
seccomp profile, no privilege escalation, all capabilities dropped (only NET_BIND_SERVICE
may be added), not privileged, and no host namespaces or hostPath volumes.
"""
import sys

import yaml


def pod_specs(doc):
    kind = doc.get("kind")
    spec = doc.get("spec") or {}
    if kind == "Pod":
        return [spec]
    if kind in ("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job"):
        return [(spec.get("template") or {}).get("spec") or {}]
    if kind == "CronJob":
        return [((((spec.get("jobTemplate") or {}).get("spec") or {}).get("template") or {}).get("spec")) or {}]
    return []


def problems(doc):
    name = f"{doc.get('kind')}/{(doc.get('metadata') or {}).get('name')}"
    out = []
    for pod in pod_specs(doc):
        psc = pod.get("securityContext") or {}
        for host in ("hostNetwork", "hostPID", "hostIPC"):
            if pod.get(host):
                out.append(f"{name}: {host} is set")
        for v in pod.get("volumes") or []:
            if "hostPath" in v:
                out.append(f"{name}: hostPath volume {v.get('name')}")
        for c in (pod.get("initContainers") or []) + (pod.get("containers") or []):
            csc = c.get("securityContext") or {}
            where = f"{name} container {c.get('name')}"
            non_root = csc.get("runAsNonRoot", psc.get("runAsNonRoot"))
            if non_root is not True:
                out.append(f"{where}: runAsNonRoot must be true (pod or container)")
            seccomp = (csc.get("seccompProfile") or psc.get("seccompProfile") or {}).get("type")
            if seccomp not in ("RuntimeDefault", "Localhost"):
                out.append(f"{where}: seccompProfile must be RuntimeDefault (pod or container)")
            if csc.get("allowPrivilegeEscalation") is not False:
                out.append(f"{where}: allowPrivilegeEscalation must be false")
            caps = csc.get("capabilities") or {}
            if "ALL" not in (caps.get("drop") or []):
                out.append(f"{where}: capabilities must drop ALL")
            if [a for a in caps.get("add") or [] if a != "NET_BIND_SERVICE"]:
                out.append(f"{where}: only NET_BIND_SERVICE may be added")
            if csc.get("privileged"):
                out.append(f"{where}: privileged")
    return out


def main(paths):
    found, pods = [], 0
    for p in paths:
        with open(p) as f:
            for doc in yaml.safe_load_all(f):
                if not doc:
                    continue
                if pod_specs(doc):
                    pods += 1
                found += problems(doc)
    for line in found:
        print("restricted:", line)
    print(f"{pods} pod template(s) checked, {len(found)} problem(s)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
