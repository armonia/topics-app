import { describe, expect, it } from "bun:test";

import type { CodexFs } from "./external-codex-sessions";
import { scanCodexSessions } from "./external-codex-sessions";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = 1_700_000_000_000;

/** A fake file: head (session_meta) + tail lines. */
function transcript(meta: Record<string, unknown>, tailLines: unknown[]): string {
  const head = JSON.stringify({ type: "session_meta", payload: meta });
  return [head, ...tailLines.map((l) => JSON.stringify(l))].join("\n");
}

const META = { session_id: "sess-1", cwd: "/Users/x/Projects/topics-app", originator: "codex-tui" };
const WORKING = [{ type: "event_msg", payload: { type: "task_started" } }];
const FINISHED = [{ type: "event_msg", payload: { type: "task_complete" } }];

/**
 * A fake `sessions/YYYY/MM/DD/file.jsonl` tree.
 * `files`: relative path -> { content, age in ms }.
 */
function fakeFs(files: Record<string, { text: string; ageMs: number }>, dirAges: Record<string, number> = {}): CodexFs {
  const root = "/root";
  return {
    readdir(dir) {
      const prefix = dir === root ? "" : dir.slice(root.length + 1) + "/";
      const names = new Set<string>();
      const dirs = new Set<string>();
      for (const rel of Object.keys(files)) {
        if (!rel.startsWith(prefix)) continue;
        const rest = rel.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) names.add(rest);
        else dirs.add(rest.slice(0, slash));
      }
      return [
        ...[...dirs].map((name) => ({ name, isDir: true })),
        ...[...names].map((name) => ({ name, isDir: false })),
      ];
    },
    stat(path) {
      const rel = path.slice(root.length + 1);
      const f = files[rel];
      if (f) return { mtimeMs: NOW - f.ageMs, size: f.text.length };
      // A directory: explicit age, otherwise the freshest one it contains.
      if (rel in dirAges) return { mtimeMs: NOW - dirAges[rel]!, size: 0 };
      const inside = Object.entries(files).filter(([k]) => k.startsWith(rel + "/"));
      if (!inside.length) return null;
      return { mtimeMs: NOW - Math.min(...inside.map(([, v]) => v.ageMs)), size: 0 };
    },
    read(path, bytes, from) {
      const rel = path.slice(root.length + 1);
      const t = files[rel]?.text ?? "";
      return from === "head" ? t.slice(0, bytes) : t.slice(Math.max(0, t.length - bytes));
    },
  };
}

function scan(files: Record<string, { text: string; ageMs: number }>, extra: Record<string, unknown> = {}) {
  return scanCodexSessions({
    sessionsDir: "/root",
    now: NOW,
    fs: fakeFs(files),
    ...extra,
  });
}

describe("scanCodexSessions", () => {
  it("trova una sessione nell'albero per data", () => {
    const out = scan({
      "2026/08/23/rollout-a.jsonl": { text: transcript(META, WORKING), ageMs: 2 * MIN },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.sessionId).toBe("sess-1");
    expect(out[0]!.cwd).toBe("/Users/x/Projects/topics-app");
    expect(out[0]!.entrypoint).toBe("codex-tui");
  });

  it("una sessione toccata ora e' al lavoro", () => {
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript(META, WORKING), ageMs: 2 * MIN },
    });
    expect(out[0]!.state).toBe("active");
  });

  it("task_complete vince sulla freschezza: turno chiuso = fermo", () => {
    // The opposite defect to jcode's: without reading the end-of-turn event,
    // closing and sitting still counts as «at work» for 15 minutes.
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript(META, FINISHED), ageMs: 1000 },
    });
    expect(out[0]!.state).toBe("idle");
  });

  it("un file vecchio ma dentro la finestra e' idle, non assente", () => {
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript(META, WORKING), ageMs: 2 * HOUR },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.state).toBe("idle");
  });

  it("oltre la finestra la sessione non compare", () => {
    const out = scan({
      "2026/08/20/a.jsonl": { text: transcript(META, WORKING), ageMs: 30 * HOUR },
    });
    expect(out).toHaveLength(0);
  });

  it("le sessioni che Topics gia' possiede restano fuori", () => {
    const out = scan(
      { "2026/08/23/a.jsonl": { text: transcript(META, WORKING), ageMs: MIN } },
      { knownSessionIds: new Set(["sess-1"]) },
    );
    expect(out).toHaveLength(0);
  });

  it("attribuisce il progetto dal cwd, radice piu' lunga", () => {
    const out = scan(
      { "2026/08/23/a.jsonl": { text: transcript(META, WORKING), ageMs: MIN } },
      {
        candidatePaths: ["/Users/x", "/Users/x/Projects/topics-app"],
        projectIdFor: (p: string) => `id:${p}`,
      },
    );
    expect(out[0]!.projectPath).toBe("/Users/x/Projects/topics-app");
    expect(out[0]!.projectId).toBe("id:/Users/x/Projects/topics-app");
  });

  it("il cwd dell'ultimo turno batte quello iniziale", () => {
    // `session_meta` says where the session was BORN; `turn_context` where it
    // is working now. Attributing to the first gets the project wrong after a cd.
    const text = transcript(META, [
      { type: "turn_context", payload: { cwd: "/Users/x/Projects/altro" } },
      { type: "event_msg", payload: { type: "task_started" } },
    ]);
    const out = scan(
      { "2026/08/23/a.jsonl": { text, ageMs: MIN } },
      { candidatePaths: ["/Users/x/Projects/altro"], projectIdFor: (p: string) => p },
    );
    expect(out[0]!.cwd).toBe("/Users/x/Projects/altro");
    expect(out[0]!.projectPath).toBe("/Users/x/Projects/altro");
  });

  it("senza session id la riga non si inventa", () => {
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript({ cwd: "/tmp" }, WORKING), ageMs: MIN },
    });
    expect(out).toHaveLength(0);
  });

  it("una riga corrotta non fa cadere lo scanner", () => {
    const text = transcript(META, WORKING) + "\n{ questo non e' json";
    const out = scan({ "2026/08/23/a.jsonl": { text, ageMs: MIN } });
    expect(out).toHaveLength(1);
  });

  it("una directory che non esiste da' zero sessioni, non un errore", () => {
    expect(scanCodexSessions({ sessionsDir: "/non/esiste", now: NOW })).toEqual([]);
  });

  it("i file vuoti si saltano", () => {
    const out = scan({ "2026/08/23/vuoto.jsonl": { text: "", ageMs: MIN } });
    expect(out).toHaveLength(0);
  });

  it("ignora i file che non sono trascrizioni", () => {
    const out = scan({ "2026/08/23/note.txt": { text: transcript(META, WORKING), ageMs: MIN } });
    expect(out).toHaveLength(0);
  });

  it("le piu' recenti per prime", () => {
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript({ ...META, session_id: "vecchia" }, WORKING), ageMs: 3 * HOUR },
      "2026/08/23/b.jsonl": { text: transcript({ ...META, session_id: "nuova" }, WORKING), ageMs: MIN },
    });
    expect(out.map((s) => s.sessionId)).toEqual(["nuova", "vecchia"]);
  });

  it("trova una sessione recente in una cartella datata giorni prima", () => {
    // The defect the fake files had not caught: Codex files the session under
    // the day it was BORN. Measured on the real disk, sessions written 4 hours
    // ago were sitting in folders from two days earlier: pruning by the
    // folder's date zeroed out the census.
    const out = scan({
      "2026/08/21/vecchia-cartella.jsonl": { text: transcript(META, WORKING), ageMs: 4 * HOUR },
    });
    expect(out).toHaveLength(1);
  });

  it("legge una session_meta piu' grande di 16KB", () => {
    // The `session_meta` carries the base instructions: ~19KB on the real
    // disk. With too short a head the JSON arrives truncated, does not parse,
    // and EVERY Codex session vanishes from the census without an error.
    const oversized = { ...META, base_instructions: "x".repeat(40_000) };
    const out = scan({
      "2026/08/23/a.jsonl": { text: transcript(oversized, WORKING), ageMs: MIN },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.sessionId).toBe("sess-1");
  });

  it("rispetta il limite di sessioni lette", () => {
    const files: Record<string, { text: string; ageMs: number }> = {};
    for (let i = 0; i < 10; i++) {
      files[`2026/08/23/s${i}.jsonl`] = {
        text: transcript({ ...META, session_id: `s${i}` }, WORKING),
        ageMs: (i + 1) * MIN,
      };
    }
    expect(scan(files, { limit: 3 })).toHaveLength(3);
  });
});
