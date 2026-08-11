/**
 * Lo stato della board nel contesto: FRESCO a ogni turno, e mai accumulato.
 *
 * Questa è la decisione che costa dell'orchestratore, e il posto dove si prova.
 * Non basta che lo snapshot sia giusto al turno uno: deve essere l'UNICO nel
 * prompt del turno due. Se quello vecchio resta, il modello legge due verità in
 * contraddizione e non ha modo di sapere quale è di adesso — e quella vecchia,
 * essendo scritta prima, sembra pure la premessa.
 *
 * Il test che conta è `il turno 2 non porta lo snapshot del turno 1`. Perché
 * abbia dei denti, subito sotto c'è la sua controprova: la stessa asserzione
 * eseguita su un prompt costruito ACCUMULANDO fallisce. Un test che non sa
 * diventare rosso non è un test.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AppContext, StoredMessage, Topic } from "../types";
import { assembleTopicContext } from "./assemble";
import { adaptEnvelope } from "./adapt";
import { createTaskService, projectIdForPath } from "../services/tasks";
import { ORCHESTRATOR_MCP_POLICY, orchestratorRolePrompt } from "../services/orchestrator";

/** Un DB con lo schema VERO: lo snapshot legge dal servizio task, non da un mock. */
function migratedDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  const dir = join(import.meta.dir, "..", "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => /^\d+-.+\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(join(dir, file), "utf-8"));
  }
  return db;
}

const ROOT = join(tmpdir(), `board-snapshot-${process.pid}-${Date.now()}`);
const PROJECT_DIR = join(ROOT, "progetto");
const PROJECT_ID = projectIdForPath(PROJECT_DIR);
const SESSION_KEY = "topic:orch0001";

mkdirSync(join(ROOT, "base", "memory"), { recursive: true });
mkdirSync(join(ROOT, "openclaw", "workspace"), { recursive: true });
mkdirSync(PROJECT_DIR, { recursive: true });

function orchestratorTopic(): Topic {
  return {
    id: "t-orch", name: "Orchestratore · progetto", slug: "orch", parentId: null, links: [],
    sessionKey: SESSION_KEY, color: "#000", icon: "MessageSquare",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", archived: true,
    projectPath: PROJECT_DIR, mcpPolicy: ORCHESTRATOR_MCP_POLICY,
    systemPrompt: orchestratorRolePrompt("progetto"),
  } as Topic;
}

function makeCtx(topic: Topic, messages: StoredMessage[], db: ReturnType<typeof migratedDb>): AppContext {
  return {
    BASE_DIR: join(ROOT, "base"),
    OPENCLAW_DIR: join(ROOT, "openclaw"),
    getTopicBySessionKey: (sk: string) => (topic.sessionKey === sk ? topic : null),
    loadLocalMessages: () => messages,
    loadTopics: () => ({ topics: { [topic.id]: topic } }),
    resolveTopicCwd: () => PROJECT_DIR,
    db,
  } as unknown as AppContext;
}

function msg(id: string, role: "user" | "assistant", content: string): StoredMessage {
  return { id, role, content, timestamp: "2026-01-01T00:00:00Z" } as StoredMessage;
}

/**
 * Tutto ciò che questo turno mette davanti al modello, in una stringa sola: la
 * conversazione ricostruita PIÙ il messaggio composto.
 *
 * La history si legge dall'ENVELOPE e non dal payload di proposito. Su
 * `inline-system` il payload non porta la history — la conserva il processo
 * della CLI — ma la conversazione ricostruita è comunque ciò che riparte a ogni
 * ripresa, rigenerazione o cambio di provider. È lì che uno snapshot finito
 * nella storia si annida, e sarebbe invisibile guardando il solo payload.
 */
function promptOf(turno: { env: { history: { content: string }[] }; payload: { userContent: string } }): string {
  return [...turno.env.history.map((h) => h.content), turno.payload.userContent].join("\n");
}

// ────────────────────────────────────────────────────────────────────────────

describe("il blocco arriva solo a chi è l'orchestratore", () => {
  test("una chat normale NON riceve lo stato della board", () => {
    const db = migratedDb();
    createTaskService(db).create({ projectId: PROJECT_ID, text: "una card", status: "todo" });
    const topic = orchestratorTopic();
    topic.mcpPolicy = undefined;
    const env = assembleTopicContext(makeCtx(topic, [], db), {
      sessionKey: SESSION_KEY, providerName: "claude-code", providerStrategy: "inline-system",
    });
    expect(env.systemBlocks.map((b) => b.id)).not.toContain("synthetic:board-snapshot");
  });

  test("l'orchestratore lo riceve, e il blocco conta nel budget come tutto il resto", () => {
    const db = migratedDb();
    createTaskService(db).create({ projectId: PROJECT_ID, text: "una card", status: "todo" });
    const env = assembleTopicContext(makeCtx(orchestratorTopic(), [], db), {
      sessionKey: SESSION_KEY, providerName: "claude-code", providerStrategy: "inline-system",
    });
    const block = env.systemBlocks.find((b) => b.id === "synthetic:board-snapshot");
    expect(block).toBeDefined();
    expect(block!.content).toContain("una card");
    expect(block!.countInBudget).toBe(true);
    expect(block!.injectedByTopicsApp).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BARRA 2 — due turni di fila: lo snapshot del primo NON è nel prompt del secondo
// ────────────────────────────────────────────────────────────────────────────

/**
 * Due turni veri, con in mezzo una board che cambia.
 *
 * `accumula: true` riproduce il guasto: salvare nella storia il messaggio
 * COMPOSTO (preambolo incluso) invece del testo che l'utente ha scritto. È il
 * modo esatto in cui uno stato per-turno diventa storia permanente, e serve a
 * dimostrare che l'asserzione qui sotto sa fallire.
 */
function dueTurni(opts: { accumula: boolean }) {
  const db = migratedDb();
  const svc = createTaskService(db);
  const topic = orchestratorTopic();
  const stored: StoredMessage[] = [];
  const ctx = makeCtx(topic, stored, db);

  const vecchia = svc.create({ projectId: PROJECT_ID, text: "CARD-DEL-PRIMO-TURNO", status: "todo" });

  const turno = (testo: string, alreadySent: Map<string, string>) => {
    // Come in produzione: il messaggio dell'utente è già a DB quando si assembla
    // (`includeLastUserInHistory: false` è ciò che evita di contarlo due volte).
    // Assemblarlo prima di salvarlo farebbe sparire dalla history il turno
    // precedente, cioè proprio la riga su cui questo test deve guardare.
    stored.push(msg(`u-${stored.length}`, "user", testo));
    const env = assembleTopicContext(ctx, {
      sessionKey: SESSION_KEY,
      providerName: "claude-code",
      providerStrategy: "inline-system",
      userMessageOverride: { content: testo, messageId: `u-${stored.length}` },
      includeLastUserInHistory: false,
    });
    const payload = adaptEnvelope(env, { alreadySent });
    const next = new Map((payload.inlineSlots ?? []).map((s) => [s.slot, s.hash]));
    return { env, payload, next };
  };

  // ── Turno 1 ──
  const t1 = turno("a che punto siamo?", new Map());
  // Ciò che RESTA a DB è il testo dell'utente, non il composto: il preambolo è
  // per-turno. `accumula` ci riscrive sopra il composto, cioè sbaglia apposta —
  // ed è l'unica differenza fra il ramo verde e la controprova.
  if (opts.accumula) stored[0] = msg("u-0", "user", t1.payload.userContent);
  stored.push(msg("a-0", "assistant", "Una card in todo."));

  // ── La board cambia fra i due turni ──
  svc.archive({ taskId: vecchia.id });
  svc.create({ projectId: PROJECT_ID, text: "CARD-DEL-SECONDO-TURNO", status: "review" });

  // ── Turno 2 ──
  const t2 = turno("e adesso?", t1.next);
  return { t1, t2 };
}

describe("BARRA 2 — lo stato della board non si accumula", () => {
  test("il prompt del turno 2 porta lo stato di ADESSO, e NON quello del turno 1", () => {
    const { t1, t2 } = dueTurni({ accumula: false });

    // Il turno 1 aveva davvero visto la card vecchia (senza questo, il test
    // sotto passerebbe anche se lo snapshot non fosse mai stato emesso).
    expect(promptOf(t1)).toContain("CARD-DEL-PRIMO-TURNO");

    const prompt2 = promptOf(t2);
    expect(prompt2).toContain("CARD-DEL-SECONDO-TURNO");
    expect(prompt2).not.toContain("CARD-DEL-PRIMO-TURNO");
  });

  test("CONTROPROVA — accumulando, la stessa asserzione fallisce", () => {
    const { t2 } = dueTurni({ accumula: true });
    // Identica alla riga verde qui sopra, su un prompt costruito accumulando:
    // la card sparita dalla board è ancora lì, e il modello agirebbe su quella.
    expect(promptOf(t2)).toContain("CARD-DEL-PRIMO-TURNO");
  });

  test("lo slot `board` è VOLATILE: non lo salta nemmeno a board immutata", () => {
    const db = migratedDb();
    createTaskService(db).create({ projectId: PROJECT_ID, text: "CARD-FERMA", status: "todo" });
    const topic = orchestratorTopic();
    const ctx = makeCtx(topic, [], db);
    const assemble = (testo: string) =>
      assembleTopicContext(ctx, {
        sessionKey: SESSION_KEY, providerName: "claude-code", providerStrategy: "inline-system",
        userMessageOverride: { content: testo }, includeLastUserInHistory: false,
      });

    const p1 = adaptEnvelope(assemble("primo"), { alreadySent: new Map() });
    const sent = new Map((p1.inlineSlots ?? []).map((s) => [s.slot, s.hash]));
    const p2 = adaptEnvelope(assemble("secondo"), { alreadySent: sent });

    // Il prompt di sistema — un documento — viene saltato: è già in sessione.
    expect(p2.userContent).not.toContain("Sei l'ORCHESTRATORE");
    // Lo stato della board no: riparte intero, identico o meno che sia.
    expect(p2.userContent).toContain("CARD-FERMA");
    expect(p2.adaptationNotes.join(" ")).not.toContain("board state");
  });

  test("anche sui provider con la history il blocco è RICOSTRUITO, non ereditato", () => {
    const db = migratedDb();
    const svc = createTaskService(db);
    const topic = orchestratorTopic();
    const stored: StoredMessage[] = [];
    const ctx = makeCtx(topic, stored, db);
    const t = svc.create({ projectId: PROJECT_ID, text: "CARD-CHE-SI-SPOSTA", status: "todo" });

    const assemble = () => assembleTopicContext(ctx, {
      sessionKey: SESSION_KEY, providerName: "claude", providerStrategy: "history-aware",
      userMessageOverride: { content: "?" }, includeLastUserInHistory: false,
    });
    const snapOf = (env: ReturnType<typeof assemble>) =>
      env.systemBlocks.find((b) => b.id === "synthetic:board-snapshot")!.content;

    expect(snapOf(assemble())).toContain("## todo");
    stored.push(msg("u-0", "user", "?"), msg("a-0", "assistant", "ok"));
    svc.update({ taskId: t.id, actor: "human", by: "test", patch: { status: "review" } });

    const secondo = assemble();
    expect(snapOf(secondo)).toContain("## review");
    expect(snapOf(secondo)).not.toContain("## todo");
    // E la storia non porta con sé nessuno snapshot vecchio.
    expect(secondo.history.map((h) => h.content).join("\n")).not.toContain("STATO DELLA BOARD");
  });
});

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});
