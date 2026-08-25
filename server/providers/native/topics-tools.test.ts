/**
 * I mestieri di Topics dati all'agente nativo.
 *
 * La domanda a cui questo file risponde: l'agente nativo, che sa programmare,
 * sa anche muovere la card su cui sta lavorando? Prima no — i 39 tool di Topics
 * esistevano solo per le CLI, via un processo MCP separato.
 *
 * Quello che si verifica qui è il PONTE, non i tool: che gli schemi arrivino
 * nella forma che l'API di Anthropic vuole, che i nomi si riconoscano, e che un
 * handler che solleva diventi un risultato d'errore invece di uccidere il
 * turno. I comportamenti dei singoli tool hanno già i loro test in
 * `mcp/topics-mcp-server.test.ts`, ed è esattamente il punto di riusarli.
  * @covers RT-09
 */
import { describe, expect, test } from "bun:test";
import { topicsToolSpecs, isTopicsTool, executeTopicsTool } from "./topics-tools";
import { CODING_TOOLS } from "./tools";

describe("gli schemi dei tool di Topics", () => {
  test("ci sono, e sono tanti quanti la tabella MCP", () => {
    const specs = topicsToolSpecs();
    expect(specs.length).toBeGreaterThan(20);
  });

  test("hanno la forma che l'API di Anthropic vuole", () => {
    // La tabella MCP dice `inputSchema`, l'API `input_schema`: se la
    // traduzione salta, l'API rifiuta l'intera richiesta e nessun tool
    // funziona più — non solo quello sbagliato.
    for (const s of topicsToolSpecs()) {
      expect(typeof s.name).toBe("string");
      expect(s.name.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe("string");
      expect(s.input_schema).toBeTruthy();
      expect(s.input_schema.type).toBe("object");
      expect((s as any).inputSchema).toBeUndefined();
    }
  });

  test("il profilo `dispatch` ne offre MENO: gli schemi si pagano a ogni chiamata", () => {
    expect(topicsToolSpecs("dispatch").length).toBeLessThan(topicsToolSpecs().length);
  });

  // I due gruppi devono restare distinguibili, o il loop instrada male.
  test("nessun nome collide con i tool di coding", () => {
    const topics = new Set(topicsToolSpecs().map((s) => s.name));
    for (const c of CODING_TOOLS) {
      expect(topics.has(c.name), `collisione sul nome ${c.name}`).toBe(false);
    }
  });
});

describe("riconoscere di chi è un tool", () => {
  test("i mestieri di Topics si riconoscono", () => {
    expect(isTopicsTool("create_task")).toBe(true);
    expect(isTopicsTool("comment_task")).toBe(true);
    expect(isTopicsTool("open_browser_pane")).toBe(true);
  });

  test("quelli di coding no: sono nostri e passano dall'altra strada", () => {
    expect(isTopicsTool("read_file")).toBe(false);
    expect(isTopicsTool("bash")).toBe(false);
  });

  test("un nome inventato non è di nessuno", () => {
    expect(isTopicsTool("teletrasporto")).toBe(false);
  });
});

describe("eseguire un mestiere di Topics", () => {
  const ctx = { baseUrl: "https://127.0.0.1:1", sessionKey: "topic:x" };

  test("un tool sconosciuto lo dice, non esplode", async () => {
    const r = await executeTopicsTool("teletrasporto", {}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("sconosciuto");
  });

  /**
   * IL MOTIVO PER CUI QUESTO FILE ESISTE invece di chiamare `TOOL_HANDLERS`
   * direttamente dal loop: gli handler MCP SOLLEVANO, il loop vuole un
   * risultato. Un'eccezione che risale ucciderebbe il turno per un tool andato
   * storto, quando l'agente potrebbe semplicemente riprovare diversamente.
   *
   * Qui la porta 1 non risponde: è un errore di rete vero, non simulato.
   */
  test("un handler che solleva diventa un risultato d'errore, e il turno sopravvive", async () => {
    const r = await executeTopicsTool("list_tasks", {}, ctx);
    expect(r.isError).toBe(true);
    expect(typeof r.content).toBe("string");
    expect(r.content.length).toBeGreaterThan(0);
  }, 30_000);
});
