/**
 * Lo stream nutre il tetto del turno: una riga che arriva dal processo e' un
 * segno di vita.
 *
 * E' la saldatura che si era staccata. Il tetto di `turn-deadline.ts` misura il
 * SILENZIO e lo sa fare da agosto, ma Muse e Codex lo montavano dentro un
 * wrapper che restituiva solo `clear`: `noteActivity` non usciva, quindi
 * nessuno poteva dire «sto lavorando» e i trenta minuti tornavano a essere di
 * orologio. Il 22/10 una sessione e' morta con «Muse turn timed out after 30
 * minutes» a turno vivo. Un test sul solo modulo non vede questo: va guardato
 * il PROCESSO.
 *
 * La spia e' TRASPARENTE — avvolge l'implementazione vera e conta — quindi se
 * `mock.module` resta montato per i file che seguono nello stesso processo non
 * cambia il comportamento di nessuno (scheda «mock.restore() non ritira un
 * mock.module»).
 *
 * @covers CHAT-REL-03
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initDatabase } from "../db";
import type { StreamHandler } from "./types";
import type { ProviderTurnTimeoutOptions } from "../lib/turn-deadline";

// Gli export VERI si copiano prima del mock: `mock.module` riscrive il
// namespace gia' importato, quindi leggere `vero.armProviderTurnTimeout`
// dentro la spia vorrebbe dire chiamare la spia stessa (stack overflow).
const vero = await import("../lib/turn-deadline");
const reali = { ...vero };
const reale = vero.armProviderTurnTimeout;
let vite = 0;
mock.module("../lib/turn-deadline", () => ({
  ...reali,
  armProviderTurnTimeout: (opts: ProviderTurnTimeoutOptions) => {
    const tetto = reale(opts);
    return { clear: tetto.clear, noteActivity: () => { vite += 1; tetto.noteActivity(); } };
  },
}));

const { MuseProvider } = await import("./muse");
const { CodexProvider } = await import("./codex");
const { _resetMuseBinCache } = await import("../lib/muse-bin");
const { _resetCodexBinCache } = await import("../lib/codex-bin");

let tempRoot: string;
const prima = {
  MUSE_BIN: process.env.MUSE_BIN, CODEX_BIN: process.env.CODEX_BIN,
  CODEX_HOME: process.env.CODEX_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

beforeAll(() => {
  tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "topics-turn-liveness-")));
  initDatabase(join(import.meta.dir, "..", ".."), tempRoot);
  process.env.XDG_DATA_HOME = join(tempRoot, "xdg");
  process.env.CODEX_HOME = join(tempRoot, "codex-home");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });

  const muse = join(tempRoot, "fake-muse");
  const fixture = join(import.meta.dir, "muse", "fake-muse.fixture.ts");
  writeFileSync(muse, `#!/usr/bin/env bash\nexec "${process.execPath}" "${fixture}" "$@"\n`);
  chmodSync(muse, 0o755);
  process.env.MUSE_BIN = muse;
  _resetMuseBinCache();

  const codex = join(tempRoot, "fake-codex");
  writeFileSync(codex, `#!${process.execPath}
await Bun.stdin.text();
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-liveness" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "vivo" } }));
`, { mode: 0o700 });
  process.env.CODEX_BIN = codex;
  _resetCodexBinCache();
});

afterAll(() => {
  for (const [k, v] of Object.entries(prima)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  _resetMuseBinCache();
  _resetCodexBinCache();
  closeDatabase();
  rmSync(tempRoot, { recursive: true, force: true });
});

function seedTopic(sessionKey: string): void {
  getDatabase().prepare(
    "INSERT INTO topics (id, name, slug, session_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'now', 'now')",
  ).run(sessionKey, sessionKey, sessionKey, sessionKey);
}

function fine(): { handler: StreamHandler; done: Promise<string> } {
  let chiudi!: (r: string) => void;
  const done = new Promise<string>((r) => { chiudi = r; });
  const handler = {
    onTextDelta: () => {}, onToolStart: () => {}, onToolResult: () => {},
    onDone: (m: { result?: string } | undefined) => chiudi(m?.result ?? ""),
    onError: (e: string) => chiudi(`error:${e}`),
    onAborted: () => chiudi("aborted"),
  } as unknown as StreamHandler;
  return { handler, done };
}

function entro<T>(p: Promise<T>, cosa: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`scaduto: ${cosa}`)), 15000))]);
}

describe("il tetto del turno riceve il segno di vita dal processo", () => {
  test("Muse: ogni riga dello stream rimanda indietro il tetto", async () => {
    const sessionKey = "topic:vita-muse";
    seedTopic(sessionKey);
    const provider = new MuseProvider({ type: "muse", defaultWorkspace: tempRoot });
    provider.start();
    const partenza = vite;
    try {
      const t = fine();
      await provider.sendChat(sessionKey, "ciao", t.handler, {});
      expect(await entro(t.done, "onDone")).toContain("echo");
    } finally {
      provider.stop();
    }
    // La fixture emette sette eventi: se il tetto non li vede, resta a zero e
    // i trenta minuti ricominciano a essere di orologio.
    expect(vite - partenza).toBeGreaterThanOrEqual(3);
  });

  test("Codex: ogni riga dello stream rimanda indietro il tetto", async () => {
    const sessionKey = "topic:vita-codex";
    seedTopic(sessionKey);
    const provider = new CodexProvider({ type: "codex", defaultWorkspace: tempRoot });
    const partenza = vite;
    const t = fine();
    await provider.sendChat(sessionKey, "ciao", t.handler, { model: "gpt-test-fixture" });
    expect(await entro(t.done, "onDone")).toContain("vivo");
    expect(vite - partenza).toBeGreaterThanOrEqual(2);
  });
});
