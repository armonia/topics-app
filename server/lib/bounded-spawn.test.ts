/**
 * `spawnBounded` / `runBounded`: an external process answers or the deadline
 * does, never later, even when a grandchild holds the pipe open.
 * @covers GIT-DEADLINE-01
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded, spawnBounded } from "./bounded-spawn";
import { gitEnv } from "../../tests/setup/bun-test-preload";

const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });

describe("runBounded", () => {
  it("restituisce stdout, stderr e l'esito di un processo che risponde", async () => {
    const r = await runBounded(["sh", "-c", "echo ciao; echo errore >&2; exit 3"], { timeoutMs: 5000, stderr: "pipe" });
    expect(r).toEqual({ stdout: "ciao\n", stderr: "errore\n", exitCode: 3, timedOut: false, spawnFailed: false });
  });

  it("passa lo stdin e lo chiude", async () => {
    const r = await runBounded(["cat"], { timeoutMs: 5000, stdinData: "dentro" });
    expect(r.stdout).toBe("dentro");
    expect(r.exitCode).toBe(0);
  });

  it("un processo che non risponde torna alla scadenza, non alla sua fine", async () => {
    const t0 = performance.now();
    const r = await runBounded(["sleep", "30"], { timeoutMs: 300 });
    const dt = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(dt).toBeLessThan(2000);
  });

  it("un nipote che ignora SIGTERM e tiene la pipe aperta non trattiene la risposta", async () => {
    // The case `Bun.spawn({ timeout })` + `await text()` does NOT solve: once the
    // shell is killed, its `sleep` child holds stdout and the read waits 30 seconds.
    const t0 = performance.now();
    const r = await runBounded(["sh", "-c", "trap '' TERM; sleep 30"], { timeoutMs: 300, graceMs: 500 });
    const dt = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(dt).toBeLessThan(2000); // deadline + grace + the close margin, not 30 s
  });

  it("segnala un binario che non esiste senza lanciare", async () => {
    const r = await runBounded(["/nonexistent/binary-xyz"], { timeoutMs: 1000 });
    expect(r.spawnFailed).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it("TOPICS_SPAWN_TIMEOUT_CAP_MS abbassa ogni scadenza", async () => {
    process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS = "200";
    try {
      const t0 = performance.now();
      const r = await runBounded(["sleep", "30"], { timeoutMs: 60_000 });
      expect(r.timedOut).toBe(true);
      expect(performance.now() - t0).toBeLessThan(2000);
    } finally {
      delete process.env.TOPICS_SPAWN_TIMEOUT_CAP_MS;
    }
  });
});

describe("spawnBounded come sostituto di Bun.spawn", () => {
  it("un git finto che non risponde fa tornare chi legge stdout e exited alla scadenza", async () => {
    // The way callers use it: read the text, then `exited`, then `exitCode`.
    const t0 = performance.now();
    const proc = spawnBounded(["sh", "-c", "trap '' TERM; echo parziale; sleep 30"], { stdout: "pipe", stderr: "ignore", timeoutMs: 400, graceMs: 500 });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    expect(performance.now() - t0).toBeLessThan(2500);
    expect(text).toBe("parziale\n"); // what arrived before the deadline is not lost
    expect(proc.timedOut).toBe(true);
    expect(proc.exitCode).not.toBe(0);
  });

  it("senza scadenza si comporta come Bun.spawn: esito e uscita intatti", async () => {
    const proc = spawnBounded(["sh", "-c", "printf uno; exit 0"], { stdout: "pipe", timeoutMs: 5000 });
    expect(await new Response(proc.stdout).text()).toBe("uno");
    expect(await proc.exited).toBe(0);
    expect(proc.exitCode).toBe(0);
    expect(proc.timedOut).toBe(false);
  });

  it("uno stdout grande arriva intero", async () => {
    const proc = spawnBounded(["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' 'a'"], { stdout: "pipe", timeoutMs: 10_000 });
    const text = await new Response(proc.stdout).text();
    expect(text.length).toBe(3_000_000);
  });
});

describe("the deadline asks politely first (SIGTERM), then forces (SIGKILL)", () => {
  it("a git killed at the deadline leaves no index.lock behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bounded-lock-"));
    try {
      sh(dir, "init", "-q");
      sh(dir, "config", "user.email", "t@t");
      sh(dir, "config", "user.name", "t");
      // A clean filter that takes 5 s: `git add` holds `.git/index.lock` while it runs.
      sh(dir, "config", "filter.slow.clean", "sleep 5; cat");
      writeFileSync(join(dir, ".gitattributes"), "* filter=slow\n");
      writeFileSync(join(dir, "a.txt"), "a\n");
      const r = await runBounded(["git", "add", "-A", "--", "."], { cwd: dir, env: gitEnv(), timeoutMs: 1500, graceMs: 3000 });
      expect(r.timedOut).toBe(true);
      // SIGKILL would have left the lock: the next git would exit 128 "index.lock: File exists".
      expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
      const next = sh(dir, "-c", "filter.slow.clean=cat", "add", "-A", "--", ".");
      expect(next.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a script's trap cleanup runs when the deadline fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bounded-trap-"));
    const marker = join(dir, "cleaned");
    try {
      const script = `trap 'echo done > ${marker}; exit 0' TERM; sleep 30 & wait`;
      const r = await runBounded(["sh", "-c", script], { timeoutMs: 400, graceMs: 3000 });
      expect(r.timedOut).toBe(true);
      expect(existsSync(marker) && readFileSync(marker, "utf8").trim()).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a process that ignores SIGTERM is still gone by deadline + grace", async () => {
    const t0 = performance.now();
    const r = await runBounded(["sh", "-c", "trap '' TERM; sleep 30"], { timeoutMs: 300, graceMs: 600 });
    const dt = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(dt).toBeGreaterThan(800); // it did wait for the grace before forcing
    expect(dt).toBeLessThan(2500);
  });

  it("kill() with no argument is SIGTERM, like Bun.spawn", async () => {
    const proc = spawnBounded(["sh", "-c", "trap 'exit 7' TERM; sleep 30 & wait"], { stdout: "pipe", timeoutMs: 20_000 });
    await Bun.sleep(150);
    proc.kill();
    await proc.exited;
    expect(proc.exitCode).toBe(7); // a SIGKILL would have given null
  });
});

describe("the deadline limits the ANSWER, not the direct child", () => {
  it("a child that exits at once and leaves a grandchild holding the pipe times out at the deadline", async () => {
    const t0 = performance.now();
    const r = await runBounded(["sh", "-c", "sleep 8 & echo started"], { timeoutMs: 1000, graceMs: 300 });
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(3000); // it came back after 8023 ms when the child's exit switched the timer off
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull(); // a deadline is a failure, whatever the direct child's status was
    expect(r.stdout).toBe("started\n"); // what arrived is kept
  });

  it("`exited` does not report success while the pipe is still held", async () => {
    const proc = spawnBounded(["sh", "-c", "sleep 8 & echo started"], { stdout: "pipe", timeoutMs: 800, graceMs: 300 });
    const code = await proc.exited;
    expect(code).toBeNull();
    expect(proc.timedOut).toBe(true);
  });

  it("a normal call is not a timeout and keeps its status", async () => {
    const r = await runBounded(["sh", "-c", "echo ok; exit 4"], { timeoutMs: 800 });
    expect(r).toMatchObject({ stdout: "ok\n", exitCode: 4, timedOut: false });
  });

  it("awaiting `exited` before reading the output does not wait for the deadline", async () => {
    // The pattern many callers use. 3 MB is more than one chunk and more than the pipe holds.
    const t0 = performance.now();
    const proc = spawnBounded(["sh", "-c", "head -c 3000000 /dev/zero"], { stdout: "pipe", timeoutMs: 20_000 });
    await proc.exited;
    const text = await new Response(proc.stdout).text();
    expect(text.length).toBe(3_000_000);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(proc.timedOut).toBe(false);
  });
});

describe("the server's shutdown closes the groups it launched", () => {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); } catch { return false; }
    // A zombie is dead; some inits (a cloud VM's) never collect it.
    const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { timeout: 3000, killSignal: "SIGKILL" });
    return !new TextDecoder().decode(stat.stdout).trim().startsWith("Z");
  };

  // The host forwards launchd's SIGTERM to the server's whole process GROUP.
  async function stopLikeTheHost(mode: "plain" | "bounded"): Promise<{ childPid: number; survived: boolean }> {
    const server = Bun.spawn(["bun", join(import.meta.dir, "bounded-spawn.shutdown.fixture.ts"), mode], {
      stdout: "pipe", stderr: "ignore", detached: true, // its own group, like the server under topics-host
    });
    const reader = server.stdout.getReader();
    let text = "";
    while (!/CHILD \d+/.test(text)) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    const childPid = Number(/CHILD (\d+)/.exec(text)?.[1]);
    expect(childPid).toBeGreaterThan(1);
    try {
      process.kill(-server.pid, "SIGTERM");
      await server.exited;
      await Bun.sleep(900); // the exit hook's grace is 500 ms
      return { childPid, survived: alive(childPid) };
    } finally {
      try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }

  it("a plain Bun.spawn child dies with the group (the behaviour to keep)", async () => {
    expect((await stopLikeTheHost("plain")).survived).toBe(false);
  });

  it("a spawnBounded child is closed by the server's exit hook, not orphaned", async () => {
    expect((await stopLikeTheHost("bounded")).survived).toBe(false);
  });
});
