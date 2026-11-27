"""Bench for the permanent-node drain: fake DB (slot_busy) and fake ssh. Run: python3 deploy/cloud-node/test_node_pool.py

@covers WORKTREE-STD-12 (BundleNeverStays)
"""
import base64, importlib.machinery, importlib.util, os, shutil, tempfile, unittest

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
        self.queued = 0
        np.slot_busy = lambda m, running_only=False: self.busy + (0 if running_only else self.queued)
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

    def test_draining_says_until_when(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S)
        self.assertEqual(self.sl["drain_until"], 1000 + np.BEHIND_S + np.DRAIN_MAX_S)

    def test_a_later_success_clears_an_old_failure(self):
        self.sl["align_failed"] = "older"
        self.run_at(1000)
        self.run_at(1000 + np.BEHIND_S)
        self.busy = 0
        self.run_at(1000 + np.BEHIND_S + 60)
        self.assertEqual(self.sl["aligned"], "new")
        self.assertNotIn("align_failed", self.sl)

    def test_already_aligned_forgets_the_failure_of_an_older_commit(self):
        self.sl.update({"aligned": "new", "align_failed": "older"})
        self.run_at(1000)
        self.assertNotIn("align_failed", self.sl)

    def test_d_under_threshold_no_drain(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S - 1)
        self.assertEqual(self.patches, [])
        self.assertFalse(self.sl.get("draining"))
        self.assertEqual(self.restarts(), [])

    def test_e_moving_commit_does_not_reset_the_clock(self):
        for i in range(6):
            self.run_at(1000 + i * 600, c=f"c{i}")
        self.run_at(1000 + np.BEHIND_S, c="c6")
        self.assertEqual(self.patches, [0])
        self.assertTrue(self.sl["draining"])

    def test_f_draining_ignores_queued_cards(self):
        self.run_at(1000); self.run_at(1000 + np.BEHIND_S)
        self.busy, self.queued = 0, 2
        self.run_at(1000 + np.BEHIND_S + 60)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual(self.patches, [0, 4])

    def test_drain_cap_gives_up(self):
        self.run_at(1000); t = 1000 + np.BEHIND_S; self.run_at(t)
        self.run_at(t + np.DRAIN_MAX_S)
        self.assertEqual(self.patches, [0, 4])
        self.assertEqual(self.restarts(), [])


class DrainIgnoresCardsWithoutATurn(unittest.TestCase):
    """A card waiting on a human answer or a condition has no turn in flight: it must not hold the drain."""
    def count(self, state):
        import sqlite3
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, "t.db")
        db = sqlite3.connect(path)
        db.execute("create table tasks (machine_id text, status text, dispatch_state text)")
        db.execute("insert into tasks values ('m1', 'in_progress', ?)", (state,))
        db.commit(); db.close()
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("node_pool_db", importlib.machinery.SourceFileLoader("node_pool_db", os.path.join(HERE, "node-pool"))))
        mod.__spec__.loader.exec_module(mod)
        mod.MAC_DB = path
        return mod.slot_busy("m1", running_only=True)

    def test_needs_input_card_does_not_count(self): self.assertEqual(self.count("needs_input"), 0)

    def test_waiting_card_does_not_count(self): self.assertEqual(self.count("waiting"), 0)

    def test_running_card_counts(self): self.assertEqual(self.count("running"), 1)


class DeleteForgetsMachine(unittest.TestCase):
    """A deleted hourly server leaves no «Nodo cloud N» row behind; the permanent node keeps its own."""
    def setUp(self):
        self.calls = []
        np.mac = lambda method, path, body=None, timeout=30: self.calls.append((method, path)) or {}
        np.hz = lambda *a, **k: {}
        np.ssh = lambda *a, **k: R(0)
        np.close_tunnel = lambda sl: None
        np.save_state = lambda s: None
        self._run = np.subprocess.run
        np.subprocess.run = lambda *a, **k: R(0)

    def tearDown(self):
        np.subprocess.run = self._run

    def state(self, **slot):
        return {"slots": {"2": {"n": 2, **slot}}, "lives": []}

    def test_hourly_server_row_is_deleted(self):
        s = self.state(server_id=7, machine_id="m2", ip="1.2.3.4", name="x")
        np.delete(s, 2, "fine dell'ora")
        self.assertIn(("DELETE", "/api/machines/m2"), self.calls)
        self.assertEqual(s["slots"]["2"], {"n": 2})

    def test_permanent_node_row_is_kept(self):
        s = self.state(server_id=7, machine_id="m2", fixed=True)
        np.delete(s, 2, "staccato")
        self.assertEqual(self.calls, [])
        self.assertEqual(s["slots"]["2"]["machine_id"], "m2")

    def test_a_refused_delete_does_not_break_the_close(self):
        def refuse(*a, **k): raise OSError("409")
        np.mac = refuse
        s = self.state(server_id=7, machine_id="m2")
        np.delete(s, 2, "fine dell'ora")
        self.assertEqual(s["slots"]["2"], {"n": 2})


class SyncRepoIdentity(unittest.TestCase):
    """The clone the node makes for a run signs commits with the Mac checkout's identity, read by
    the dispatcher and carried in the hook payload (`git_author_name`/`git_author_email`), never one
    of the node's own: a foreign author is exactly what the land (LAND-13) refuses.

    @covers LAND-13
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        np.ST = self.tmp
        self.ssh_scripts = []
        np.ssh = lambda ip, cmd, timeout=120, inp=None: (self.ssh_scripts.append(cmd), R(0))[1]
        self.subprocess_calls = []

        def fake_run(args, **kwargs):
            self.subprocess_calls.append(args)
            if "bundle" in args and "create" in args:
                open(args[args.index("create") + 1], "wb").close()

            class Done:
                returncode = 0
                stdout = "refs/remotes/origin/main"
                stderr = ""
            return Done()

        np.subprocess.run = fake_run

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_node_clone_gets_the_checkout_identity_as_local_config(self):
        sl = {"ip": "1.2.3.4", "server_id": "s1", "n": 1}
        np.sync_repo(sl, "https://github.com/acme/alpha", "/Users/me/alpha", "Ada Lovelace", "ada@example.test")

        self.assertEqual(len(self.ssh_scripts), 1)
        script = self.ssh_scripts[0]
        self.assertIn('git -C $d config user.name "$(echo ', script)
        self.assertIn('git -C $d config user.email "$(echo ', script)
        self.assertEqual(base64.b64encode(b"Ada Lovelace").decode(), self.name64_in(script))
        self.assertEqual(base64.b64encode(b"ada@example.test").decode(), self.email64_in(script))

    def name64_in(self, script):
        return script.split('git -C $d config user.name "$(echo ')[1].split(" |")[0]

    def email64_in(self, script):
        return script.split('git -C $d config user.email "$(echo ')[1].split(" |")[0]


class BundleNeverStays(unittest.TestCase):
    """The local bundle of sync_repo goes even when scp fails, and the ones a dead run left are swept."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        np.ST = self.tmp
        np.known_file = lambda ip: os.path.join(self.tmp, "known")
        self.saved_run = np.subprocess.run

    def tearDown(self):
        np.subprocess.run = self.saved_run
        shutil.rmtree(self.tmp, ignore_errors=True)

    def bundles(self):
        return sorted(f for f in os.listdir(self.tmp) if f.endswith(".bundle"))

    def test_a_failed_scp_leaves_no_bundle(self):
        def fake_run(args, **kwargs):
            if "bundle" in args and "create" in args:
                open(args[args.index("create") + 1], "wb").close()
            if args[0] == "scp":
                raise np.subprocess.CalledProcessError(1, args)

            class Done:
                returncode = 0
                stdout = "refs/remotes/origin/main"
                stderr = ""
            return Done()

        np.subprocess.run = fake_run
        sl = {"ip": "1.2.3.4", "server_id": "s1", "n": 1}
        with self.assertRaises(np.subprocess.CalledProcessError):
            np.sync_repo(sl, "https://example.test/acme/alpha", "/repo/alpha", "A", "a@example.test")
        self.assertEqual(self.bundles(), [])

    def test_sweep_removes_dead_and_old_keeps_live(self):
        dead = os.path.join(self.tmp, "alpha-999999999.bundle")
        live = os.path.join(self.tmp, f"beta-{os.getppid()}.bundle")
        old_live = os.path.join(self.tmp, f"gamma-{os.getppid()}.bundle")
        other = os.path.join(self.tmp, "state.json")
        for f in (dead, live, old_live, other):
            open(f, "wb").close()
        now = os.path.getmtime(live)
        os.utime(old_live, (now - np.STALE_BUNDLE_S - 1, now - np.STALE_BUNDLE_S - 1))
        removed = np.sweep_stale_bundles(now=now)
        self.assertEqual(sorted(removed), ["alpha-999999999.bundle", f"gamma-{os.getppid()}.bundle"])
        self.assertEqual(self.bundles(), [f"beta-{os.getppid()}.bundle"])
        self.assertTrue(os.path.exists(other))


if __name__ == "__main__":
    unittest.main()
