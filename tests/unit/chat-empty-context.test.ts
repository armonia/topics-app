/**
 * Cosa dice una chat vuota di se stessa.
 *
 * La regola che questi casi difendono e' una sola, ed e' quella che rende la
 * riga utile invece che rumore: si mostra solo cio' che qualcuno ha SCELTO. Un
 * topic senza modello, senza effort e senza autonomia non e' un topic da
 * descrivere «modello auto, effort auto, chiede prima di agire»: e' un topic
 * normale, e stampargli addosso tre default e' il modo in cui una riga di
 * contesto diventa una decorazione che si smette di leggere.
 */
import { describe, it, expect } from "bun:test";
import { contextBits } from "../../client/src/components/Chat/emptyStateContext";
import type { Topic } from "../../shared/types";

/** Traduttore finto: rende visibile la chiave, cosi' i casi non dipendono dai testi. */
const t = (k: string, v?: Record<string, string | number>) =>
  v ? `${k}(${Object.values(v).join(",")})` : k;

const topic = (over: Partial<Topic> = {}): Topic =>
  ({
    id: "t1",
    name: "Una chat",
    slug: "una-chat",
    parentId: null,
    links: [],
    sessionKey: "topic:t1",
    color: "#fff",
    icon: "chat",
    createdAt: "2026-08-16T00:00:00Z",
    updatedAt: "2026-08-16T00:00:00Z",
    archived: false,
    ...over,
  }) as Topic;

describe("il contesto di una chat vuota", () => {
  it("un topic senza scelte non dice niente: nessun default stampato", () => {
    // Il caso che tiene onesta tutta la riga. Se questo fallisse, ogni chat
    // nuova porterebbe addosso tre etichette che non significano niente.
    expect(contextBits(topic(), t)).toEqual([]);
  });

  it("dice il progetto per NOME, non per percorso", () => {
    // Il percorso intero e' lungo, cambia da macchina a macchina e non aggiunge
    // niente a chi sta guardando: la cartella e' l'unica parte che si riconosce.
    expect(contextBits(topic({ projectPath: "/Users/x/Projects/topics-app" }), t)).toEqual([
      "chat.empty.project(topics-app)",
    ]);
    // Barra finale: non deve produrre un nome vuoto.
    expect(contextBits(topic({ projectPath: "/Users/x/Projects/quadra/" }), t)).toEqual([
      "chat.empty.project(quadra)",
    ]);
  });

  it("modello, effort e provider compaiono solo se scelti", () => {
    expect(contextBits(topic({ model: "claude-opus-5" }), t)).toEqual([
      "chat.empty.model(claude-opus-5)",
    ]);
    expect(contextBits(topic({ effort: "xhigh" }), t)).toEqual(["chat.empty.effort(xhigh)"]);
    expect(contextBits(topic({ provider: "codex" }), t)).toEqual(["chat.empty.provider(codex)"]);
    // `null` e' «non scelto» quanto `undefined`: la colonna del DB torna null.
    expect(contextBits(topic({ model: null, effort: null, provider: null }), t)).toEqual([]);
  });

  it("l'autonomia si dice a parole, e le tre sono distinte", () => {
    // E' la piu' importante delle scelte: la differenza fra una chat che chiede
    // prima di toccare i file e una che non chiede non si puo' scoprire dopo.
    expect(contextBits(topic({ autonomyLevel: "ask" }), t)).toEqual(["chat.empty.autonomyAsk"]);
    expect(contextBits(topic({ autonomyLevel: "auto-apply" }), t)).toEqual([
      "chat.empty.autonomyAutoApply",
    ]);
    expect(contextBits(topic({ autonomyLevel: "yolo" }), t)).toEqual(["chat.empty.autonomyYolo"]);
  });

  it("i file di contesto si contano, e zero non si dice", () => {
    expect(contextBits(topic({ contextFiles: ["a.ts", "b.ts"] }), t)).toEqual([
      "chat.empty.contextFiles(2)",
    ]);
    expect(contextBits(topic({ contextFiles: [] }), t)).toEqual([]);
  });

  it("l'MCP si nomina solo quando RESTRINGE", () => {
    // Una limitazione va detta; la larghezza normale no. Dire «tutti gli
    // strumenti» a ogni chat sarebbe la stessa decorazione dei default.
    expect(contextBits(topic({ mcpPolicy: "bridge-only" }), t)).toEqual([
      "chat.empty.mcpBridge",
    ]);
    expect(contextBits(topic({ mcpPolicy: null }), t)).toEqual([]);
    expect(contextBits(topic({ mcpPolicy: "inherit" }), t)).toEqual([]);
  });

  it("l'ordine va dal DOVE al COME, che e' l'ordine in cui si guarda", () => {
    const bits = contextBits(
      topic({
        projectPath: "/Users/x/Projects/topics-app",
        model: "claude-opus-5",
        effort: "high",
        autonomyLevel: "yolo",
        contextFiles: ["a.ts"],
        mcpPolicy: "bridge-only",
      }),
      t,
    );
    expect(bits).toEqual([
      "chat.empty.project(topics-app)",
      "chat.empty.model(claude-opus-5)",
      "chat.empty.effort(high)",
      "chat.empty.autonomyYolo",
      "chat.empty.contextFiles(1)",
      "chat.empty.mcpBridge",
    ]);
  });

  it("il modello EFFETTIVO compare anche senza override sul topic", () => {
    // `topic.model` e' l'override: se non lo tocchi resta vuoto e la riga
    // taceva sul modello, mentre la barra sotto al composer mostrava
    // benissimo `claude-opus-5`. Due superfici a un centimetro di distanza
    // che dicevano due cose diverse sulla stessa chat - visto a schermo in
    // tests/e2e/chat-empty-context.spec.ts, non dedotto.
    const bits = contextBits(topic(), t, "claude-opus-5");
    expect(bits.join(" ")).toContain("claude-opus-5");
  });

  it("l'override del topic VINCE sul modello effettivo", () => {
    // Chi ha scelto esplicitamente deve leggere la propria scelta: il ripiego
    // serve a riempire un silenzio, non a coprire una decisione.
    const bits = contextBits(topic({ model: "sonnet" }), t, "claude-opus-5");
    expect(bits.join(" ")).toContain("sonnet");
    expect(bits.join(" ")).not.toContain("claude-opus-5");
  });

  it("senza modello effettivo la riga si comporta come prima", () => {
    // Il parametro e' facoltativo: su un'installazione che non risponde con lo
    // snapshot dei provider, il silenzio resta silenzio invece di diventare un
    // "undefined" stampato.
    const bits = contextBits(topic(), t, null);
    expect(bits).toEqual([]);
  });
});
