/**
 * @covers MACHINE-08
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineSecurityReport } from "../../shared/machine-health";
import { FAILED_LOGIN_PATTERN, type RunResult, type Runner } from "./machine-security";
import {
  createSshProbeEnv,
  ensureSafeControlDir,
  fitsControlSocket,
  parseSshServers,
  probeSshServer,
  shellQuote,
  sshArgv,
  sshCloseControlArgv,
  sshControlDir,
} from "./machine-security-ssh";

const server = { host: "srv.example.test", user: "audit", port: 2222 };
const done = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr, timedOut: false, missing: false });

/** A scratch directory inside TMPDIR, removed by the caller: tests never write outside the temporary folder. */
function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Output recorded on an Ubuntu server (trimmed).
const SSHD_T = "port 22\npasswordauthentication no\nkbdinteractiveauthentication no\n";
const SS = "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:5432 0.0.0.0:*\n";
const APT = "Listing...\nopenssl/jammy-security 3.0.2 amd64 [upgradable from: 3.0.1]\n";
const APT_HISTORY = "Start-Date: 2026-11-18  06:25:01\nCommandline: apt-get -y upgrade\nEnd-Date: 2026-11-18  06:25:40\n";
const UFW = "Status: active\n";
const JOURNAL = "Nov 20 03:01:00 srv sshd[1]: Failed password for invalid user admin from 203.0.113.7 port 1 ssh2\n";

/** Answers each remote command from a table keyed by the command the server receives. */
function recorded(table: Record<string, RunResult>, seen: string[][] = []): Runner {
  return async (argv) => {
    seen.push(argv);
    const remote = argv[argv.length - 1];
    return table[remote] ?? done("", 1, "no such file");
  };
}

const UBUNTU: Record<string, RunResult> = {
  "'true'": done(""),
  "'sshd' '-T'": done(SSHD_T),
  "'ss' '-ltnH'": done(SS),
  "'apt' 'list' '--upgradable'": done(APT),
  "'cat' '/var/log/apt/history.log'": done(APT_HISTORY),
  "'ufw' 'status'": done(UFW),
  [["journalctl", "-u", "ssh", "-u", "sshd", "--since", "24 hours ago", "--no-pager", "--grep", FAILED_LOGIN_PATTERN].map(shellQuote).join(" ")]: done(JOURNAL),
};

describe("MACHINE-08 server list", () => {
  test("keeps well formed servers and drops anything that looks like an ssh option", () => {
    const list = parseSshServers([
      { host: "a.example.test", user: "u", port: 22 },
      { host: "-oProxyCommand=x" },
      { host: "b.example.test", user: "-x" },
      { host: "c example" },
      { host: "d.example.test", port: 70000 },
      "nope",
    ]);
    expect(list).toEqual([{ host: "a.example.test", user: "u", port: 22 }]);
  });

  test("an empty or missing setting is an empty list", () => {
    expect(parseSshServers(undefined)).toEqual([]);
    expect(parseSshServers([])).toEqual([]);
  });
});

describe("MACHINE-08 ssh command line", () => {
  test("non interactive, one remote word per argument, host after the separator", () => {
    const argv = sshArgv(server, ["cat", "/etc/it's"]);
    expect(argv.slice(0, 3)).toEqual(["ssh", "-o", "BatchMode=yes"]);
    expect(argv).toContain("2222");
    expect(argv.slice(-3)).toEqual(["--", "audit@srv.example.test", `'cat' ${shellQuote("/etc/it's")}`]);
  });

  test("with a controlDir, one connection is reused: ControlMaster, ControlPath and a short ControlPersist", () => {
    const argv = sshArgv(server, ["true"], { controlDir: "/data/ssh-control" });
    expect(argv).toContain("ControlMaster=auto");
    expect(argv.some((a) => a.startsWith("ControlPath=/data/ssh-control/"))).toBe(true);
    expect(argv.some((a) => /^ControlPersist=\d+s$/.test(a))).toBe(true);
  });

  test("without a controlDir, no control options: one connection per command, as before", () => {
    const argv = sshArgv(server, ["true"]);
    expect(argv.some((a) => a.includes("ControlMaster") || a.includes("ControlPath") || a.includes("ControlPersist"))).toBe(false);
  });

  test("the default timeout is the ssh-specific one, long enough for the handshake, not the local 5s", () => {
    const argv = sshArgv(server, ["true"]);
    expect(argv).toContain("ConnectTimeout=12");
  });

  test("a long app data dir still gets a control dir that fits a unix socket path", () => {
    const longAppDataDir = join("/", "a".repeat(120), "b".repeat(80));
    const dir = sshControlDir(longAppDataDir);
    expect(dir).not.toBeNull();
    expect(fitsControlSocket(dir as string)).toBe(true);
  });

  test("the fallback stays short even with a long TMPDIR (macOS: /var/folders/<..>/T)", () => {
    const original = process.env.TMPDIR;
    process.env.TMPDIR = join("/", "var", "folders", "x".repeat(40), "y".repeat(40), "T");
    try {
      const longAppDataDir = join("/", "a".repeat(120), "b".repeat(80));
      const dir = sshControlDir(longAppDataDir);
      expect(dir).not.toBeNull();
      expect(fitsControlSocket(dir as string)).toBe(true);
      expect((dir as string).startsWith(process.env.TMPDIR as string)).toBe(false); // the fallback must not borrow the long TMPDIR
    } finally {
      if (original === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = original;
    }
  });

  test("the socket limit is measured on the hash and the bind suffix ssh adds, not on the directory alone", () => {
    expect(fitsControlSocket("/d")).toBe(true);
    expect(fitsControlSocket(join("/", "d".repeat(60)))).toBe(false); // 61 + 1 + 40 + 17 > 103
  });

  test("a short app data dir keeps its control dir inside the app data folder", () => {
    expect(sshControlDir("/data")).toBe(join("/data", "ssh-control"));
  });

  test("closing the control connection targets the same ControlPath, no remote command", () => {
    const argv = sshCloseControlArgv(server, "/data/ssh-control");
    expect(argv).toEqual(["ssh", "-o", "ControlPath=/data/ssh-control/%C", "-O", "exit", "-p", "2222", "audit@srv.example.test"]);
  });

  test("the environment only reads: cat, ls, stat and the probes", async () => {
    const seen: string[][] = [];
    const env = createSshProbeEnv(server, recorded({ "'cat' '/x'": done("hi"), "'ls' '-1' '/d'": done("a.conf\nb.conf\n"), "'stat' '-c' '%Y' '/f'": done("1700000000\n") }, seen));
    expect(await env.readFile("/x")).toBe("hi");
    expect(await env.listDir("/d")).toEqual(["a.conf", "b.conf"]);
    expect(await env.mtimeMs("/f")).toBe(1_700_000_000_000);
    expect(await env.readFile("/missing")).toBeNull();
    const verbs = seen.map((a) => a[a.length - 1].split(" ")[0]);
    expect(new Set(verbs)).toEqual(new Set(["'cat'", "'ls'", "'stat'"]));
  });

  test("the probe environment runs commands with the ssh timeout, not the runner's default", async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const local: Runner = async (_argv, timeoutMs) => { seenTimeouts.push(timeoutMs); return done(""); };
    const env = createSshProbeEnv(server, local);
    await env.run(["true"]);
    expect(seenTimeouts).toEqual([12_000]);
  });
});

describe("MACHINE-08 round on a recorded Ubuntu", () => {
  test("the same probes give a report with the four checks", async () => {
    const now = () => Date.parse("2026-11-20T12:00:00Z");
    const report = await probeSshServer(server, recorded(UBUNTU), null, null, now);
    expect(report.checks.map((c) => c.key)).toEqual(["updates", "disk", "access", "antivirus"]);
    expect(report.checked_at).toBe(Math.floor(now() / 1000));
    expect(report.checks.find((c) => c.key === "updates")?.status).toBe("ok");
    expect(report.checks.find((c) => c.key === "access")?.status).toBe("ok");
    expect(report.status).not.toBe("unknown");
  });

  test("a key the server refuses gives four unknown checks with the reason", async () => {
    const refuse: Runner = async () => done("", 255, "audit@srv: Permission denied (publickey).");
    const report = await probeSshServer(server, refuse, null, null, () => 1_000_000);
    expect(report.status).toBe("unknown");
    expect(report.checks).toHaveLength(4);
    for (const c of report.checks) { expect(c.status).toBe("unknown"); expect(c.detail).toBe("chiave non accettata"); }
  });

  test("a server that does not answer keeps the last report with its time", async () => {
    const last: MachineSecurityReport = { checked_at: 1234, status: "ok", checks: [{ key: "updates", status: "ok", detail: "ok" }] };
    const timeout: Runner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true, missing: false });
    expect(await probeSshServer(server, timeout, null, last)).toBe(last);
  });

  test("nothing is written: no remote word is a mutating command", async () => {
    const seen: string[][] = [];
    await probeSshServer(server, recorded(UBUNTU, seen), null);
    const words = new Set(seen.map((a) => a[a.length - 1].split(" ")[0]));
    for (const w of words) expect(["'true'", "'cat'", "'ls'", "'stat'", "'sshd'", "'ss'", "'apt'", "'ufw'", "'journalctl'"]).toContain(w);
  });

  test("without a control dir, no round command multiplexes and none closes a shared connection", async () => {
    const seen: string[][] = [];
    await probeSshServer(server, recorded(UBUNTU, seen), null);
    for (const argv of seen) expect(argv.some((a) => a.includes("ControlMaster") || a.includes("ControlPath"))).toBe(false);
  });

  test("with a control dir, every read shares one connection and it is closed at the end of the round", async () => {
    const seen: string[][] = [];
    const controlDir = scratch("ssh-probe-control-");
    try {
      await probeSshServer(server, recorded(UBUNTU, seen), controlDir);
      for (const argv of seen.slice(0, -1)) expect(argv).toContain("ControlMaster=auto");
      // The last command closes the shared connection: its argv ends with the host, not a quoted remote word.
      expect(seen.at(-1)).toEqual(["ssh", "-o", `ControlPath=${join(controlDir, "%C")}`, "-O", "exit", "-p", "2222", "audit@srv.example.test"]);
    } finally {
      rmSync(controlDir, { recursive: true, force: true });
    }
  });
});

describe("MACHINE-08 control dir safety", () => {
  test("a directory of ours, created private, is accepted", () => {
    const parent = scratch("ssh-control-ok-");
    try {
      const dir = join(parent, "ssh-control");
      expect(ensureSafeControlDir(dir)).toBe(true);
      expect(ensureSafeControlDir(dir)).toBe(true); // already there: still ours, still accepted
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a symlink planted where the control dir goes is refused, so the round drops multiplexing", () => {
    const parent = scratch("ssh-control-link-");
    try {
      const dir = join(parent, "ssh-control");
      symlinkSync(parent, dir); // lstat must not follow it: a path someone else controls is not ours
      expect(ensureSafeControlDir(dir)).toBe(false);
    } finally {
      rmSync(join(parent, "ssh-control"), { force: true }); // unlinks the symlink itself, never its target
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a directory other users can reach is refused: its sockets would not be private", () => {
    const parent = scratch("ssh-control-mode-");
    try {
      const dir = join(parent, "ssh-control");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o777);
      expect(ensureSafeControlDir(dir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a path that cannot be created at all is refused instead of throwing", () => {
    expect(ensureSafeControlDir(join("/proc", "topics-ssh-control"))).toBe(false);
  });
});

describe("MACHINE-08 servers file", () => {
  test("a missing file is an empty list and ids carry no more than the address", async () => {
    const { readSshServers, sshServerId } = await import("./machine-security-ssh");
    expect(readSshServers("/nonexistent")).toEqual([]);
    expect(sshServerId(server)).toBe("ssh:audit@srv.example.test:2222");
  });
});
