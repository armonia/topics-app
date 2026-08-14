/**
 * Caricare un thread SENZA le due colonne grasse.
 *
 * `messages` è il 97% di questo database, e dentro `messages` il 98% dei byte
 * sta in `blocks` e `tool_calls` (353 MB e 220 MB contro 13 MB di testo, su
 * questa macchina al 2026-08-14). L'assemblaggio del contesto — che gira a OGNI
 * turno di ogni agente — di quelle due colonne non legge niente, e fino al
 * 2026-08-14 le pagava comunque: `withBlocks: false` saltava il parse di
 * `blocks` ma non quello di `tool_calls`, e i byte di entrambe arrivavano da
 * SQLite per essere buttati.
 *
 * Misurato su una copia del DB vero, topic 6b99e9cf, 118 righe, mediana di 7:
 *
 *   SELECT *                                 6,1 ms
 *   SELECT * + JSON.parse dei tool_calls    14,5 ms
 *   SELECT senza blocks/tool_calls           0,5 ms
 *
 * Qui si prova la sola cosa che un cancello può provare senza un cronometro:
 * che la versione magra dice ESATTAMENTE le stesse cose di quella piena, tolto
 * ciò che il chiamante ha detto di non volere. Il tempo è misurato, non gateato:
 * una soglia in millisecondi su una macchina condivisa sarebbe rumore.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { setupTestDataDir, createTestAppContext, testTmpDir } from "./helpers";
import type { AppContext, StoredMessage } from "../../server/types";
import type { ToolCall, ContentBlock } from "../../shared/types";

const TEST_DATA = testTmpDir("thread-lean-data");

beforeAll(() => setupTestDataDir(TEST_DATA));

function seed(ctx: AppContext, sessionKey: string, p: string): void {
  const tc: ToolCall = {
    id: `${p}-tc1`, name: "Bash", args: { command: "echo ciao" }, status: "success",
    result: "ciao", detail: { type: "shell", command: "echo ciao", output: "ciao" },
    startedAt: 1, endedAt: 2,
  };
  const blocks: ContentBlock[] = [
    { kind: "text", text: "ecco" } as ContentBlock,
    { kind: "tool", toolCall: tc } as ContentBlock,
  ];
  ctx.saveLocalMessages(sessionKey, [
    { id: `${p}-u1`, role: "user", content: "domanda", timestamp: new Date(1).toISOString() },
    {
      id: `${p}-a1`, role: "assistant", content: "risposta", timestamp: new Date(2).toISOString(),
      parentId: `${p}-u1`, blocks, toolCalls: [tc], thinking: "ragiono",
      media: ["/tmp/x.png"], latencyMs: 42, usagePromptTokens: 7, usageCompletionTokens: 9,
      costCents: 3, model: "claude-opus-5", cacheReadTokens: 5,
    },
  ]);
}

describe("loadLocalMessages — quanto di un messaggio si carica", () => {
  test("di default arrivano sia i blocchi sia le tool call", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-pieno", "lp");
    const [, a] = ctx.loadLocalMessages("topic:lean-pieno");
    expect(a.blocks?.length).toBe(2);
    expect(a.toolCalls?.length).toBe(1);
  });

  test("withBlocks:false toglie i blocchi e LASCIA le tool call (comportamento invariato)", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-noblocks", "lb");
    const [, a] = ctx.loadLocalMessages("topic:lean-noblocks", { withBlocks: false });
    expect(a.blocks).toBeUndefined();
    expect(a.toolCalls?.length).toBe(1);
  });

  test("con ENTRAMBE a false spariscono tutte e due, e nient altro cambia", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-magro", "lm");
    const pieno = ctx.loadLocalMessages("topic:lean-magro");
    const magro = ctx.loadLocalMessages("topic:lean-magro", { withBlocks: false, withToolCalls: false });

    expect(magro.length).toBe(pieno.length);
    for (let i = 0; i < magro.length; i++) {
      expect(magro[i].blocks).toBeUndefined();
      expect(magro[i].toolCalls).toBeUndefined();
      // Tutto il RESTO deve essere identico: è la sola cosa che rende la
      // versione magra sostituibile a quella piena per chi non legge le due
      // colonne. Un campo perso qui sarebbe un turno assemblato monco.
      const senzaGrasse = (x: StoredMessage) => {
        const { blocks: _b, toolCalls: _t, ...resto } = x;
        return resto;
      };
      expect(senzaGrasse(magro[i])).toEqual(senzaGrasse(pieno[i]));
    }
  });

  test("il ramo attivo è lo STESSO: la versione magra non cambia quali messaggi tornano", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-ramo", "lr");
    const pieno = ctx.loadLocalMessages("topic:lean-ramo").map((m) => m.id);
    const magro = ctx.loadLocalMessages("topic:lean-ramo", { withBlocks: false, withToolCalls: false }).map((m) => m.id);
    expect(magro).toEqual(pieno);
  });

  test("withToolCalls:false da solo NON attiva la lettura magra — i blocchi restano", async () => {
    const ctx = await createTestAppContext();
    seed(ctx, "topic:lean-solotc", "ls");
    const [, a] = ctx.loadLocalMessages("topic:lean-solotc", { withToolCalls: false });
    expect(a.blocks?.length).toBe(2);
  });
});
