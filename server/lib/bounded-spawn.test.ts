/**
 * `spawnBounded` / `runBounded`: an external process answers or the deadline
 * does, never later, even when a grandchild holds the pipe open.
 * @covers GIT-DEADLINE-01
 */
import { describe, expect, it } from "bun:test";
import { runBounded, spawnBounded } from "./bounded-spawn";

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
    const r = await runBounded(["sh", "-c", "trap '' TERM; sleep 30"], { timeoutMs: 300 });
    const dt = performance.now() - t0;
    expect(r.timedOut).toBe(true);
    expect(dt).toBeLessThan(2000);
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
    const proc = spawnBounded(["sh", "-c", "trap '' TERM; echo parziale; sleep 30"], { stdout: "pipe", stderr: "ignore", timeoutMs: 400 });
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
