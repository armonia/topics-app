import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanJcodeSessions } from "./external-jcode-sessions";
import { scanAllExternalSessions, type SessionProvider } from "./external-sessions-registry";
import type { ExternalClaudeSession } from "./external-claude-sessions";

const ORA = 1_700_000_000_000;

function dirSessioni(): string {
  return mkdtempSync(join(tmpdir(), "jcode-sessions-"));
}

/** Scrive una sessione jcode come la scrive jcode, e ne fissa l'mtime. */
function sessione(
  dir: string,
  nome: string,
  d: { status?: string; pid?: number | null; cwd?: string; minutiFa?: number },
): string {
  const p = join(dir, `${nome}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      id: nome,
      status: d.status ?? "Active",
      last_pid: d.pid === undefined ? 4242 : d.pid,
      working_dir: d.cwd ?? "/tmp/progetto",
      updated_at: new Date(ORA).toISOString(),
    }),
  );
  const t = (ORA - (d.minutiFa ?? 0) * 60_000) / 1000;
  utimesSync(p, t, t);
  return p;
}

const vivo = () => true;
const morto = () => false;

describe("le sessioni jcode entrano nel censimento", () => {
  test("una sessione con processo vivo e movimento recente e' attiva", () => {
    const dir = dirSessioni();
    sessione(dir, "session_alfa", { minutiFa: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r).toHaveLength(1);
    expect(r[0]!.state).toBe("active");
    expect(r[0]!.entrypoint).toBe("jcode");
    expect(r[0]!.cwd).toBe("/tmp/progetto");
  });

  test("il pid da solo non basta: il server jcode e' CONDIVISO", () => {
    // Lo stesso pid compare su centinaia di sessioni e resta vivo per giorni.
    // Senza il vincolo sull'eta', ogni conversazione mai aperta risulterebbe
    // al lavoro — che e' il modo piu' facile di sostituire un numero sbagliato
    // con un altro numero sbagliato.
    const dir = dirSessioni();
    sessione(dir, "session_vecchia", { minutiFa: 120 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r[0]!.state).toBe("idle");
  });

  test("un processo che non risponde piu' rende la sessione idle", () => {
    const dir = dirSessioni();
    sessione(dir, "session_orfana", { minutiFa: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: morto });
    expect(r[0]!.state).toBe("idle");
  });

  test("una sessione che jcode non dice Active non e' al lavoro", () => {
    const dir = dirSessioni();
    sessione(dir, "session_chiusa", { status: "Completed", minutiFa: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r[0]!.state).toBe("idle");
  });

  test("un file a meta' scrittura non fa sparire le altre sessioni", () => {
    const dir = dirSessioni();
    sessione(dir, "session_buona", { minutiFa: 1 });
    writeFileSync(join(dir, "session_rotta.json"), "{ questo non e' JSON");
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r).toHaveLength(1);
    expect(r[0]!.sessionId).toBe("session_buona");
  });

  test("una sessione senza working_dir viene saltata invece di inventarne uno", () => {
    const dir = dirSessioni();
    const p = join(dir, "session_senzacwd.json");
    writeFileSync(p, JSON.stringify({ id: "x", status: "Active", last_pid: 1 }));
    utimesSync(p, ORA / 1000, ORA / 1000);
    expect(scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo })).toHaveLength(0);
  });

  test("le conversazioni vecchie non compaiono affatto", () => {
    // Senza finestra il censimento riportava 207 sessioni, di cui 12 toccate
    // nelle ultime 24 ore: un numero che risponde a «quanto ho usato jcode»,
    // non a «chi sta lavorando adesso».
    const dir = dirSessioni();
    sessione(dir, "session_oggi", { minutiFa: 30 });
    sessione(dir, "session_settimana_scorsa", { minutiFa: 60 * 24 * 7 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r.map((s) => s.sessionId)).toEqual(["session_oggi"]);
  });

  test("una directory che non esiste da zero sessioni, non un errore", () => {
    expect(scanJcodeSessions({ sessionsDir: "/tmp/questa-non-esiste-mai", now: ORA })).toEqual([]);
  });

  test("legge il ramo git quando il cwd e' un checkout", () => {
    const dir = dirSessioni();
    const repo = mkdtempSync(join(tmpdir(), "repo-"));
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    sessione(dir, "session_repo", { cwd: repo, minutiFa: 1 });
    const r = scanJcodeSessions({ sessionsDir: dir, now: ORA, isAlive: vivo });
    expect(r[0]!.branch).toBe("main");
  });
});

describe("il registro tiene insieme piu' provider", () => {
  const finta = (id: string, ms: number): ExternalClaudeSession => ({
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
    nowMs: ORA,
    projectIdFor: () => "",
  };

  test("unisce le sessioni di tutti i provider, piu' recenti per prime", () => {
    const providers: SessionProvider[] = [
      { name: "uno", scan: () => [finta("a", ORA - 5000)] },
      { name: "due", scan: () => [finta("b", ORA - 1000)] },
    ];
    const r = scanAllExternalSessions({ ...opts, providers });
    expect(r.map((s) => s.sessionId)).toEqual(["b", "a"]);
  });

  test("un provider che esplode non spegne gli altri", () => {
    const errori: string[] = [];
    const providers: SessionProvider[] = [
      { name: "rotto", scan: () => { throw new Error("disco illeggibile"); } },
      { name: "sano", scan: () => [finta("c", ORA)] },
    ];
    const r = scanAllExternalSessions({ ...opts, providers, log: (m) => errori.push(m) });
    expect(r.map((s) => s.sessionId)).toEqual(["c"]);
    expect(errori[0]).toContain("rotto");
  });

  test("le sessioni che Topics gia' possiede non sono esterne", () => {
    const providers: SessionProvider[] = [{ name: "uno", scan: () => [finta("mia", ORA)] }];
    const r = scanAllExternalSessions({
      ...opts,
      knownSessionIds: new Set(["mia"]),
      providers,
    });
    expect(r).toHaveLength(0);
  });

  test("lo stesso id da due provider si conta una volta sola", () => {
    const providers: SessionProvider[] = [
      { name: "uno", scan: () => [finta("dup", ORA)] },
      { name: "due", scan: () => [finta("dup", ORA - 1)] },
    ];
    expect(scanAllExternalSessions({ ...opts, providers })).toHaveLength(1);
  });
});
