/**
 * @covers EXTSESS-02, EXTSESS-03
 */
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import fsDefault from "node:fs";
import * as fsPromises from "node:fs/promises";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { scanJcodeSessions } from "./external-jcode-sessions";
import { scanAllExternalSessions, type SessionProvider } from "./external-sessions-registry";
import type { ExternalClaudeSession } from "./external-claude-sessions";

const NOW = 1_700_000_000_000;

function makeSessionsDir(): string {
  return mkdtempSync(join(tmpdir(), "jcode-sessions-"));
}

/** Writes a jcode session the way jcode writes it, and pins its mtime. */
function writeSession(
  dir: string,
  name: string,
  d: { status?: string; pid?: number | null; cwd?: string; minutesAgo?: number },
): string {
  const p = join(dir, `${name}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      id: name,
      status: d.status ?? "Active",
      last_pid: d.pid === undefined ? 4242 : d.pid,
      working_dir: d.cwd ?? "/tmp/progetto",
      updated_at: new Date(NOW).toISOString(),
    }),
  );
  const t = (NOW - (d.minutesAgo ?? 0) * 60_000) / 1000;
  utimesSync(p, t, t);
  return p;
}

const alive = () => true;
const dead = () => false;

describe("le sessioni jcode entrano nel censimento", () => {
  test("una sessione con processo vivo e movimento recente e' attiva", () => {
    const dir = makeSessionsDir();
    writeSession(dir, "session_alfa", { minutesAgo: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r).toHaveLength(1);
    expect(r[0]!.state).toBe("active");
    expect(r[0]!.entrypoint).toBe("jcode");
    expect(r[0]!.cwd).toBe("/tmp/progetto");
  });

  test("il pid da solo non basta: il server jcode e' CONDIVISO", () => {
    // The same pid shows up on hundreds of sessions and stays alive for days.
    // Without the constraint on age, every conversation ever opened would look
    // like it is at work — which is the easiest way to replace one wrong
    // number with another wrong number.
    const dir = makeSessionsDir();
    writeSession(dir, "session_vecchia", { minutesAgo: 120 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r[0]!.state).toBe("idle");
  });

  test("un processo che non risponde piu' rende la sessione idle", () => {
    const dir = makeSessionsDir();
    writeSession(dir, "session_orfana", { minutesAgo: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: dead });
    expect(r[0]!.state).toBe("idle");
  });

  test("una sessione che jcode non dice Active non e' al lavoro", () => {
    const dir = makeSessionsDir();
    writeSession(dir, "session_chiusa", { status: "Completed", minutesAgo: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r[0]!.state).toBe("idle");
  });

  test("un file a meta' scrittura non fa sparire le altre sessioni", () => {
    const dir = makeSessionsDir();
    writeSession(dir, "session_buona", { minutesAgo: 1 });
    writeFileSync(join(dir, "session_rotta.json"), "{ questo non e' JSON");
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r).toHaveLength(1);
    expect(r[0]!.sessionId).toBe("session_buona");
  });

  test("una sessione senza working_dir viene saltata invece di inventarne uno", () => {
    const dir = makeSessionsDir();
    const p = join(dir, "session_senzacwd.json");
    writeFileSync(p, JSON.stringify({ id: "x", status: "Active", last_pid: 1 }));
    utimesSync(p, NOW / 1000, NOW / 1000);
    expect(scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive })).toHaveLength(0);
  });

  test("le conversazioni vecchie non compaiono affatto", () => {
    // Without a window the census reported 207 sessions, of which 12 were
    // touched in the last 24 hours: a number that answers «how much have I
    // used jcode», not «who is working right now».
    const dir = makeSessionsDir();
    writeSession(dir, "session_oggi", { minutesAgo: 30 });
    writeSession(dir, "session_settimana_scorsa", { minutesAgo: 60 * 24 * 7 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r.map((s) => s.sessionId)).toEqual(["session_oggi"]);
  });

  test("una directory che non esiste da zero sessioni, non un errore", () => {
    expect(scanJcodeSessions({ sessionsDir: "/tmp/questa-non-esiste-mai", now: NOW })).toEqual([]);
  });

  test("legge il ramo git quando il cwd e' un checkout", () => {
    const dir = makeSessionsDir();
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeSession(dir, "session_repo", { cwd: repo, minutesAgo: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    expect(r[0]!.branch).toBe("main");
  });

  test("attribuisce la sessione al progetto che contiene il suo cwd", () => {
    // The real defect, found live on 08/23: the scanner set a fixed
    // `projectPath: null`, and ALL 13 jcode sessions came out as orphans —
    // including the ones opened inside topics-app itself. A session without a
    // project disappears from the badge on the board and from the dispatcher's
    // guard, which then drops an agent where somebody is already working.
    const dir = makeSessionsDir();
    writeSession(dir, "s1", { cwd: "/Users/x/Progetti/topics-app/client", minutesAgo: 1 });
    const [s] = scanJcodeSessions({
      sessionsDir: dir,
      now: NOW,
      isAlive: alive,
      candidatePaths: ["/Users/x", "/Users/x/Progetti/topics-app"],
      projectIdFor: (p) => `id:${p}`,
    });
    // The LONGEST root that contains the cwd, not the first one that matches.
    expect(s!.projectPath).toBe("/Users/x/Progetti/topics-app");
    expect(s!.projectId).toBe("id:/Users/x/Progetti/topics-app");
  });

  test("un cwd fuori da ogni progetto noto resta senza progetto", () => {
    const dir = makeSessionsDir();
    writeSession(dir, "s1", { cwd: "/Users/x/Musica", minutesAgo: 1 });
    const [s] = scanJcodeSessions({
      sessionsDir: dir,
      now: NOW,
      isAlive: alive,
      candidatePaths: ["/Users/x/Progetti/topics-app"],
      projectIdFor: (p) => p,
    });
    expect(s!.projectPath).toBeNull();
    expect(s!.projectId).toBeNull();
  });
});

describe("il registro tiene insieme piu' provider", () => {
  const fakeSession = (id: string, ms: number): ExternalClaudeSession => ({
    sessionId: id,
    cwd: "/tmp/x",
    projectPath: null,
    projectId: null,
    branch: null,
    entrypoint: "test",
    lastActivityMs: ms,
    state: "active",
    transcriptPath: `/tmp/${id}`,
  });

  const opts = {
    knownSessionIds: new Set<string>(),
    candidatePaths: [],
    nowMs: NOW,
    projectIdFor: () => "",
  };

  test("unisce le sessioni di tutti i provider, piu' recenti per prime", () => {
    const providers: SessionProvider[] = [
      { name: "uno", scan: () => [fakeSession("a", NOW - 5000)] },
      { name: "due", scan: () => [fakeSession("b", NOW - 1000)] },
    ];
    const r = scanAllExternalSessions({ ...opts, providers });
    expect(r.map((s) => s.sessionId)).toEqual(["b", "a"]);
  });

  test("un provider che esplode non spegne gli altri", () => {
    const errors: string[] = [];
    const providers: SessionProvider[] = [
      { name: "rotto", scan: () => { throw new Error("disco illeggibile"); } },
      { name: "sano", scan: () => [fakeSession("c", NOW)] },
    ];
    const r = scanAllExternalSessions({ ...opts, providers, log: (m) => errors.push(m) });
    expect(r.map((s) => s.sessionId)).toEqual(["c"]);
    expect(errors[0]).toContain("rotto");
  });

  test("le sessioni che Topics gia' possiede non sono esterne", () => {
    const providers: SessionProvider[] = [{ name: "uno", scan: () => [fakeSession("mia", NOW)] }];
    const r = scanAllExternalSessions({
      ...opts,
      knownSessionIds: new Set(["mia"]),
      providers,
    });
    expect(r).toHaveLength(0);
  });

  test("lo stesso id da due provider si conta una volta sola", () => {
    const providers: SessionProvider[] = [
      { name: "uno", scan: () => [fakeSession("dup", NOW)] },
      { name: "due", scan: () => [fakeSession("dup", NOW - 1)] },
    ];
    expect(scanAllExternalSessions({ ...opts, providers })).toHaveLength(1);
  });
});

describe("a session file is parsed once per rewrite, not at every census", () => {
  test("an unchanged file is not read again, a rewritten one is", () => {
    const dir = makeSessionsDir();
    const p = writeSession(dir, "cached", { status: "Active" });
    const scan = () => scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive })[0]?.state;
    expect(scan()).toBe("active");

    // Same size, same mtime, different bytes: only a remembered parse still says active.
    const same = JSON.stringify({ id: "cached", status: "Idle!!", last_pid: 4242, working_dir: "/tmp/progetto", updated_at: new Date(NOW).toISOString() });
    writeFileSync(p, same);
    utimesSync(p, NOW / 1000, NOW / 1000);
    expect(scan()).toBe("active");

    // The rewrite jcode does at the end of a turn changes the size or the mtime.
    writeSession(dir, "cached", { status: "Idle", minutesAgo: 0.5 });
    expect(scan()).toBe("idle");
  });

  // The census runs every few seconds: once known, an unchanged file costs a
  // stat, not a read. Reading the 11 MB file again at every census costs a
  // few ms, as much as a loaded machine adds, so no time can tell (24/10: it
  // passed one run in two against a ratio of times). Two checks, for the two
  // ways a read can hide.
  // 1. The known files are made unreadable (`chmod 000`): a census that still
  //    returns all 200 sessions read none of them in its own path, through
  //    whatever API (stat needs no read permission). This half holds only
  //    where `chmod 000` takes the read away: as root, or on Windows, the
  //    files stay readable and it proves nothing. CI runs as the runner user
  //    on Ubuntu, where it holds; on a Windows PC the test still passes, with
  //    the second check alone.
  // 2. A read in the background whose error is swallowed loses no session, so
  //    the ways to read or open a file are spied while the census runs and
  //    while the queue behind it drains (50 ms: `setImmediate`, promises and
  //    short timers run before it): `Bun.file`, `Bun.mmap`, and, on `fs`, on
  //    the default `fs` object (what `require` returns) and on
  //    `node:fs/promises` (a spy on the named import does not see the other
  //    two), `readFileSync`, `readFile`, `createReadStream`, and the opens
  //    `openSync`, `open` and `promises.open`. Every other read starts from
  //    an open (`readSync`, a callback `read`, a FileHandle's `read`), so
  //    opening is what is watched, not each read after it. Not seen: a read in
  //    the background that starts later than the 50 ms window, and a file
  //    reached by other means (a child process, `Bun.$`).
  // The files stay unreadable to the end of the file, the directory is this
  // file's own and is never read again. Then the file jcode rewrites at the
  // end of a turn is read again, and only that one.
  test("a census of 200 known files, one of 11 MB, opens none of them; a rewritten file is read alone", async () => {
    const dir = makeSessionsDir();
    // The size measured on 25/09, with the transcript where jcode keeps it: before the fields.
    const big = join(dir, "big.json");
    const messages = Array.from({ length: 11_000 }, (_, i) => ({ id: `m${i}`, role: "user", content: "x".repeat(1000) }));
    writeFileSync(big, JSON.stringify({ id: "big", messages, working_dir: "/tmp/progetto", status: "Active", last_pid: 4242 }));
    utimesSync(big, NOW / 1000, NOW / 1000);
    for (let i = 0; i < 199; i++) writeSession(dir, `small-${i}`, { minutesAgo: i });

    // What `run` returns, and the session files read or opened while it ran or after, with their size.
    const readsDuring = async <T>(run: () => T) => {
      const readers: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }> = [
        spyOn(Bun, "file"),
        spyOn(Bun, "mmap"),
        ...[fs, fsDefault].flatMap((api) => [
          spyOn(api, "readFileSync"),
          spyOn(api, "readFile"),
          spyOn(api, "createReadStream"),
          spyOn(api, "openSync"),
          spyOn(api, "open"),
        ]),
        spyOn(fs.promises, "readFile"),
        spyOn(fsPromises, "readFile"),
        spyOn(fs.promises, "open"),
        spyOn(fsPromises, "open"),
      ];
      try {
        const result = run();
        // setImmediate, promises and short timers run before this one.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const reads = readers
          .flatMap((reader) => reader.mock.calls.map(([path]) => String(path)))
          .filter((path) => path.startsWith(dir))
          .map((path) => `${basename(path)}: ${fs.statSync(path).size} bytes`);
        return { result, reads };
      } finally {
        for (const reader of readers) reader.mockRestore();
      }
    };
    const scan = () => scanJcodeSessions({ sessionsDir: dir, now: NOW, isAlive: alive });
    const ids = scan().map((s) => s.sessionId).sort();
    expect(ids).toHaveLength(200);
    for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o000);
    const again = await readsDuring(scan);
    const found = new Set(again.result.map((s) => s.sessionId));
    // The sessions a census lost because it tried to read their file, and the files read anyway.
    expect({ lost: ids.filter((id) => !found.has(id)), read: again.reads }).toEqual({ lost: [], read: [] });

    chmodSync(join(dir, "small-7.json"), 0o644);
    const changed = writeSession(dir, "small-7", { status: "Idle", minutesAgo: 7 });
    expect((await readsDuring(scan)).reads).toEqual([`small-7.json: ${fs.statSync(changed).size} bytes`]);
  });
});
