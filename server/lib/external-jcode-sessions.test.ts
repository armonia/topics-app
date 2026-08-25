/**
 * @covers EXTSESS-02, EXTSESS-03
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
