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
