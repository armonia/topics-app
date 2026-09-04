/**
 * Il difetto che questi test tengono chiuso: un agente dispacciato nasceva con
 * l'autonomia interattiva (`ask`), che è `--permission-mode plan`, e in plan
 * mode la CLI gli rifiuta ogni tool che scrive — file, commit, board. Quattro
 * turni bruciati il 04-05/08 (task 46480579 e 8f635484), tutti a spiegare di
 * non poter lavorare.
 *
 * Perché non basta guardare la riga nel DB: `--permission-mode` è un flag di
 * argv fissato allo spawn. Alzare `autonomy_level` a yolo DOPO lascia il figlio
 * vivo in plan mode — il livello va giusto alla NASCITA, cioè qui.
 *
 * L'altra metà del contratto conta quanto la prima: un topic aperto da un umano
 * NON passa da qui e deve continuare a nascere `ask`. Allargare l'autonomia a
 * tutti sarebbe stato un permesso concesso di nascosto.
 *
 * @covers EXTSESS-06
 */
import { describe, test, expect } from "bun:test";
import {
  createDetachedTopic,
  createTopicCore,
  DETACHED_TOPIC_AUTONOMY,
  type SessionControlDeps,
} from "./session-control-core";
import type { Topic } from "../types";

/** Deps in memoria: cattura i topic salvati, ignora i broadcast. */
function makeDeps(seed: Topic[] = []): SessionControlDeps & { saved: Topic[] } {
  const topics: Record<string, Topic> = {};
  for (const t of seed) topics[t.id] = t;
  const saved: Topic[] = [];
  return {
    saved,
    getTopicById: (id) => topics[id] ?? null,
    loadTopics: () => ({ topics }),
    saveSingleTopic: (topic) => {
      topics[topic.id] = topic;
      saved.push(topic);
    },
    slugify: (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    broadcastToAll: () => {},
  };
}

describe("createDetachedTopic — l'autonomia con cui nasce un agente", () => {
  test("nasce in yolo, non nell'autonomia interattiva", () => {
    const deps = makeDeps();
    const { topic } = createDetachedTopic(
      { name: "task dispacciato", projectPath: "/tmp/x", systemPrompt: "…", background: true },
      deps,
    );
    expect(topic.autonomyLevel).toBe("yolo");
    expect(DETACHED_TOPIC_AUTONOMY).toBe("yolo");
  });

  test("il livello è SCRITTO sulla riga, non lasciato al fallback della persistenza", () => {
    // `saveSingleTopic` (server/utils.ts) risolve un livello assente in 'ask'.
    // Se il campo arrivasse vuoto, il difetto tornerebbe da quella porta senza
    // che nessuna riga di questo file cambi.
    const deps = makeDeps();
    createDetachedTopic({ name: "t", projectPath: "/tmp/x", systemPrompt: "" }, deps);
    const persisted = deps.saved.at(-1)!;
    expect(persisted.autonomyLevel).toBeDefined();
    expect(persisted.autonomyLevel).toBe("yolo");
  });

  test("carries the provider the board asked for: a card on codex runs on the OpenAI CLI", () => {
    const deps = makeDeps();
    const { topic } = createDetachedTopic({ name: "codex card", projectPath: "/tmp/x", systemPrompt: "", provider: "codex" }, deps);
    expect((topic as { provider?: string | null }).provider).toBe("codex");
    const { topic: plain } = createDetachedTopic({ name: "claude card", projectPath: "/tmp/x", systemPrompt: "" }, deps);
    expect((plain as { provider?: string | null }).provider ?? null).toBeNull();
  });

  test("mai in plan mode: `ask` è il valore che rompeva gli agenti", () => {
    const deps = makeDeps();
    const { topic } = createDetachedTopic({ name: "t", projectPath: "/tmp/x", systemPrompt: "" }, deps);
    expect(topic.autonomyLevel).not.toBe("ask");
  });

  test("un chiamante può ancora imporre un livello diverso", () => {
    const deps = makeDeps();
    const { topic } = createDetachedTopic(
      { name: "t", projectPath: "/tmp/x", systemPrompt: "", autonomyLevel: "auto-apply" },
      deps,
    );
    expect(topic.autonomyLevel).toBe("auto-apply");
  });
});

describe("createTopicCore — il topic di un umano non cambia", () => {
  test("nessuna autonomia imposta: resta il default interattivo", () => {
    // Il contratto ha due lati. Se un giorno qualcuno unifica i due percorsi,
    // è QUESTO test che deve rompersi: allargare yolo alle chat umane
    // significherebbe dare a tutti un permesso che nessuno ha chiesto.
    const current: Topic = {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      name: "chat umana",
      slug: "chat-umana",
      parentId: null,
      links: [],
      sessionKey: "topic:aaaaaaaa",
      color: "#5865f2",
      icon: "MessageSquare",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      archived: false,
      systemPrompt: "",
      contextFiles: [],
      pinnedMessages: [],
      sortOrder: 0,
    } as Topic;
    const deps = makeDeps([current]);
    const res = createTopicCore(current, "nuova chat", deps);
    expect(res.topic.autonomyLevel).toBeUndefined();
  });
});
