"""Tests for the vCenter collector with a fake vCenter (python3 -m unittest discover -s deploy/collector)."""
import datetime
import json
import unittest
import urllib.error

import collect


class FakeVC(collect.VCenter):
    def __init__(self, answers):
        super().__init__("vc.lab", "ro@vsphere.local", "x", insecure=True)
        self.answers = answers
        self.asked = []

    def request(self, method, path):
        self.asked.append(path)
        if path not in self.answers:
            raise urllib.error.HTTPError(path, 404, "not found", {}, None)
        a = self.answers[path]
        if isinstance(a, Exception):
            raise a
        return a


ANSWERS = {
    "/api/vcenter/namespace-management/clusters": [
        {"cluster": "domain-c10", "cluster_name": "wld-cl01", "config_status": "RUNNING", "kubernetes_status": "WARNING"},
    ],
    "/api/vcenter/namespace-management/clusters/domain-c10": {
        "config_status": "RUNNING",
        "kubernetes_status": "WARNING",
        "api_server_management_endpoint": "10.150.4.2",
        "api_servers": ["10.150.4.2"],
        "messages": [],
        "kubernetes_status_messages": [{"severity": "WARNING", "details": {"default_message": "Control plane VM memory usage is high."}}],
    },
    "/api/vcenter/host?clusters=domain-c10": [
        {"name": "esx-05a.site-a.vcf.lab", "connection_state": "CONNECTED", "power_state": "POWERED_ON"},
        {"name": "esx-06a.site-a.vcf.lab", "connection_state": "DISCONNECTED", "power_state": "POWERED_ON"},
    ],
    "/api/vcenter/namespace-management/clusters/domain-c10/supervisor-services": [
        {"supervisor_service": "tkg.vsphere.vmware.com", "current_version": "3.7.0", "config_status": "CONFIGURED"},
        {"supervisor_service": "velero.vsphere.vmware.com", "desired_version": "1.6.2", "config_status": "ERROR", "messages": [{"severity": "ERROR", "details": {"default_message": "Install failed"}}]},
    ],
    "/api/vcenter/vm?clusters=domain-c10": [
        {"name": "SupervisorControlPlaneVM (1)", "power_state": "POWERED_ON", "cpu_count": 4, "memory_size_MiB": 16384},
        {"name": "web-vm-3", "power_state": "POWERED_ON"},
    ],
}


class CollectorTest(unittest.TestCase):
    def test_collects_one_supervisor(self):
        now = datetime.datetime(2026, 9, 28, 1, 0, tzinfo=datetime.timezone.utc)
        s = collect.collect(FakeVC(ANSWERS), now)
        self.assertEqual(s["collectedAt"], "2026-09-28T01:00:00Z")
        self.assertEqual(s["errors"], [])
        sup = s["supervisors"][0]
        self.assertEqual((sup["id"], sup["name"], sup["configStatus"], sup["kubernetesStatus"]), ("domain-c10", "wld-cl01", "RUNNING", "WARNING"))
        self.assertEqual(sup["apiEndpoints"], ["10.150.4.2", "10.150.4.2"])
        self.assertEqual(sup["messages"], [{"severity": "WARNING", "text": "Control plane VM memory usage is high."}])
        self.assertEqual([v["name"] for v in sup["controlPlaneVMs"]], ["SupervisorControlPlaneVM (1)"], "only control-plane VMs")
        self.assertEqual([h["connection"] for h in sup["hosts"]], ["CONNECTED", "DISCONNECTED"])
        self.assertEqual([(x["id"], x["version"], x["state"]) for x in sup["services"]], [("tkg.vsphere.vmware.com", "3.7.0", "CONFIGURED"), ("velero.vsphere.vmware.com", "1.6.2", "ERROR")])
        self.assertEqual(sup["services"][1]["messages"][0]["text"], "Install failed")

    def test_one_supervisor_failing_keeps_the_others(self):
        answers = dict(ANSWERS)
        answers["/api/vcenter/namespace-management/clusters"] = ANSWERS["/api/vcenter/namespace-management/clusters"] + [{"cluster": "domain-c20"}]
        answers["/api/vcenter/namespace-management/clusters/domain-c20"] = urllib.error.HTTPError("x", 500, "boom", {}, None)
        s = collect.collect(FakeVC(answers))
        self.assertEqual(len(s["supervisors"]), 1)
        self.assertTrue(s["errors"][0].startswith("domain-c20"))

    def test_older_or_missing_apis_are_not_errors(self):
        answers = {k: v for k, v in ANSWERS.items() if "supervisor-services" not in k}
        s = collect.collect(FakeVC(answers))
        self.assertEqual(s["supervisors"][0]["services"], [])
        self.assertEqual(s["errors"], [])

    def test_configmap(self):
        cm = collect.configmap({"collectedAt": "t", "supervisors": []}, "vks-fleet-vcenter")
        self.assertEqual(cm["metadata"]["name"], "vks-fleet-vcenter")
        self.assertEqual(json.loads(cm["data"]["status.json"])["collectedAt"], "t")


if __name__ == "__main__":
    unittest.main()


class HistoryTest(unittest.TestCase):
    def test_rolling_history_keeps_a_day(self):
        now = datetime.datetime(2026, 9, 28, 12, 0, tzinfo=datetime.timezone.utc)
        old = [{"t": "2026-09-27T11:00:00Z", "v": {}}, {"t": "2026-09-27T13:00:00Z", "v": {"cp": [10, 20, 5, 6, 40.0]}}]
        entities = [
            {"kind": "vm", "name": "cp", "cpuPct": 31.4, "memPct": 62.0, "diskKBps": 120, "netKBps": 80, "disks": [{"path": "/", "capacityBytes": 100, "freeBytes": 25}, {"path": "/var/lib/etcd", "capacityBytes": 100, "freeBytes": 70}]},
            {"kind": "host", "name": "esx-05a", "cpuPct": 44.0, "memPct": 71.5},
        ]
        h = collect.merge_history(old, entities, now)
        self.assertEqual([x["t"] for x in h], ["2026-09-27T13:00:00Z", "2026-09-28T12:00:00Z"], "older than 24 h dropped, newest appended")
        self.assertEqual(h[-1]["v"]["cp"], [31.4, 62.0, 120, 80, 75.0], "worst disk fullness is the last value")
        self.assertEqual(h[-1]["v"]["esx-05a"], [44.0, 71.5, None, None, None])


class PlacementTest(unittest.TestCase):
    def test_vm_to_host(self):
        hosts = {"host-11": "esx-05a.site-a.vcf.lab", "host-12": "esx-06a.site-a.vcf.lab"}
        triples = [("web-vm-3", "host-12", "poweredOn"), ("SupervisorControlPlaneVM (1)", "host-11", "poweredOn"), ("elsewhere", "host-99", "poweredOn"), ("template", None, "poweredOff")]
        self.assertEqual(
            collect.placement_of(triples, hosts),
            [{"name": "SupervisorControlPlaneVM (1)", "host": "esx-05a.site-a.vcf.lab", "power": "poweredOn"}, {"name": "web-vm-3", "host": "esx-06a.site-a.vcf.lab", "power": "poweredOn"}],
        )


class WriteErrorTest(unittest.TestCase):
    def test_missing_namespace_says_so(self):
        m = collect.write_error("platform-ops", "10.0.0.2", 'Error from server (NotFound): namespaces "platform-ops" not found\n')
        self.assertIn('namespaces "platform-ops" not found', m)
        self.assertIn("create it (for a Supervisor, a vSphere Namespace)", m)

    def test_forbidden_and_expired(self):
        self.assertIn("edit rights", collect.write_error("ns", "ctx", "Error from server (Forbidden): configmaps is forbidden: User x cannot create"))
        self.assertIn("sign-in has expired", collect.write_error("ns", "ctx", "error: You must be logged in to the server (Unauthorized)"))

    def test_a_failed_kubectl_apply_exits_with_one_line(self):
        import os
        import subprocess as sp
        from unittest import mock
        failed = sp.CompletedProcess(args=[], returncode=1, stdout=b"", stderr=b'Error from server (NotFound): namespaces "platform-ops" not found\n')
        with mock.patch.dict(os.environ, {"KUBE_CONTEXT": "10.0.0.2"}, clear=False), mock.patch.object(collect.subprocess, "run", return_value=failed):
            os.environ.pop("KUBERNETES_SERVICE_HOST", None)
            with self.assertRaises(SystemExit) as e:
                collect.write(collect.configmap({"supervisors": []}, "vks-fleet-vcenter"), "platform-ops")
        self.assertTrue(str(e.exception).startswith("Couldn't write the ConfigMap to platform-ops via 10.0.0.2"))


class TlsDefaultsTest(unittest.TestCase):
    """Certificates are verified unless a lab switch says otherwise; CA_FILE is used only if present."""

    def test_refresher_verifies_by_default(self):
        import importlib.util, os, ssl
        from unittest import mock
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("refresh", os.path.join(here, "..", "refresher", "refresh.py"))
        refresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refresh)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(refresh.tls_context(refresh.supervisor_insecure()).verify_mode, ssl.CERT_REQUIRED)
            self.assertIsNone(refresh.ca_file())
        with mock.patch.dict(os.environ, {"SUPERVISOR_INSECURE": "true", "CA_FILE": "/nonexistent/ca.crt"}, clear=True):
            self.assertEqual(refresh.tls_context(refresh.supervisor_insecure()).verify_mode, ssl.CERT_NONE)
            self.assertIsNone(refresh.ca_file(), "a missing optional Secret is ignored")

    def test_collector_ignores_a_missing_ca(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"CA_FILE": "/nonexistent/ca.crt"}, clear=True):
            self.assertIsNone(collect.ca_file())


class KubeconfigCaTest(unittest.TestCase):
    """The refresher embeds the CA where Headlamp would otherwise fail to verify (the v1.34.0 clean-install finding)."""

    def test_only_entries_without_a_ca_or_an_explicit_skip(self):
        import importlib.util, os
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("refresh", os.path.join(here, "..", "refresher", "refresh.py"))
        refresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refresh)
        view = {"clusters": [
            {"name": "10.0.0.2", "cluster": {"server": "https://10.0.0.2:443"}},
            {"name": "kubernetes-cluster-a1b2", "cluster": {"server": "https://10.0.1.1:6443", "certificate-authority-data": "LS0t"}},
            {"name": "lab", "cluster": {"server": "https://10.0.0.9", "insecure-skip-tls-verify": True}},
        ]}
        self.assertEqual(refresh.clusters_needing_ca(view), ["10.0.0.2"])


class RetryTest(unittest.TestCase):
    """A dropped connection is retried; a real refusal isn't."""

    def _write(self, results):
        import os
        import subprocess as sp
        from unittest import mock
        calls = iter(results)
        def run(*a, **k):
            code, err = next(calls)
            return sp.CompletedProcess(args=[], returncode=code, stdout=b"", stderr=err.encode())
        with mock.patch.dict(os.environ, {"KUBE_CONTEXT": "c"}, clear=True), mock.patch.object(collect.subprocess, "run", side_effect=run) as m, mock.patch.object(collect.time, "sleep"):
            try:
                collect.write(collect.configmap({"supervisors": []}, "vks-fleet-vcenter"), "vks-fleet")
                return m.call_count, None
            except SystemExit as e:
                return m.call_count, str(e)

    def test_a_dropped_connection_is_retried(self):
        lost = 'Patch "https://10.0.1.1:6443/…": http2: client connection lost'
        self.assertEqual(self._write([(1, lost), (0, "")]), (2, None))

    def test_a_refusal_fails_at_once(self):
        calls, err = self._write([(1, 'Error from server (NotFound): namespaces "x" not found')])
        self.assertEqual(calls, 1)
        self.assertIn("doesn't exist", err)

    def test_gives_up_after_the_retries(self):
        lost = "http2: client connection lost"
        calls, err = self._write([(1, lost)] * 3)
        self.assertEqual(calls, 3)
        self.assertIn("Couldn't write the ConfigMap", err)
