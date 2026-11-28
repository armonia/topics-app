"""Bench for the permanent-node drain: fake DB (slot_busy) and fake ssh. Run: python3 deploy/cloud-node/test_node_pool.py

@covers WORKTREE-STD-12 (BundleNeverStays)
"""
import base64, importlib.machinery, importlib.util, json, os, shutil, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
os.environ["NODE_POOL_LOG"] = "/tmp/node-pool-test.log"
loader = importlib.machinery.SourceFileLoader("node_pool", os.path.join(HERE, "node-pool"))
np = importlib.util.module_from_spec(importlib.util.spec_from_loader("node_pool", loader))
loader.exec_module(np)
# Other benches swap module functions and keep them: the uplink bench starts from the real ones
PRISTINE = dict(vars(np))


class R:
    def __init__(self, rc, out=""): self.returncode, self.stdout = rc, out


class Realign(unittest.TestCase):
    """The node never loses slots to a realign: it restarts at zero turns, or at once when lossless."""
    def setUp(self):
        self.busy, self.lossless, self.ssh_rc, self.cmds, self.patches = 1, False, 0, [], []
        np.slot_busy = lambda m, running_only=False: self.busy
        def fake_ssh(ip, cmd, timeout=120, inp=None):
            self.cmds.append(cmd)
            if "healthz" in cmd:
                return R(0, '{"losslessRestart":%s}' % ("true" if self.lossless else "false"))
            return R(self.ssh_rc)
        np.ssh = fake_ssh
        np.mac = lambda method, path, body=None, timeout=30: self.patches.append(body["slots"])
        self.sl = {"machine_id": "m1", "aligned": "old", "slots": 4}

    def run_at(self, t, c="new"):
        np.align_permanent(self.sl, "1.2.3.4", "1", c, 0, now=t)

    def restarts(self): return [c for c in self.cmds if "systemctl restart" in c]

    def test_busy_and_not_lossless_waits_without_touching_slots(self):
        for i in range(5):
            self.run_at(1000 + i * 3600)   # 4 h behind, under the cap
        self.assertEqual(self.patches, [])
        self.assertEqual(self.restarts(), [])

    def test_free_node_realigns(self):
        self.busy = 0
        self.run_at(1000)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual(self.sl["aligned"], "new")
        self.assertEqual(self.patches, [])

    def test_lossless_restarts_with_turns_in_flight(self):
        self.lossless = True
        self.run_at(1000)
        self.assertEqual(len(self.restarts()), 1)
        self.assertEqual(self.patches, [])

    def test_failed_realign_marks_failed_and_does_not_retry(self):
        self.busy, self.ssh_rc = 0, 1
        self.run_at(1000)
        self.assertEqual(self.sl["align_failed"], "new")
        n = len(self.cmds)
        self.run_at(1060)
        self.assertEqual(len(self.cmds), n, "no retry on the same commit")

    def test_old_drain_state_gives_the_slots_back(self):
        self.sl.update({"draining": True, "slots": 0})
        self.run_at(1000)
        self.assertEqual(len(self.patches), 1)
        self.assertGreater(self.patches[0], 0)
        self.assertFalse(self.sl["draining"])

    def test_a_later_success_clears_an_old_failure(self):
        self.sl["align_failed"] = "older"
        self.busy = 0
        self.run_at(1000)
        self.assertEqual(self.sl["aligned"], "new")
        self.assertNotIn("align_failed", self.sl)

    def test_already_aligned_forgets_the_failure_of_an_older_commit(self):
        self.sl.update({"aligned": "new", "align_failed": "older"})
        self.run_at(1000)
        self.assertNotIn("align_failed", self.sl)

    def test_continuous_queue_non_lossless_realigns_within_the_cap(self):
        """43 cards queued, 2 slots that never free together, main moving: new cards stop after the cap."""
        self.sl["slots"] = 2
        self.busy = 2
        realigned_at = None
        for i in range(0, 60):
            t = 1000 + i * 1800
            if t - 1000 >= np.BEHIND_S + 4 * 3600 and self.busy == 2:
                self.busy = 1   # a card ends
            if t - 1000 >= np.BEHIND_S + 6 * 3600:
                self.busy = 0
            self.run_at(t, c=f"c{i}")
            if self.restarts() and realigned_at is None:
                realigned_at = t - 1000
        self.assertIsNotNone(realigned_at, "never realigned")
        self.assertLessEqual(realigned_at, np.BEHIND_S + 7 * 3600)
        self.assertNotIn(0, self.patches)
        self.assertIn(1, self.patches)

    def test_main_moves_every_30_min_and_a_4h_card_never_zeroes_the_node(self):
        """Bar case: slots stay up through 8 h of a moving main and a card that runs 4 h."""
        zero_since, worst = None, 0
        for i in range(16):
            t = 1000 + i * 1800
            self.busy = 1 if i < 8 else 0   # the card ends after 4 h
            self.run_at(t, c=f"c{i}")
            zeroed = bool(self.patches) and self.patches[-1] == 0
            if zeroed:
                zero_since = zero_since or t
                worst = max(worst, t - zero_since)
            else:
                zero_since = None
        self.assertEqual(worst, 0)
        self.assertNotIn(0, self.patches)


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


class PermanentNodeGetsTheGovernor(unittest.TestCase):
    def test_all_three_files_are_copied(self):
        calls = []
        real = np.subprocess.run
        np.subprocess.run = lambda cmd, **kw: calls.append(cmd)
        try:
            np.push_permanent_files("1.2.3.4", "/dev/null")
        finally:
            np.subprocess.run = real
        dests = [c[-1] for c in calls]
        for f in ("ci-runners.sh", "ci-governor.py", "ci-governor.service"):
            self.assertIn(f"root@1.2.3.4:/root/{f}", dests)
            self.assertTrue(os.path.exists(os.path.join(HERE, "..", "permanent-node", f)))


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
        return {"slots": {"2": {"n": 2, **slot}}}

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


class LoadedThroughASymlink(unittest.TestCase):
    """The launchd copy is a symlink to the repo file: HERE must resolve to the repo, not to the link's folder."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_repo_paths_resolve_through_a_symlink(self):
        link = os.path.join(self.tmp, "node-pool")
        os.symlink(os.path.join(HERE, "node-pool"), link)
        loader = importlib.machinery.SourceFileLoader("node_pool_link", link)
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("node_pool_link", loader))
        loader.exec_module(mod)
        self.assertTrue(os.path.isdir(os.path.join(mod.HERE, "..", "permanent-node")), mod.HERE)
        self.assertTrue(os.path.exists(mod.STRUMENTI), mod.STRUMENTI)


class NoLock:
    def __init__(self, name): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass


class Role(unittest.TestCase):
    """Who is the primary, read from the files the server writes: only the primary manages the pool."""
    def setUp(self):
        import sqlite3
        self.tmp = tempfile.mkdtemp()
        self.saved = (np.APP_DATA, np.MAC_DB)
        np.APP_DATA, np.MAC_DB = self.tmp, os.path.join(self.tmp, "topics.db")
        self.db = sqlite3.connect(np.MAC_DB)
        self.db.execute("create table primary_state (id integer primary key, channel_device_id text, channel_machine_id text)")
        self.db.execute("insert into primary_state (id) values (1)")
        # the shape the primary switch leaves behind: the new primary is a paired row with a base_url,
        # and the rows of this computer carry hostnames that are not its current one
        self.db.execute("create table machines (id text, hostname text, base_url text)")
        self.db.execute("insert into machines values ('here', 'old-name', 'http://127.0.0.1:3401'), ('node', 'other', null)")
        self.db.commit()
        self.write("primary-local-id.json", '{"machineId": "here"}')

    def tearDown(self):
        self.db.close()
        np.APP_DATA, np.MAC_DB = self.saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name, body):
        with open(os.path.join(self.tmp, name), "w") as f:
            f.write(body)

    def channel(self, machine_id):
        self.db.execute("update primary_state set channel_machine_id=? where id=1", (machine_id,))
        self.db.commit()

    def test_never_chosen_without_a_channel_is_primary(self):
        self.assertEqual(np.local_role(), "primary")
        self.write("primary-state.json", '{"primaryMachineId": null, "epoch": 0}')
        self.assertEqual(np.local_role(), "primary")

    def test_never_chosen_with_a_channel_to_a_primary_is_secondary(self):
        # a server paired to a primary before any switch: an empty registry here would reap the primary's pool
        self.channel("node")
        self.assertEqual(np.local_role(), "secondary")
        self.write("primary-state.json", '{"primaryMachineId": null, "epoch": 0}')
        self.assertEqual(np.local_role(), "secondary")

    def test_db_without_roles_yet_is_the_sole_primary(self):
        self.db.execute("drop table primary_state")
        self.db.commit()
        self.assertEqual(np.local_role(), "primary")

    def test_unreadable_db_is_unknown(self):
        np.MAC_DB = os.path.join(self.tmp, "missing", "topics.db")
        self.assertEqual(np.local_role(), "unknown")

    def test_chosen_elsewhere_is_secondary_and_here_is_primary(self):
        self.write("primary-state.json", '{"primaryMachineId": "node", "epoch": 2}')
        self.assertEqual(np.local_role(), "secondary")
        self.write("primary-state.json", '{"primaryMachineId": "here", "epoch": 3}')
        self.assertEqual(np.local_role(), "primary")

    def test_the_id_comes_from_the_server_not_from_the_hostname(self):
        self.write("primary-state.json", '{"primaryMachineId": "here", "epoch": 3}')
        self.assertEqual(np.local_role(), "primary")
        os.remove(os.path.join(self.tmp, "primary-local-id.json"))
        self.assertEqual(np.local_role(), "unknown")

    def test_retired_marker_wins(self):
        self.write("primary-state.json", '{"primaryMachineId": "here", "epoch": 3}')
        self.write("primary-retired.json", '{"epoch": 3}')
        self.assertEqual(np.local_role(), "secondary")

    def test_unreadable_is_unknown(self):
        self.write("primary-state.json", "{not json")
        self.assertEqual(np.local_role(), "unknown")


class GiroOneWriter(unittest.TestCase):
    """A secondary (or a computer that cannot tell) never touches Hetzner nor a node: one writer for the pool."""
    def setUp(self):
        self.saved = {k: getattr(np, k) for k in ("local_role", "uplink_giro", "permanent_server", "pool_servers",
                                                  "sweep_stale_bundles", "Lock", "load_state", "save_state",
                                                  "run_harness_sync", "harness_targets")}
        self.calls = []
        np.sweep_stale_bundles = lambda now=None, state_dir=None: None
        np.uplink_giro = lambda role: self.calls.append(("uplink", role))
        np.permanent_server = lambda: self.calls.append("hetzner") or None
        np.pool_servers = lambda: self.calls.append("hetzner") or []
        np.Lock = NoLock
        np.load_state = lambda: {"slots": {}}
        np.save_state = lambda s: None
        np.run_harness_sync = lambda targets, force=False: None
        np.harness_targets = lambda state: []

    def tearDown(self):
        for k, v in self.saved.items():
            setattr(np, k, v)

    def test_secondary_only_keeps_its_uplink(self):
        for role in ("secondary", "unknown"):
            self.calls.clear()
            np.local_role = lambda role=role: role
            self.assertEqual(np.giro(), 0)
            self.assertEqual(self.calls, [("uplink", role)])

    def test_primary_manages_the_pool_and_closes_its_uplink(self):
        np.local_role = lambda: "primary"
        np.giro()
        self.assertEqual(self.calls[0], ("uplink", "primary"))
        self.assertIn("hetzner", self.calls)

    def test_primary_on_the_permanent_node_does_not_tunnel_to_itself(self):
        import socket
        np.local_role = lambda: "primary"
        np.permanent_server = lambda: {"name": socket.gethostname().split(".")[0], "id": 7}
        np.ensure_permanent, saved = (lambda state, fx: self.calls.append("ensure_permanent")), np.ensure_permanent
        try:
            np.giro()
        finally:
            np.ensure_permanent = saved
        self.assertNotIn("ensure_permanent", self.calls)


class FakePrimary:
    """The primary's main server as the Mac sees it through the -L: pairing, machines, slots."""
    def __init__(self, mac_pending):
        import http.server, json as j, threading
        self.machines, self.pairings, self.patches, self.mac_pending = {}, {}, [], mac_pending
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def reply(self, code, body):
                raw = j.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return j.loads(self.rfile.read(n) or b"{}")

            def do_POST(self):
                if self.path == "/api/machines/pair":
                    b = self.body()
                    pid = f"p{len(outer.pairings) + 1}"
                    outer.pairings[pid] = {"baseUrl": b["baseUrl"], "code": f"C{pid}", "approved": False}
                    # the primary reaches the Mac's listener through the -R: a pending request appears there
                    outer.mac_pending.append({"id": f"r-{pid}", "code": f"C{pid}", "pairing": pid})
                    return self.reply(200, {"pairingId": pid, "code": f"C{pid}", "expiresInMs": 60000})
                self.reply(404, {})

            def do_GET(self):
                if self.path.startswith("/api/machines/pair/"):
                    p = outer.pairings.get(self.path.rsplit("/", 1)[1])
                    if not p:
                        return self.reply(200, {"state": "expired"})
                    if not p["approved"]:
                        return self.reply(200, {"state": "pending"})
                    mid = f"m-{self.path.rsplit('/', 1)[1]}"
                    outer.machines.setdefault(mid, {"id": mid, "baseUrl": p["baseUrl"], "status": "online"})
                    return self.reply(200, {"state": "approved", "machine": outer.machines[mid]})
                if self.path == "/api/machines":
                    return self.reply(200, {"machines": list(outer.machines.values())})
                if self.path.startswith("/api/machines/"):
                    m = outer.machines.get(self.path.rsplit("/", 1)[1])
                    return self.reply(200, m) if m else self.reply(404, {"error": "Machine not found"})
                self.reply(404, {})

            def do_PATCH(self):
                mid = self.path.rsplit("/", 1)[1]
                b = self.body()
                outer.patches.append((mid, b))
                outer.machines.get(mid, {}).update(b)
                self.reply(200, outer.machines.get(mid, {}))

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class Uplink(unittest.TestCase):
    """The Mac as a node of the primary: outbound tunnel, paired once, reopened when it dies."""
    def setUp(self):
        import socket
        self.tmp = tempfile.mkdtemp()
        self.saved = {k: getattr(np, k) for k in ("UPLINK_CONF", "ST", "STATE", "Lock", "mac", "pid_alive", "subprocess",
                                                  "load_state", "save_state", "uplink_giro", "port_open", "http_json",
                                                  "listening_pids", "is_ssh")}
        for k in ("load_state", "save_state", "uplink_giro", "port_open", "http_json"):
            setattr(np, k, PRISTINE[k])
        np.ST = self.tmp
        np.STATE = os.path.join(self.tmp, "state.json")
        np.UPLINK_CONF = os.path.join(self.tmp, "uplink.json")
        np.Lock = NoLock
        self.mac_pending, self.approved = [], []
        self.primary = FakePrimary(self.mac_pending)

        def fake_mac(method, path, body=None, timeout=30):
            if path == "/api/auth/pair/pending":
                return {"requests": list(self.mac_pending)}
            if path == "/api/auth/pair/approve":
                req = next(q for q in self.mac_pending if q["id"] == body["requestId"])
                self.approved.append(body)
                self.primary.pairings[req["pairing"]]["approved"] = True
                self.mac_pending.remove(req)
                return {"ok": True}
            raise AssertionError(path)
        np.mac = fake_mac
        self.alive, self.spawned = set(), []
        test = self

        class Popen:
            def __init__(self, argv, **kw):
                self.pid = 1000 + len(test.spawned)
                test.spawned.append(argv)
                test.alive.add(self.pid)
            def poll(self): return None if self.pid in test.alive else 1

        class FakeSubprocess:
            DEVNULL = -3
            Popen = None
        FakeSubprocess.Popen = Popen
        np.subprocess = FakeSubprocess
        np.pid_alive = lambda pid: pid in self.alive
        np.is_ssh = lambda pid: True
        # the tunnel is the listener on the api port as long as it runs: the fake primary stands in for the -L
        self.listener = None
        np.listening_pids = lambda port: set(self.alive) if self.listener is None else {self.listener}
        # a free port for the hub: nothing listens there until a test says so
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        self.hub_port = s.getsockname()[1]
        s.close()
        self.conf = {"ssh": "primary-host", "listener_port": 3341, "node_port": 3302,
                     "api_port": self.primary.port, "api_scheme": "http", "hub_port": self.hub_port, "hub_remote_port": 4000}
        with open(np.UPLINK_CONF, "w") as f:
            json.dump(self.conf, f)

    def tearDown(self):
        self.primary.close()
        for k, v in self.saved.items():
            setattr(np, k, v)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def state(self):
        with open(np.STATE) as f:
            return json.load(f)["uplink"]

    def test_secondary_opens_the_tunnel_and_shows_up_online_on_the_primary(self):
        self.assertEqual(np.uplink_giro("secondary"), 0)
        argv = self.spawned[0]
        self.assertIn("127.0.0.1:3302:127.0.0.1:3341", argv[argv.index("-R") + 1])
        self.assertIn(f"127.0.0.1:{self.hub_port}:127.0.0.1:4000", argv)
        self.assertEqual(argv[-1], "primary-host")
        self.assertEqual(self.approved, [{"requestId": "r-p1", "role": "owner"}])
        mid = self.state()["machine_id"]
        listed = np.http_json(f"http://127.0.0.1:{self.primary.port}", "GET", "/api/machines")["machines"]
        self.assertEqual([(m["id"], m["baseUrl"], m["status"]) for m in listed], [(mid, "http://127.0.0.1:3302", "online")])
        self.assertIn((mid, {"slots": np.SLOTS_PER_NODE}), self.primary.patches)

    def test_tunnel_down_is_reopened_without_pairing_again(self):
        np.uplink_giro("secondary")
        mid = self.state()["machine_id"]
        self.alive.clear()  # the tunnel dies: laptop lid closed, network gone
        np.uplink_giro("secondary")
        self.assertEqual(len(self.spawned), 2)
        self.assertEqual(self.state()["machine_id"], mid)
        self.assertEqual(len(self.primary.pairings), 1)

    def test_a_foreign_listener_on_the_api_port_is_not_the_tunnel(self):
        np.uplink_giro("secondary")
        self.listener = 4242  # another process took the port: our ssh runs but does not hold it
        self.assertFalse(np.uplink_alive(self.state(), self.conf))
        np.uplink_giro("secondary")
        self.assertEqual(len(self.spawned), 2)  # reopened instead of trusting the impostor

    def test_default_api_port_is_outside_the_preview_pool(self):
        self.assertFalse(3400 <= np.UPLINK_DEFAULTS["api_port"] <= 3450)

    def test_alive_tunnel_is_left_alone(self):
        np.uplink_giro("secondary")
        np.uplink_giro("secondary")
        self.assertEqual(len(self.spawned), 1)

    def test_primary_that_forgot_this_computer_pairs_it_again(self):
        np.uplink_giro("secondary")
        self.primary.machines.clear()
        np.uplink_giro("secondary")
        self.assertEqual(len(self.primary.pairings), 2)
        self.assertNotEqual(self.state()["machine_id"], "m-p1")

    def test_busy_local_hub_port_opens_without_the_hub_then_adds_it(self):
        import socket
        busy = socket.socket()
        busy.bind(("127.0.0.1", self.hub_port))
        busy.listen(16)
        try:
            np.uplink_giro("secondary")
        finally:
            busy.close()
        self.assertNotIn(f"127.0.0.1:{self.hub_port}:127.0.0.1:4000", self.spawned[0])
        self.assertFalse(self.state()["hub"])
        np.uplink_giro("secondary")  # the local hub is gone: the tunnel comes back with it
        self.assertIn(f"127.0.0.1:{self.hub_port}:127.0.0.1:4000", self.spawned[1])

    def test_becoming_primary_closes_the_tunnel(self):
        np.uplink_giro("secondary")
        killed = []
        saved_kill = np.os.kill
        np.os.kill = lambda pid, sig: killed.append(pid)
        try:
            np.uplink_giro("primary")
        finally:
            np.os.kill = saved_kill
        self.assertEqual(killed, [1000])
        self.assertNotIn("pid", self.state())

    def test_no_config_is_off(self):
        os.remove(np.UPLINK_CONF)
        self.assertEqual(np.uplink_giro("secondary"), 0)
        self.assertEqual(self.spawned, [])


class ListeningPids(unittest.TestCase):
    def test_finds_the_process_holding_a_loopback_port(self):
        import shutil as sh, socket
        if not (sh.which("lsof") or sh.which("ss")):
            self.skipTest("neither lsof nor ss here")
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        try:
            self.assertIn(os.getpid(), np.listening_pids(srv.getsockname()[1]))
        finally:
            srv.close()


class HcloudToken(unittest.TestCase):
    """Without a Keychain the Hetzner token comes from the secret store, through stdout, never argv."""
    def setUp(self):
        self.saved = (np.subprocess, np.sys.platform, os.environ.pop("HCLOUD_TOKEN", None))
        np._TOKEN.clear()
        self.runs = []
        test = self

        class FakeSubprocess:
            TimeoutExpired = TimeoutError
            @staticmethod
            def run(argv, **kw):
                test.runs.append(argv)
                class Done: stdout = "tok-from-store\n" if argv[0] == np.BUN else ""
                return Done()
        np.subprocess = FakeSubprocess
        np.sys.platform = "linux"

    def tearDown(self):
        np.subprocess, np.sys.platform, env = self.saved
        if env is not None:
            os.environ["HCLOUD_TOKEN"] = env
        np._TOKEN.clear()

    def test_linux_reads_the_store_once(self):
        self.assertEqual(np.token(), "tok-from-store")
        self.assertEqual(np.token(), "tok-from-store")
        self.assertEqual(len(self.runs), 1)
        self.assertEqual(self.runs[0][1:], [os.path.join(np.APP_DIR, "scripts/secret-read.ts"), np.HCLOUD_SECRET])
        self.assertNotIn("security", self.runs[0])


if __name__ == "__main__":
    unittest.main()
