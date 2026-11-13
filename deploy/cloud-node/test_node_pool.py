"""Bench for the permanent-node drain: fake DB (slot_busy) and fake ssh. Run: python3 deploy/cloud-node/test_node_pool.py"""
import importlib.machinery, importlib.util, os, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ["NODE_POOL_LOG"] = "/tmp/node-pool-test.log"
loader = importlib.machinery.SourceFileLoader("node_pool", os.path.join(HERE, "node-pool"))
np = importlib.util.module_from_spec(importlib.util.spec_from_loader("node_pool", loader))
loader.exec_module(np)


class R:
    def __init__(self, rc): self.returncode = rc


class Drain(unittest.TestCase):
    def setUp(self):
        self.busy, self.ssh_rc, self.cmds, self.patches = 1, 0, [], []
        np.slot_busy = lambda m: self.busy
        np.ssh = lambda ip, cmd, timeout=120, inp=None: (self.cmds.append(cmd), R(self.ssh_rc))[1]
        np.mac = lambda method, path, body=None, timeout=30: self.patches.append(body["slots"])
        self.sl = {"machine_id": "m1", "aligned": "old", "slots": 4}

    def run_at(self, t, c="new"):
        np.align_permanent(self.sl, "1.2.3.4", "1", c, 0, now=t)

    def restarts(self): return [c for c in self.cmds if "systemctl restart" in c]

    def test_a_behind_and_busy_drains_without_restart(self):
        self.run_at(1000)
        self.run_at(1000 + np.BEHIND_S)
        self.assertEqual(self.patches, [0])
        self.assertTrue(self.sl["draining"])
        self.assertEqual(self.restarts(), [])

    def test_b_then_free_realigns_and_restores(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S)
        self.busy = 0
        self.run_at(1000 + np.BEHIND_S + 60)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual(self.sl["aligned"], "new")
        self.assertEqual(self.patches, [0, 4])
        self.assertFalse(self.sl["draining"])

    def test_c_failed_realign_restores_and_marks_failed(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S)
        self.busy, self.ssh_rc = 0, 1
        self.run_at(1000 + np.BEHIND_S + 60)
        self.assertEqual(self.patches, [0, 4])
        self.assertEqual(self.sl["align_failed"], "new")
        n = len(self.cmds)
        self.run_at(1000 + np.BEHIND_S + 120)
        self.assertEqual(len(self.cmds), n, "no retry on the same commit")

    def test_d_under_threshold_no_drain(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S - 1)
        self.assertEqual(self.patches, [])
        self.assertFalse(self.sl.get("draining"))
        self.assertEqual(self.restarts(), [])

    def test_drain_cap_gives_up(self):
        self.run_at(1000); t = 1000 + np.BEHIND_S; self.run_at(t)
        self.run_at(t + np.DRAIN_MAX_S)
        self.assertEqual(self.patches, [0, 4])
        self.assertEqual(self.restarts(), [])


if __name__ == "__main__":
    unittest.main()
