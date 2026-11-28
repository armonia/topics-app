"""Bench for harness-sync (rules and memories of the Mac -> nodes) and the node-pool additions that go with it.
Fake home, fake ssh/rsync/security: nothing leaves the machine. Run: python3 deploy/cloud-node/test_harness_sync.py"""
import importlib.machinery, importlib.util, json, os, shutil, subprocess, sys, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="harness-sync-test-")
FAKE_HOME = os.path.join(TMP, "home")
os.makedirs(os.path.join(FAKE_HOME, ".topics"))
os.environ.update({
    "HOME": FAKE_HOME,
    "HARNESS_SYNC_CONFIG": os.path.join(TMP, "config.json"),
    "HARNESS_SYNC_STATUS": os.path.join(TMP, "status.json"),
    "HARNESS_SYNC_INTERNAL": os.path.join(TMP, "internal.json"),
    "HARNESS_SYNC_LOG": os.path.join(TMP, "hs.log"),
    "HARNESS_SYNC_MAC_DB": os.path.join(TMP, "none.db"),
    "NODE_POOL_LOG": os.path.join(TMP, "np.log"),
})
loader = importlib.machinery.SourceFileLoader("harness_sync", os.path.join(HERE, "harness-sync"))
hs = importlib.util.module_from_spec(importlib.util.spec_from_loader("harness_sync", loader))
loader.exec_module(hs)
loader2 = importlib.machinery.SourceFileLoader("node_pool", os.path.join(HERE, "node-pool"))
np = importlib.util.module_from_spec(importlib.util.spec_from_loader("node_pool", loader2))
loader2.exec_module(np)

PASSWORD = "s3cret-password-of-the-vault"
T1 = {"machine_id": "m-linux", "name": "Nodo", "kind": "linux", "ip": "10.0.0.1", "key": "/k", "known_hosts": os.path.join(TMP, "known")}
PC = {"machine_id": "m-pc", "name": "PC", "kind": "windows", "ssh": "u@pc", "state_cmd": None}


def put(rel, text="x", mode=None):
    p = os.path.join(FAKE_HOME, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)
    if mode:
        os.chmod(p, mode)
    return p


def write_cfg(**kw):
    c = {"paths": [".claude/CLAUDE.md", ".agents", ".claude/projects/*/memory"], "private_paths": [".claude/jarvis/private"]}
    c.update(kw)
    with open(os.environ["HARNESS_SYNC_CONFIG"], "w") as f:
        json.dump(c, f)


class Fake:
    """Replaces hs._run: records every call (argv and stdin) and answers like a node would."""
    def __init__(self, mounted=True, ssh_ok=True, rsync_rc=0, bitlocker="C: Off FullyDecrypted", pc_state="acceso"):
        self.calls, self.mounted, self.ssh_ok, self.rsync_rc, self.bitlocker, self.pc_state = [], mounted, ssh_ok, rsync_rc, bitlocker, pc_state
        self.missing, self.missing_once = [], []

    def __call__(self, argv, input=None, timeout=300, cwd=None):
        self.calls.append((list(argv), input))
        cp = lambda rc=0, out="", err="": subprocess.CompletedProcess(argv, rc, out, err)
        if argv[0] == "git":   # git è vero: la corrispondenza progetto -> repo si deriva da repo veri
            return subprocess.run(argv, capture_output=True, text=True, cwd=cwd)
        self.last_probe_extra = None
        if argv[0] == "security":
            return cp(0, PASSWORD + "\n") if "find-generic-password" in argv else cp(0)
        if argv[0] == "rsync":
            return cp(self.rsync_rc, "", "boom" if self.rsync_rc else "")
        if argv[0].endswith("pc-state"):
            return cp(0, json.dumps({"pc": self.pc_state}))
        if argv[0] == "ssh":
            if not self.ssh_ok:
                return cp(255, "", "Connection refused")
            cmd = argv[-1]
            if "powershell" in cmd:
                return cp(0, self.bitlocker + "\n")
            if "has-gocryptfs" in cmd:
                missing = "".join(f"missing:{i}\n" for i in self.missing + self.missing_once)
                self.missing_once = []
                return cp(0, ("open" if self.mounted else "closed") + "\nhas-gocryptfs\nhas-rsync\n" + missing)
            if "gocryptfs -q" in cmd:
                self.mounted = True
        return cp(0)

    def argvs(self, prog):
        return [a for a, _ in self.calls if a[0] == prog]


class Base(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(FAKE_HOME, ignore_errors=True)
        os.makedirs(os.path.join(FAKE_HOME, ".topics"))
        for p in ("HARNESS_SYNC_STATUS", "HARNESS_SYNC_INTERNAL"):
            if os.path.exists(os.environ[p]):
                os.remove(os.environ[p])
        put(".claude/CLAUDE.md", "rules")
        put(".agents/AGENTS.md", "agents")
        put(".claude/projects/-a/memory/m.md", "mem")
        put(".claude/jarvis/private/people.md", "SECRET-PEOPLE")
        write_cfg()
        self.cfg = hs.load_config()
        self.fake = Fake()
        hs._run = self.fake
        self.pw = lambda: PASSWORD

    def go(self, targets=None, **kw):
        return hs.run(self.cfg, [T1] if targets is None else targets, pw_fn=self.pw, **kw)


class Config(Base):
    def test_no_file_means_off(self):
        os.remove(os.environ["HARNESS_SYNC_CONFIG"])
        self.assertIsNone(hs.load_config())
        self.assertEqual(hs.main(["run"]), 0)
        self.assertFalse(os.path.exists(os.environ["HARNESS_SYNC_STATUS"]))

    def test_paths_outside_home_are_dropped_and_private_never_in_clear(self):
        write_cfg(paths=["/etc", "~/../x", ".agents", ".claude/jarvis/private"], private_paths=[".claude/jarvis/private", "a b$c"])
        c = hs.load_config()
        self.assertEqual(c["paths"], [".agents"])
        self.assertEqual(c["private_paths"], [".claude/jarvis/private"])


class SshMarking(Base):
    def test_ssh_never_sets_a_dscp_mark(self):
        # il DSCP di default di ssh rallenta l'handshake su alcune reti (17/11: 13-72 s contro 1-4 s)
        argv = hs.ssh_argv(T1, "true")
        self.assertIn("IPQoS=af41", argv)

    def test_ssh_shares_one_connection_per_node(self):
        # every new ssh login is a logind session on the node: commands ride one master (card e809a470)
        argv = hs.ssh_argv(T1, "true")
        self.assertIn("ControlMaster=auto", argv)
        self.assertTrue(any(a.startswith("ControlPath=") and a.endswith("%C") for a in argv))


class Exclusions(Base):
    def test_excluded_names_never_enter_the_fingerprint_nor_the_listing(self):
        put(".agents/skills/x/node_modules/a.js")
        put(".agents/backups/old.tgz")
        put(".agents/skills/x/.credentials.json")
        put(".agents/history.jsonl")
        put(".agents/settings.json")
        put(".agents/vendor/v.sh")
        put(".agents/skills/x/SKILL.md")
        files = sorted(r for r, _ in hs.iter_files(".agents", ["vendor"]))
        self.assertEqual(files, [".agents/AGENTS.md", ".agents/skills/x/SKILL.md"])

    def test_an_excluded_file_listed_as_an_entry_is_not_carried(self):
        put(".claude/settings.json", "{}")
        write_cfg(paths=[".claude/settings.json", ".claude/CLAUDE.md"])
        u = hs.compute_units(hs.load_config())
        self.assertEqual(u["pub:.claude/settings.json"]["rels"], [])
        self.assertEqual(u["pub:.claude/CLAUDE.md"]["rels"], [".claude/CLAUDE.md"])

    def test_symlinks_are_followed_and_loops_do_not_hang(self):
        put("elsewhere/real.md", "real")
        os.makedirs(os.path.join(FAKE_HOME, ".agents/skills"))
        os.symlink(os.path.join(FAKE_HOME, "elsewhere"), os.path.join(FAKE_HOME, ".agents/skills/link"))
        os.symlink(os.path.join(FAKE_HOME, ".agents"), os.path.join(FAKE_HOME, ".agents/skills/loop"))
        files = [r for r, _ in hs.iter_files(".agents")]
        self.assertIn(".agents/skills/link/real.md", files)

    def test_rsync_command_carries_every_exclusion(self):
        u = [x for x in hs.compute_units(self.cfg).values() if x["kind"] == "pub"]
        a = hs.rsync_files_argv(T1, u, False, ["vendor"])
        for pat in ("settings.json", ".credentials*", "node_modules", "history.jsonl", "backups", "vendor"):
            self.assertIn(f"--exclude={pat}", a)


class Fingerprint(Base):
    def test_changes_with_content_and_not_otherwise(self):
        a = hs.rev_of({k: v["fp"] for k, v in hs.compute_units(self.cfg).items()})
        self.assertEqual(a, hs.rev_of({k: v["fp"] for k, v in hs.compute_units(self.cfg).items()}))
        time.sleep(0.01)
        put(".claude/CLAUDE.md", "rules changed")
        b = hs.rev_of({k: v["fp"] for k, v in hs.compute_units(self.cfg).items()})
        self.assertNotEqual(a, b)


class PrivateStaysEncrypted(Base):
    def test_private_goes_only_through_the_guarded_rsync_into_the_vault(self):
        self.go()
        rs = self.fake.argvs("rsync")
        prvs = [a for a in rs if f":{hs.REMOTE_MNT}/" in a[-1]]
        pubs = [a for a in rs if a not in prvs]
        self.assertTrue(prvs and pubs)
        self.assertTrue(all(not any("jarvis/private" in x for x in a) for a in pubs), "il privato non parte nel giro in chiaro")
        self.assertTrue(all(a[-1].startswith("root@10.0.0.1:/home/topics/") for a in pubs))
        prv = prvs[0]
        self.assertTrue(all(f"--rsync-path={hs.GUARD_PATH}" in a for a in prvs), "ogni trasferimento del privato passa dalla guardia")
        g = hs.guard_script()
        self.assertIn("/proc/mounts", g)
        self.assertIn("exit 99", g, "senza mount il trasferimento si rifiuta di partire")
        self.assertIn(g, hs.links_script([".claude/jarvis/private"]), "la guardia la installa lo stesso giro che crea i link")
        self.assertTrue(any("jarvis/private" in a for a in prv))
        self.assertIn("--chmod=u+rwX,go-rwx", prv)

    def test_closed_vault_is_reopened_and_status_says_so(self):
        self.fake.mounted = False
        out = self.go(mount=False)
        t = out["targets"]["m-linux"]
        self.assertEqual(t["private"], "closed")
        self.assertIn("chiusa", t["private_reason"])
        self.assertEqual([a for a in self.fake.argvs("rsync") if hs.REMOTE_MNT in a[-1] or any("jarvis/private" in x for x in a)], [],
                         "chiuso: il privato non si trasferisce, mai in chiaro altrove")
        out = self.go(force=True)
        self.assertEqual(out["targets"]["m-linux"]["private"], "open")
        self.assertEqual(out["targets"]["m-linux"]["rev"], out["source"]["rev"])

    def test_password_only_on_stdin_never_in_argv_never_in_files(self):
        self.fake.mounted = False
        self.go()
        for argv, _ in self.fake.calls:
            self.assertFalse(any(PASSWORD in a for a in argv), f"password in argv: {argv[:3]}")
        stdins = [i for a, i in self.fake.calls if i]
        self.assertEqual(stdins, [PASSWORD + "\n"], "una sola volta, solo per il mount")
        script = hs.mount_script()
        self.assertNotIn(PASSWORD, script)
        self.assertIn("printf '%s\\n' \"$PW\" |", script)
        for name in os.listdir(TMP):
            p = os.path.join(TMP, name)
            if os.path.isfile(p):
                with open(p) as fh:
                    self.assertNotIn(PASSWORD, fh.read())

    def test_keychain_write_goes_through_stdin_of_security(self):
        calls = []
        def fake(argv, input=None, timeout=300, cwd=None):
            calls.append((argv, input))
            if "find-generic-password" in argv:
                n = sum(1 for a, _ in calls if "find-generic-password" in a)
                return subprocess.CompletedProcess(argv, 0 if n > 1 else 44, written[0] if n > 1 else "", "")
            written[0] = input.split('-w "')[1].split('"')[0] + "\n"
            return subprocess.CompletedProcess(argv, 0, "", "")
        written = [None]
        hs._run = fake
        pw = hs.keychain_password()
        self.assertTrue(pw)
        for argv, _ in calls:
            self.assertNotIn(pw, " ".join(argv))
        self.assertEqual(calls[1][0], ["security", "-i"])

    def test_no_password_no_mount(self):
        self.fake.mounted = False
        self.pw = lambda: None
        out = self.go()
        self.assertEqual(out["targets"]["m-linux"]["private"], "closed")
        self.assertIn("Portachiavi", out["targets"]["m-linux"]["private_reason"])
        self.assertTrue(self.fake.argvs("rsync"))
        self.assertTrue(all(f":{hs.REMOTE_MNT}/" not in a[-1] for a in self.fake.argvs("rsync")), "senza volume aperto il privato non parte")

    def test_vault_scripts_use_the_user_and_a_private_mode(self):
        s = hs.mount_script()
        self.assertIn("install -d -m 700", s)
        self.assertIn("runuser -u topics -- gocryptfs", s)
        l = hs.links_script([".claude/jarvis/private"])
        self.assertIn(f"ln -sfn {hs.REMOTE_MNT}/.claude/jarvis/private", l)


class PcWithoutBitlocker(Base):
    def run_pc(self, bitlocker):
        self.fake.bitlocker = bitlocker
        sent = []
        hs.tar_to_pc = lambda t, units, extra=(): (sent.append([u["entry"] for u in units]), (0, ""))[1]
        out = self.go([PC])
        return out["targets"]["m-pc"], sent

    def test_plain_disk_skips_private(self):
        t, sent = self.run_pc("C: Off FullyDecrypted")
        self.assertEqual(t["private"], "skipped")
        self.assertIn("disco non cifrato", t["private_reason"])
        flat = [e for s in sent for e in s]
        self.assertIn(".agents", flat)
        self.assertNotIn(".claude/jarvis/private", flat)
        self.assertEqual(t["rev"], hs.read_json(os.environ["HARNESS_SYNC_STATUS"], {})["source"]["rev"])

    def test_unverifiable_bitlocker_counts_as_plain(self):
        t, sent = self.run_pc("garbage")
        self.assertEqual(t["private"], "skipped")
        self.assertIn("non verificabile", t["private_reason"])
        self.assertNotIn(".claude/jarvis/private", [e for s in sent for e in s])

    def test_encrypted_disk_receives_private(self):
        t, sent = self.run_pc("C: On FullyEncrypted")
        self.assertEqual(t["private"], "open")
        self.assertIn(".claude/jarvis/private", [e for s in sent for e in s])

    def test_sleeping_pc_is_not_touched_and_says_why(self):
        PCs = dict(PC, state_cmd="/x/pc-state")
        self.fake.pc_state = "dorme"
        out = self.go([PCs])
        self.assertIn("PC spento", out["targets"]["m-pc"]["error"])
        self.assertEqual(self.fake.argvs("ssh"), [])

    def test_aligned_pc_is_not_contacted_again(self):
        self.run_pc("C: Off FullyDecrypted")
        n = len(self.fake.argvs("ssh"))
        self.go([PC])
        self.assertEqual(len(self.fake.argvs("ssh")), n, "niente da fare = nessuna sessione ssh (terrebbe sveglio il PC)")


class StatusContract(Base):
    def test_format_and_atomic_write(self):
        out = self.go()
        st = hs.read_json(os.environ["HARNESS_SYNC_STATUS"], None)
        self.assertEqual(st, out)
        self.assertEqual(set(st), {"source", "targets", "history"})
        self.assertEqual(set(st["source"]), {"rev", "at"})
        t = st["targets"]["m-linux"]
        self.assertEqual(set(t), {"name", "rev", "at", "error", "private", "private_reason"})
        self.assertEqual(t["rev"], st["source"]["rev"])
        self.assertIn(t["private"], ("open", "closed", "skipped", "off"))
        self.assertEqual(list(st["history"]["m-linux"][-1]), ["at", "lag_s"])
        self.assertEqual(st["history"]["m-linux"][-1]["lag_s"], 0)
        self.assertEqual([f for f in os.listdir(TMP) if f.endswith(".tmp")], [], "nessun temporaneo lasciato")

    def test_write_is_a_replace_not_a_partial_file(self):
        calls = []
        real = os.replace
        os.replace = lambda a, b: (calls.append((a, b)), real(a, b))[1]
        try:
            self.go()
        finally:
            os.replace = real
        self.assertIn(os.environ["HARNESS_SYNC_STATUS"], [b for _, b in calls])

    def test_lag_grows_while_a_target_is_behind_and_history_is_cut_at_24h(self):
        self.fake.ssh_ok = False
        t0 = time.time() - 30 * 3600
        self.go(now=t0)
        put(".claude/CLAUDE.md", "new rules")
        for k in range(1, 5):
            out = self.go(now=t0 + k * 3600, force=True)
        h = out["history"]["m-linux"]
        self.assertTrue(all(s["at"] >= t0 + 3600 * 4 - hs.HISTORY_S for s in h), "campioni più vecchi di 24 h tagliati")
        self.assertGreater(h[-1]["lag_s"], 0)
        self.assertIn("non raggiungibile", out["targets"]["m-linux"]["error"])
        self.assertNotEqual(out["targets"]["m-linux"]["rev"], out["source"]["rev"])

    def test_rsync_failure_keeps_the_node_behind_with_a_sentence(self):
        self.fake.rsync_rc = 12
        out = self.go()
        t = out["targets"]["m-linux"]
        self.assertIn("rsync", t["error"])
        self.assertNotEqual(t["rev"], out["source"]["rev"])
        self.fake.rsync_rc = 0
        out = self.go(force=True)
        self.assertEqual(out["targets"]["m-linux"]["rev"], out["source"]["rev"])
        self.assertIsNone(out["targets"]["m-linux"]["error"])

    def test_no_private_config_reports_off(self):
        write_cfg(private_paths=[])
        self.cfg = hs.load_config()
        out = self.go()
        self.assertEqual(out["targets"]["m-linux"]["private"], "off")
        self.assertTrue(all(":/home/topics/" in a[-1] and hs.REMOTE_MNT not in a[-1] for a in self.fake.argvs("rsync")))


def git(*a, cwd):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", *a], cwd=cwd, check=True, capture_output=True)


class ProjectMemoryAliases(Base):
    """La memoria di un progetto deve stare dove Claude Code, sul nodo, la cerca: sotto il nome codificato del
    percorso del repo del nodo. La corrispondenza si deriva dal repo (origin), mai dal nome scritto a mano."""
    def setUp(self):
        super().setUp()
        self.repo = os.path.join(FAKE_HOME, "Projects", "some-checkout-name")
        os.makedirs(self.repo)
        git("init", "-q", cwd=self.repo)
        git("remote", "add", "origin", "git@github.com:acme/myrepo.git", cwd=self.repo)
        git("commit", "-q", "--allow-empty", "-m", "i", cwd=self.repo)
        self.wt = os.path.join(FAKE_HOME, ".topics", "worktrees", "myrepo", "wt1")
        git("worktree", "add", "-q", "-b", "card", self.wt, cwd=self.repo)
        for path, text in ((self.repo, "MAIN-MEMORY"), (self.wt, "WORKTREE-MEMORY")):
            enc = hs.encode_project_path(path)
            put(f".claude/projects/{enc}/memory/MEMORY.md", text)
            put(f".claude/projects/{enc}/s1.jsonl", json.dumps({"type": "user", "cwd": path}) + "\n")
        self.enc_repo = hs.encode_project_path(self.repo)
        self.node_enc = "-home-topics-repos-myrepo"
        self.cfg = hs.load_config()

    def test_encoding_matches_claude_code(self):
        self.assertEqual(hs.encode_project_path("/home/topics/.topics/worktrees/x_y"), "-home-topics--topics-worktrees-x-y")

    def test_alias_from_origin_name_and_worktrees_are_not_aliased(self):
        al = hs.project_aliases(self.cfg, {}, time.time())
        self.assertEqual([a["enc"] for a in al], [self.node_enc], "un solo alias: il worktree risolve al repo principale")
        self.assertEqual(al[0]["rel"], f".claude/projects/{self.enc_repo}/memory")
        self.assertEqual(al[0]["dest"], f".claude/projects/{self.node_enc}/memory")

    def test_memory_without_a_git_origin_gets_no_alias(self):
        shutil.rmtree(os.path.join(self.repo, ".git/worktrees"), ignore_errors=True)
        git("remote", "remove", "origin", cwd=self.repo)
        self.assertEqual(hs.project_aliases(self.cfg, {}, time.time()), [])

    def test_alias_is_synced_to_the_node_name_and_not_to_windows(self):
        out = self.go()
        cmds = self.fake.argvs("rsync")
        al = [a for a in cmds if a[-1].endswith(f"{self.node_enc}/memory/")]
        self.assertEqual(len(al), 1)
        self.assertEqual(al[0][-2], f"{FAKE_HOME}/.claude/projects/{self.enc_repo}/memory/")
        self.assertIn("--delete", al[0])
        self.assertNotIn("-R", al[0])
        mk = [a[-1] for a in self.fake.argvs("ssh") if "mkdir -p" in a[-1]]
        self.assertTrue(any(self.node_enc in c and "runuser -u topics -- mkdir -p" in c for c in mk),
                        "la cartella padre si crea prima, come utente topics")
        self.assertEqual(out["targets"]["m-linux"]["rev"], out["source"]["rev"])
        sent = []
        hs.tar_to_pc = lambda t, units, extra=(): (sent.append([u["entry"] for u in units]), (0, ""))[1]
        out = self.go([PC])
        self.assertFalse(any(e.startswith("alias:") for s in sent for e in s), "gli alias sono per i nodi Linux")
        self.assertEqual(out["targets"]["m-pc"]["rev"], out["source"]["rev"])

    def test_contents_are_the_same_as_the_mac(self):
        self.go()
        # il contenuto trasferito è la cartella memory del repo principale, non quella del worktree
        src = [a[-2] for a in self.fake.argvs("rsync") if a[-1].endswith(f"{self.node_enc}/memory/")][0]
        with open(os.path.join(src, "MEMORY.md")) as f:
            self.assertEqual(f.read(), "MAIN-MEMORY")


class DeliveryNeverDeletesOutsideItsUnits(Base):
    """Il guasto del 17/11: `rsync -R --delete` ripulisce anche le cartelle padre (.claude, .claude/projects) di ciò
    che manda, e ogni giro cancellava ciò che il giro prima aveva portato (più sessioni e transcript del nodo)."""
    def local(self, argv, dest_root):
        # lo stesso comando, ma verso una cartella locale: rsync vero, senza ssh
        a = list(argv)
        i = a.index("-e")
        del a[i:i + 2]
        a = [x for x in a if not x.startswith("--rsync-path=")]
        a[-1] = a[-1].split(":", 1)[1].replace("/home/topics", dest_root, 1)
        return subprocess.run(a, cwd=FAKE_HOME, capture_output=True, text=True)

    def test_files_command_has_no_delete_and_dir_command_has_no_relative(self):
        u = hs.compute_units(self.cfg)
        self.assertNotIn("--delete", hs.rsync_files_argv(T1, [u["pub:.claude/CLAUDE.md"]], False, []))
        d = hs.rsync_dir_argv(T1, ".agents", ".agents", False, [])
        self.assertIn("--delete", d)
        self.assertNotIn("-R", d)
        self.assertTrue(d[-1].endswith(":/home/topics/.agents/"))

    def test_real_rsync_leaves_the_rest_of_the_node_home_alone(self):
        dest = os.path.join(TMP, "node-home")
        shutil.rmtree(dest, ignore_errors=True)
        for rel in (".claude/projects/-old/session.jsonl", ".claude/sessions/s", ".claude/file-history/h", ".bashrc"):
            p = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as fh:
                fh.write("node's own")
        put(".claude/commands/c.md", "cmd")
        put(".claude/agents/a.md", "ag")
        write_cfg(paths=[".claude/CLAUDE.md", ".claude/commands", ".claude/agents", ".claude/projects/*/memory"], private_paths=[])
        cfg = hs.load_config()
        units = hs.compute_units(cfg)
        os.makedirs(os.path.join(dest, ".claude"), exist_ok=True)
        # un giro con UNA sola unità stale (la situazione che ogni 15 minuti cancellava il resto)
        dirs = [units["pub:.claude/commands"]]
        files = [units["pub:.claude/CLAUDE.md"], units["pub:.claude/projects/*/memory"]]
        r = self.local(hs.rsync_files_argv(T1, files, False, []), dest)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.local(hs.rsync_dir_argv(T1, ".claude/commands", ".claude/commands", False, []), dest)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.local(hs.rsync_dir_argv(T1, ".claude/commands", ".claude/commands", False, []), dest)
        for rel in (".claude/projects/-old/session.jsonl", ".claude/sessions/s", ".claude/file-history/h", ".bashrc",
                    ".claude/CLAUDE.md", ".claude/commands/c.md", ".claude/projects/-a/memory/m.md"):
            self.assertTrue(os.path.exists(os.path.join(dest, rel)), f"sparito: {rel}")
        # dentro la propria cartella invece ripulisce ciò che sul Mac non c'è più
        with open(os.path.join(dest, ".claude/commands/stale.md"), "w") as fh:
            fh.write("old")
        self.local(hs.rsync_dir_argv(T1, ".claude/commands", ".claude/commands", False, []), dest)
        self.assertFalse(os.path.exists(os.path.join(dest, ".claude/commands/stale.md")))

    def test_rsync_error_is_an_error_and_never_a_delivery(self):
        self.fake.rsync_rc = 23
        out = self.go()
        t = out["targets"]["m-linux"]
        self.assertIn("rsync", t["error"])
        self.assertIn("exit 23", t["error"])
        self.assertNotEqual(t["rev"], out["source"]["rev"])
        d = hs.read_json(os.environ["HARNESS_SYNC_INTERNAL"], {})["delivered"]["m-linux"]
        self.assertFalse([k for k in d if k.startswith(("pub:", "prv:"))], "niente segnato come consegnato")

    def test_delivery_is_measured_on_the_node_not_from_the_exit_code(self):
        self.fake.missing = [0]
        out = self.go()
        t = out["targets"]["m-linux"]
        self.assertIn("consegna non verificata", t["error"])
        self.assertNotEqual(t["rev"], out["source"]["rev"])


class FileLimit(unittest.TestCase):
    def test_launchd_style_low_limit_is_raised_for_the_many_memory_folders(self):
        code = ("import importlib.machinery as m, importlib.util as u, resource, sys; "
                "l = m.SourceFileLoader('hs', sys.argv[1]); s = u.spec_from_loader('hs', l); mod = u.module_from_spec(s); l.exec_module(mod); "
                "mod.raise_fd_limit(); print(resource.getrlimit(resource.RLIMIT_NOFILE)[0])")
        r = subprocess.run(["bash", "-c", f"ulimit -S -n 256; {sys.executable} -c \"$0\" \"$1\"", code, os.path.join(HERE, "harness-sync")],
                           capture_output=True, text=True)
        self.assertGreaterEqual(int(r.stdout.strip()), 4096, r.stderr)


class NodeWasCleaned(Base):
    def test_something_delivered_but_gone_from_the_node_is_sent_again(self):
        self.go()
        n = len(self.fake.argvs("rsync"))
        self.go(force=True)
        self.assertEqual(len(self.fake.argvs("rsync")), n, "tutto presente: niente da rifare")
        units = hs.read_json(os.environ["HARNESS_SYNC_INTERNAL"], {})["units"]
        checks = hs.probe_checks(units)
        self.fake.missing_once = [i for i, (k, _) in enumerate(checks) if k == "pub:.claude/CLAUDE.md"]
        self.assertTrue(self.fake.missing_once)
        out = self.go()   # senza force: il nodo ha perso qualcosa, non si aspettano i 15 minuti
        again = [a for a in self.fake.argvs("rsync")[n:] if ".claude/CLAUDE.md" in a and "-R" in a]
        self.assertEqual(len(again), 1, "ciò che il nodo ha perso torna al giro dopo")
        self.assertEqual(out["targets"]["m-linux"]["rev"], out["source"]["rev"])

    def test_probe_tests_links_for_private_and_paths_for_public(self):
        cs = dict(hs.probe_checks(hs.compute_units(self.cfg)))
        self.assertIn("[ -L /home/topics/.claude/jarvis/private ]", cs["prv:.claude/jarvis/private"])
        self.assertIn("[ -e /home/topics/.agents ]", cs["pub:.agents"])


class NodePoolSide(unittest.TestCase):
    def test_spend_daily_for_the_current_month_with_the_fixed_cost(self):
        t0 = time.mktime((2026, 11, 3, 23, 30, 0, 0, 0, -1))
        sd = np.spend_daily({"created": t0, "eur_h": 0.5}, t0 + 90 * 60)
        d = {x["day"]: x["eur"] for x in sd}
        self.assertEqual(list(d)[0], "2026-11-01")
        self.assertEqual(d["2026-11-03"], 0.5, "la prima ora comincia il 3")
        self.assertEqual(d["2026-11-04"], 0.5, "la seconda ora comincia il 4")
        self.assertEqual(round(sum(d.values()), 4), 1.0)

    def test_fixed_cost_stops_at_the_monthly_price(self):
        now = time.mktime((2026, 11, 20, 12, 0, 0, 0, 0, -1))
        fixed = {"created": time.mktime((2026, 10, 10, 0, 0, 0, 0, 0, -1)), "eur_h": 0.0476, "eur_month": 29.49}
        sd = np.spend_daily(fixed, now)
        self.assertEqual(round(sum(x["eur"] for x in sd), 2), 29.49 if 0.0476 * 24 * 20 > 29.49 else round(0.0476 * 24 * 19.5, 2))
        self.assertTrue(all(set(x) == {"day", "eur"} for x in sd))

    def test_node_pool_launches_harness_sync_detached_with_the_targets(self):
        launched = []
        class P:
            def __init__(s):
                import io
                s.stdin = io.BytesIO()
        real = np.subprocess.Popen
        np.subprocess.Popen = lambda argv, **kw: (launched.append((argv, kw)), P())[1]
        try:
            self.assertTrue(np.run_harness_sync([{"machine_id": "m"}], force=True))
        finally:
            np.subprocess.Popen = real
        argv, kw = launched[0]
        self.assertEqual(argv[-1], "--force")
        self.assertTrue(kw["start_new_session"])
        self.assertTrue(argv[1].endswith("harness-sync"))

    def test_targets_are_the_ready_slots_only(self):
        st = {"slots": {"1": {"ready": True, "ip": "1.2.3.4", "machine_id": "m1", "server_id": 7, "name": "n1"},
                        "2": {"ready": False, "ip": "1.2.3.5", "machine_id": "m2", "server_id": 8},
                        "3": {"n": 3}}}
        t = np.harness_targets(st)
        self.assertEqual([x["machine_id"] for x in t], ["m1"])
        self.assertEqual(t[0]["kind"], "linux")


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
