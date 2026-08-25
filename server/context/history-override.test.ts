/**
 * `historyOverride` — la history che il chiamante impone, invece del thread letto
 * dalla tabella.
 *
 * Esiste per edit/regenerate (`server/routes/edit.ts`): rigenerando una risposta il
 * modello non deve vedere quella che sta rimpiazzando, e il taglio all'ancora non è
 * esprimibile con una query. Senza questo parametro quel percorso non poteva usare
 * l'envelope, e infatti si era messo a ricostruire i blocchi di sistema a mano —
 * perdendone sette e ignorando i toggle dell'inspector.
  * @covers CTX-OVERRIDE-01
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppContext, StoredMessage, Topic } from "../types";
import { assembleTopicContext } from "./assemble";
import { adaptEnvelope } from "./adapt";

const ROOT = join(
  process.env.TMPDIR ?? "/tmp",
  `history-override-${Math.floor(process.uptime() * 1000)}`,
);

function msg(id: string, role: "user" | "assistant", content: string): StoredMessage {
  return { id, role, content, timestamp: "2026-01-01T00:00:00Z" } as StoredMessage;
}

function makeCtx(opts: { topic: Topic; dbMessages: StoredMessage[]; projectDir?: string }): AppContext {
  return {
    BASE_DIR: ROOT,
    OPENCLAW_DIR: join(ROOT, "openclaw"),
    getTopicBySessionKey: (sk: string) => (opts.topic.sessionKey === sk ? opts.topic : null),
    loadLocalMessages: () => opts.dbMessages,
    loadTopics: () => ({ topics: { [opts.topic.id]: opts.topic } }),
    resolveTopicCwd: () => opts.projectDir ?? null,
    db: new Database(":memory:"),
  } as unknown as AppContext;
}

const TOPIC: Topic = {
  id: "t1",
  name: "Chat",
  sessionKey: "topic:t1",
  systemPrompt: "sei un assistente",
  projectPath: null,
} as unknown as Topic;

// Il thread come sta a DB: il ramo attivo include la vecchia risposta.
const DB_THREAD = [
  msg("u1", "user", "prima domanda"),
  msg("a1", "assistant", "prima risposta"),
  msg("u2", "user", "seconda domanda"),
  msg("a2", "assistant", "RISPOSTA DA RIMPIAZZARE"),
];

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("historyOverride", () => {
  it("assente: la history viene dal thread a DB", () => {
    const ctx = makeCtx({ topic: TOPIC, dbMessages: DB_THREAD });
    const env = assembleTopicContext(ctx, {
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
    });
    expect(env.history.map((m) => m.content)).toContain("RISPOSTA DA RIMPIAZZARE");
  });

  it("presente: il modello non vede la risposta che sta rimpiazzando", () => {
    const ctx = makeCtx({ topic: TOPIC, dbMessages: DB_THREAD });
    // Quello che fa edit.ts su regenerate: taglia all'ancora (u2).
    const troncato = DB_THREAD.slice(0, 3);
    const env = assembleTopicContext(ctx, {
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
      userMessageOverride: { content: "seconda domanda", messageId: "u2" },
      includeLastUserInHistory: false,
      historyOverride: troncato,
    });
    const contents = env.history.map((m) => m.content);
    expect(contents).not.toContain("RISPOSTA DA RIMPIAZZARE");
    expect(contents).toContain("prima risposta");
    // L'ancora esce dalla history: la passa il chiamante come userContent.
    expect(contents).not.toContain("seconda domanda");
    expect(env.userMessage.content).toBe("seconda domanda");
  });

  it("il conteggio dei messaggi in sessionMeta riflette l'override", () => {
    const ctx = makeCtx({ topic: TOPIC, dbMessages: DB_THREAD });
    const env = assembleTopicContext(ctx, {
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
      historyOverride: DB_THREAD.slice(0, 2),
    });
    expect(env.sessionMeta?.totalStoredMessages).toBe(2);
  });
});

describe("edit/regenerate erediteranno i blocchi che ricostruiva a mano", () => {
  it("il preambolo porta project-awareness, che la vecchia ricostruzione non emetteva", () => {
    const projectDir = join(ROOT, "proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "# Progetto\nrighe.");
    const topic = { ...TOPIC, projectPath: projectDir } as Topic;
    const ctx = makeCtx({ topic, dbMessages: DB_THREAD, projectDir });

    const env = assembleTopicContext(ctx, {
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
      userMessageOverride: { content: "rigenera", messageId: "u2" },
      includeLastUserInHistory: false,
      historyOverride: DB_THREAD.slice(0, 3),
    });
    const payload = adaptEnvelope(env);
    const systemText = (payload.history ?? []).filter((m) => m.role === "system").map((m) => m.content).join("\n");

    // Il blocco load-bearing: dove sta lavorando. La vecchia ricostruzione in
    // edit.ts emetteva i template ma NON la frase di awareness col cwd.
    expect(systemText).toContain("You are working in the project");
    expect(systemText).toContain("# Progetto");
    expect(systemText).toContain("sei un assistente");
  });

  it("un template disattivato nell'inspector NON rientra", () => {
    const projectDir = join(ROOT, "proj2");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "README.md"), "TESTO-DEL-README");
    const topic = {
      ...TOPIC,
      projectPath: projectDir,
      disabledContextSources: ["template:README.md"],
    } as unknown as Topic;
    const ctx = makeCtx({ topic, dbMessages: DB_THREAD, projectDir });

    const env = assembleTopicContext(ctx, {
      sessionKey: "topic:t1",
      providerName: "claude",
      providerStrategy: "history-aware",
      historyOverride: DB_THREAD.slice(0, 3),
    });
    const systemText = adaptEnvelope(env).history!.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    expect(systemText).not.toContain("TESTO-DEL-README");
  });
});
