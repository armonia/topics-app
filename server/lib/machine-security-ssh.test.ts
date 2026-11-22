/**
 * @covers MACHINE-08
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineSecurityReport } from "../../shared/machine-health";
import { FAILED_LOGIN_PATTERN, type RunResult, type Runner } from "./machine-security";
import { createSshProbeEnv, parseSshServers, probeSshServer, shellQuote, sshArgv, sshCloseControlArgv, sshControlDir } from "./machine-security-ssh";

const server = { host: "srv.example.test", user: "audit", port: 2222 };
const done = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr, timedOut: false, missing: false });

/** App data dir shared by the tests that only need `probeSshServer`'s now-required `appDataDir`, not the reuse itself. */
const testAppDataDir = mkdtempSync(join(tmpdir(), "topics-ssh-test-"));
afterAll(() => rmSync(testAppDataDir, { recursive: true, force: true }));

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
    expect(Buffer.byteLength(join(dir, "x".repeat(40))) + 17).toBeLessThanOrEqual(103);
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
    const report = await probeSshServer(server, recorded(UBUNTU), testAppDataDir, null, now);
    expect(report.checks.map((c) => c.key)).toEqual(["updates", "disk", "access", "antivirus"]);
    expect(report.checked_at).toBe(Math.floor(now() / 1000));
    expect(report.checks.find((c) => c.key === "updates")?.status).toBe("ok");
    expect(report.checks.find((c) => c.key === "access")?.status).toBe("ok");
    expect(report.status).not.toBe("unknown");
  });

  test("a key the server refuses gives four unknown checks with the reason", async () => {
    const refuse: Runner = async () => done("", 255, "audit@srv: Permission denied (publickey).");
    const report = await probeSshServer(server, refuse, testAppDataDir, null, () => 1_000_000);
    expect(report.status).toBe("unknown");
    expect(report.checks).toHaveLength(4);
    for (const c of report.checks) { expect(c.status).toBe("unknown"); expect(c.detail).toBe("chiave non accettata"); }
  });

  test("a server that does not answer keeps the last report with its time", async () => {
    const last: MachineSecurityReport = { checked_at: 1234, status: "ok", checks: [{ key: "updates", status: "ok", detail: "ok" }] };
    const timeout: Runner = async () => ({ code: null, stdout: "", stderr: "", timedOut: true, missing: false });
    expect(await probeSshServer(server, timeout, testAppDataDir, last)).toBe(last);
  });

  test("nothing is written: no remote word is a mutating command", async () => {
    const seen: string[][] = [];
    await probeSshServer(server, recorded(UBUNTU, seen), testAppDataDir);
    // The last command closes the shared connection: its argv ends with the host, not a quoted remote word.
    const words = new Set(seen.slice(0, -1).map((a) => a[a.length - 1].split(" ")[0]));
    for (const w of words) expect(["'true'", "'cat'", "'ls'", "'stat'", "'sshd'", "'ss'", "'apt'", "'ufw'", "'journalctl'"]).toContain(w);
  });

  test("with an app data dir, every read shares one connection and it is closed at the end of the round", async () => {
    const seen: string[][] = [];
    const appDataDir = mkdtempSync(join(tmpdir(), "ssh-probe-"));
    try {
      await probeSshServer(server, recorded(UBUNTU, seen), appDataDir);
      for (const argv of seen.slice(0, -1)) expect(argv).toContain("ControlMaster=auto");
      expect(seen.at(-1)).toEqual(["ssh", "-o", `ControlPath=${join(sshControlDir(appDataDir), "%C")}`, "-O", "exit", "-p", "2222", "audit@srv.example.test"]);
    } finally {
      rmSync(appDataDir, { recursive: true, force: true });
    }
  });
});

describe("MACHINE-08 servers file", () => {
  test("a missing file is an empty list and ids carry no more than the address", async () => {
    const { readSshServers, sshServerId } = await import("./machine-security-ssh");
    expect(readSshServers("/nonexistent")).toEqual([]);
    expect(sshServerId(server)).toBe("ssh:audit@srv.example.test:2222");
  });
});
