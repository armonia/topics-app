/**
 * @covers BRIDGE-01
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import net from "node:net";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test for server/ai-bridge.mjs — the detached broker daemon.
// Uses `cat` as a clean-pipe child (echoes stdin→stdout, no PTY) so we can
// assert the offset/replay/idempotency contract deterministically.

const SOCK = join(tmpdir(), `ai-bridge-test-${process.pid}.sock`);
let storeDir = "";
let daemon: ReturnType<typeof Bun.spawn> | null = null;

/** One NDJSON socket connection with a frame queue + async waiter. */
function connect(): Promise<{
  send: (m: object) => void;
  next: (pred: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    const frames: any[] = [];
    const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        const wi = waiters.findIndex((w) => w.pred(m));
        if (wi >= 0) { const [w] = waiters.splice(wi, 1); w.resolve(m); }
        else frames.push(m);
      }
    });
    sock.on("error", reject);
    sock.on("connect", () => resolve({
      send: (m) => sock.write(JSON.stringify(m) + "\n"),
      next: (pred, timeoutMs = 3000) => new Promise((res, rej) => {
        const hit = frames.findIndex(pred);
        if (hit >= 0) { const [m] = frames.splice(hit, 1); return res(m); }
        // A timed-out waiter must LEAVE the queue: the data handler matches
        // waiters before frames, so a dead one silently eats the next frame it
        // matches — the assertion after an intentional timeout then fails on a
        // frame that did arrive.
        const w = { pred, resolve: (m: any) => { clearTimeout(t); res(m); } };
        const t = setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          rej(new Error("frame timeout"));
        }, timeoutMs);
        waiters.push(w);
      }),
      close: () => sock.destroy(),
    }));
  });
}

const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

beforeAll(async () => {
  storeDir = mkdtempSync(join(tmpdir(), "ai-bridge-store-"));
  daemon = Bun.spawn([process.execPath, join(import.meta.dir, "ai-bridge.mjs"), "--socket", SOCK, "--store-dir", storeDir], {
    stdout: "ignore", stderr: "inherit",
  });
  // Wait for the socket FILE to exist first — net.connect to a not-yet-created
  // unix path can hang rather than error under Bun, so never connect blind.
  for (let i = 0; i < 100 && !existsSync(SOCK); i++) await new Promise((r) => setTimeout(r, 100));
  const c = await connect();
  c.close();
}, 20000);

afterAll(() => {
  try { daemon?.kill(); } catch {}
  try { rmSync(storeDir, { recursive: true, force: true }); } catch {}
});

describe("ai-bridge daemon", () => {
  test("spawn → write echoes back as offset-addressed data frames; attach replays losslessly", async () => {
    const c = await connect();
    const id = "topic:echo1";
    c.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    const spawned = await c.next((m) => m.type === "spawned" && m.id === id);
    expect(typeof spawned.pid).toBe("number");

    c.send({ type: "write", id, data: "line1\n" });
    const d1 = await c.next((m) => m.type === "data" && m.id === id);
    expect(d1.offset).toBe(0);
    expect(b64(d1.chunk)).toBe("line1\n");

    c.send({ type: "write", id, data: "line2\n" });
    const d2 = await c.next((m) => m.type === "data" && m.id === id && m.offset === 6);
    expect(b64(d2.chunk)).toBe("line2\n");

    // A SECOND client attaches from 0 → gets the whole buffer replayed, line-aligned.
    const c2 = await connect();
    c2.send({ type: "attach", id, fromOffset: 0 });
    const replay = await c2.next((m) => m.type === "data" && m.id === id);
    expect(b64(replay.chunk)).toBe("line1\nline2\n");
    const ack = await c2.next((m) => m.type === "attached" && m.id === id);
    expect(ack.endOffset).toBe(12);
    expect(ack.alive).toBe(true);

    // Attach from a mid-offset → only the tail.
    const c3 = await connect();
    c3.send({ type: "attach", id, fromOffset: 6 });
    const tail = await c3.next((m) => m.type === "data" && m.id === id);
    expect(b64(tail.chunk)).toBe("line2\n");

    c.close(); c2.close(); c3.close();
  });

  test("spawn is idempotent per id (never a second child on the same transcript)", async () => {
    const c = await connect();
    const id = "topic:idem1";
    c.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    const first = await c.next((m) => m.type === "spawned" && m.id === id);
    c.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    const second = await c.next((m) => m.type === "spawned" && m.id === id);
    expect(second.resumed).toBe(true);
    expect(second.pid).toBe(first.pid);
    c.close();
  });

  // Regression (2026-07-29): a restarted server re-spawns onto the child the
  // daemon kept alive. The idempotent branch acked the pid but left the new
  // socket OUT of `attached`, so the child's answers went nowhere and the chat
  // hung on "stream lento — il provider è ancora connesso" forever. Whoever
  // spawns must be attached, exactly like the fresh-spawn branch.
  test("re-spawning onto a live session attaches the caller to the live stream", async () => {
    const owner = await connect();
    const id = "topic:idem2";
    owner.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    await owner.next((m) => m.type === "spawned" && m.id === id);
    owner.send({ type: "write", id, data: "before\n" });
    await owner.next((m) => m.type === "data" && m.id === id);

    // A FRESH client (the restarted server) re-spawns the same id.
    const restarted = await connect();
    restarted.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    const ack = await restarted.next((m) => m.type === "spawned" && m.id === id);
    expect(ack.resumed).toBe(true);

    // Live-only: the pre-existing output is NOT replayed into the new caller
    // (it would re-fold earlier turns), but everything from now on IS.
    restarted.send({ type: "write", id, data: "after\n" });
    const live = await restarted.next((m) => m.type === "data" && m.id === id);
    expect(b64(live.chunk)).toBe("after\n");
    expect(live.offset).toBe(7); // "before\n" — not replayed, just skipped

    owner.close(); restarted.close();
  });

  test("list reports the session; kill removes it", async () => {
    const c = await connect();
    const id = "topic:kill1";
    c.send({ type: "spawn", id, cliPath: "cat", args: [], cwd: storeDir, env: {} });
    await c.next((m) => m.type === "spawned" && m.id === id);

    c.send({ type: "list" });
    const list = await c.next((m) => m.type === "list");
    expect(list.sessions.some((s: any) => s.id === id && s.alive)).toBe(true);

    c.send({ type: "kill", id });
    // `killed` is only the ACK that teardown was INITIATED (SIGTERM sent). The
    // session is removed from the map in onDead, which fires when the child
    // actually exits — so wait for the `exit` frame (broadcast immediately
    // before `sessions.delete`) before listing, or the list races the reap.
    await c.next((m) => m.type === "killed" && m.id === id);
    await c.next((m) => m.type === "exit" && m.id === id);

    c.send({ type: "list" });
    const list2 = await c.next((m) => m.type === "list");
    expect(list2.sessions.some((s: any) => s.id === id)).toBe(false);
    c.close();
  });

  test("exit frame fires when the child ends; a late attach still replays the completed output", async () => {
    const c = await connect();
    const id = "topic:done1";
    // `sh -c 'printf ...'` writes then exits → completed-while-down analogue.
    c.send({ type: "spawn", id, cliPath: "/bin/sh", args: ["-c", "printf 'done-line\\n'"], cwd: storeDir, env: {} });
    await c.next((m) => m.type === "spawned" && m.id === id);
    const exit = await c.next((m) => m.type === "exit" && m.id === id);
    expect(exit.exitCode).toBe(0);
    expect(exit.endOffset).toBe(10);

    // Late attach after exit → the buffer is still replayable (Case 1).
    const c2 = await connect();
    c2.send({ type: "attach", id, fromOffset: 0 });
    const replay = await c2.next((m) => m.type === "data" && m.id === id);
    expect(b64(replay.chunk)).toBe("done-line\n");
    const ack = await c2.next((m) => m.type === "attached" && m.id === id);
    expect(ack.alive).toBe(false);
    expect(ack.exitCode).toBe(0);
    c.close(); c2.close();
  });
});

// Il replay non è più UN frame grande quanto lo store.
//
// Prima: `readFileSync` dell'intero file, `subarray`, base64 di tutto, una riga
// JSON sola. Su uno store di produzione da 7 MB sono ~9,8 MB su una riga, ~25 MB
// di stringhe temporanee per attach, e dall'altra parte un `JSON.parse` di quella
// taglia prima che UN byte diventi utile. Misurato col banco
// (`scripts/ai-bridge-replay-bench.ts`): sei attach così mettono in coda 44 MB su
// un socket solo e le risposte escono a scaletta fino a 5s — mentre il daemon,
// interrogato da un altro processo, risponde a un ping in 4 ms.
//
// Il contratto che questi test difendono è che tagliare non cambia NIENTE di
// osservabile a parte la taglia dei frame: stessi byte, stesso ordine, offset
// contigui, e zero byte quando non c'è niente da rimandare.
describe("ai-bridge replay a fette", () => {
  const SLICE = 1024 * 1024; // deve restare allineato a REPLAY_SLICE_BYTES

  test("uno store da 3 MB arriva in più frame, contigui e byte-identici", async () => {
    const id = "topic:slice1";
    const riga = JSON.stringify({ type: "stream_event", text: "à".repeat(200) }) + "\n";
    const contenuto = riga.repeat(Math.ceil((3 * 1024 * 1024) / Buffer.byteLength(riga)));
    const big = join(storeDir, "big.ndjson");
    writeFileSync(big, contenuto, "utf8");
    const totale = Buffer.byteLength(contenuto);

    const c = await connect();
    c.send({ type: "spawn", id, cliPath: "/bin/sh", args: ["-c", `cat ${big}`], cwd: storeDir, env: {} });
    await c.next((m) => m.type === "spawned" && m.id === id);
    const exit = await c.next((m) => m.type === "exit" && m.id === id, 15_000);
    expect(exit.endOffset).toBe(totale);

    // Un client FRESCO riattacca da 0: è la fase 1 di `reattach`.
    const c2 = await connect();
    c2.send({ type: "attach", id, fromOffset: 0 });
    const ack = await c2.next((m) => m.type === "attached" && m.id === id, 15_000);
    expect(ack.endOffset).toBe(totale);

    // I `data` precedono l'ack sullo stesso socket: a questo punto sono tutti
    // già in coda, e si drenano finché non ne resta nessuno.
    const frames: Array<{ offset: number; chunk: string }> = [];
    for (;;) {
      try { frames.push(await c2.next((m) => m.type === "data" && m.id === id, 500)); }
      catch { break; }
    }

    expect(frames.length).toBeGreaterThanOrEqual(3);
    let atteso = 0;
    const pezzi: Buffer[] = [];
    for (const f of frames) {
      expect(f.offset).toBe(atteso);          // contigui: nessun buco, nessuna sovrapposizione
      const buf = Buffer.from(f.chunk, "base64");
      expect(buf.byteLength).toBeLessThanOrEqual(SLICE);
      pezzi.push(buf);
      atteso += buf.byteLength;
    }
    expect(atteso).toBe(totale);
    expect(Buffer.concat(pezzi).equals(Buffer.from(contenuto, "utf8"))).toBe(true);

    c.close(); c2.close();
  }, 40_000);

  test("attach dalla coda esatta non consegna nemmeno un byte", async () => {
    const id = "topic:slice2";
    const c = await connect();
    c.send({ type: "spawn", id, cliPath: "/bin/sh", args: ["-c", "printf 'x\\ny\\n'"], cwd: storeDir, env: {} });
    await c.next((m) => m.type === "spawned" && m.id === id);
    const exit = await c.next((m) => m.type === "exit" && m.id === id);

    const c2 = await connect();
    c2.send({ type: "attach", id, fromOffset: exit.endOffset });
    const ack = await c2.next((m) => m.type === "attached" && m.id === id);
    expect(ack.endOffset).toBe(exit.endOffset);
    await expect(c2.next((m) => m.type === "data" && m.id === id, 400)).rejects.toThrow("frame timeout");
    c.close(); c2.close();
  }, 20_000);
});

// The daemon is spawned detached and unref'd, so nothing in the OS will ever
// clean it up: retiring itself is its ONLY exit path. This used to be broken
// silently — the monitor tested `process.ppid === 1`, which Bun never updates
// after reparenting — and abandoned daemons piled up for days.
describe("ai-bridge orphan monitor", () => {
  // Shrink the monitor tick so tests don't sit through the real 5s production
  // interval. Production never sets TOPICS_AI_BRIDGE_MONITOR_TICK_MS.
  const MONITOR_TICK_MS = 500;
  const FAST_ENV = { TOPICS_AI_BRIDGE_MONITOR_TICK_MS: String(MONITOR_TICK_MS) };

  /** Poll until `pred` holds or the deadline passes. */
  async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return pred();
  }

  test("a daemon whose --parent-pid is dead shuts down once no client is connected", async () => {
    const sock = join(tmpdir(), `ai-bridge-orphan-${process.pid}.sock`);
    const store = mkdtempSync(join(tmpdir(), "ai-bridge-orphan-store-"));
    // A PID that is certainly dead: spawn something trivial and reap it.
    const corpse = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
    await corpse.exited;
    const deadPid = corpse.pid;

    const orphan = Bun.spawn(
      [process.execPath, join(import.meta.dir, "ai-bridge.mjs"),
        "--socket", sock, "--store-dir", store, "--parent-pid", String(deadPid)],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...FAST_ENV, TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS: "1000" } },
    );
    try {
      expect(await until(() => existsSync(sock), 10_000)).toBe(true);
      // Monitor ticks at MONITOR_TICK_MS, then a 1s grace: 8s is ample headroom.
      let exited = false;
      void orphan.exited.then(() => { exited = true; });
      expect(await until(() => exited, 8_000)).toBe(true);
      // A clean shutdown() unlinks its socket; a stale one would strand it.
      expect(existsSync(sock)).toBe(false);
    } finally {
      try { orphan.kill(); } catch { /* already gone — that's the pass case */ }
      try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 20_000);

  test("a probe that connects and closes does NOT renew the orphan's lease", async () => {
    // How the immortal daemons survived. Every bridge that tries to be born runs
    // checkExistingBridge(), which connects here and closes within milliseconds.
    // The monitor counted any connection as "the server reattached" and cleared
    // the deadline, so ai-bridge/daemon.log on 2026-08-14 alternated "Parent died
    // … exit in 90s" and "Server reconnected" forever, with pid 41214 still alive
    // 12 minutes in — dead parent, zero peers on its socket.
    const sock = join(tmpdir(), `ai-bridge-probe-${process.pid}.sock`);
    const store = mkdtempSync(join(tmpdir(), "ai-bridge-probe-store-"));
    const corpse = Bun.spawn(["/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
    await corpse.exited;

    const orphan = Bun.spawn(
      [process.execPath, join(import.meta.dir, "ai-bridge.mjs"),
        "--socket", sock, "--store-dir", store, "--parent-pid", String(corpse.pid)],
      { stdout: "ignore", stderr: "ignore", env: {
        ...process.env,
        ...FAST_ENV,
        TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS: "1000",
        // A real probe lasts ~1s (connect → ping → pong → close); the threshold
        // sits above it, so the probes below never count as a server.
        TOPICS_AI_BRIDGE_REAL_CLIENT_MS: "3000",
      } },
    );
    let probing: ReturnType<typeof setInterval> | null = null;
    const open = new Set<ReturnType<typeof net.connect>>();
    try {
      expect(await until(() => existsSync(sock), 10_000)).toBe(true);
      let exited = false;
      void orphan.exited.then(() => { exited = true; });
      // OVERLAPPING probes: each holds for a second, a new one every 800ms. The
      // socket is never free — the buggy version never even armed its deadline —
      // yet no single connection reaches 3s, so none of them is a server.
      probing = setInterval(() => {
        const probe = net.connect(sock);
        open.add(probe);
        probe.on("error", () => { /* il ponte se n'è andato: è il caso di successo */ });
        setTimeout(() => { open.delete(probe); probe.destroy(); }, 1_000).unref();
      }, 800);
      // With MONITOR_TICK_MS=500ms, ORPHAN_GRACE_MS=1s, and one REAL_CLIENT_MS*2
      // extension: at most ~8s total.
      expect(await until(() => exited, 15_000)).toBe(true);
    } finally {
      if (probing) clearInterval(probing);
      for (const p of open) { try { p.destroy(); } catch { /* già chiuso */ } }
      try { orphan.kill(); } catch { /* already gone — that's the pass case */ }
      try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 25_000);

  test("a daemon with a LIVE parent stays up", async () => {
    const sock = join(tmpdir(), `ai-bridge-live-${process.pid}.sock`);
    const store = mkdtempSync(join(tmpdir(), "ai-bridge-live-store-"));
    // Our own PID is alive by definition.
    const daemon2 = Bun.spawn(
      [process.execPath, join(import.meta.dir, "ai-bridge.mjs"),
        "--socket", sock, "--store-dir", store, "--parent-pid", String(process.pid)],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, ...FAST_ENV, TOPICS_AI_BRIDGE_ORPHAN_GRACE_MS: "1000" } },
    );
    try {
      expect(await until(() => existsSync(sock), 10_000)).toBe(true);
      let exited = false;
      void daemon2.exited.then(() => { exited = true; });
      // With MONITOR_TICK_MS=500ms: well past several ticks + grace — still there.
      await new Promise((r) => setTimeout(r, 3_000));
      expect(exited).toBe(false);
    } finally {
      try { daemon2.kill(); } catch { /* ignore */ }
      try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 15_000);
});
