import { describe, test, expect } from "bun:test";
import { orphanToolUseIds, pruneDanglingToolUses } from "./history-repair";
import type { AgentMessage } from "./agent-loop";

/**
 * La fixture non e' inventata: e' la forma della storia che il 17/08 ha fatto
 * fallire ogni turno di due sessioni per piu' di tre ore, con l'API che
 * rispondeva sempre la stessa cosa —
 *
 *   messages.232: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_01Bvgeim61SfeTp5tfNBrV1Z, toolu_01J54asAucinLxLmLJjdyKut
 *
 * — e il dispatcher che bruciava i due tentativi contro lo stesso muro.
 */
const A = "toolu_01Bvgeim61SfeTp5tfNBrV1Z";
const B = "toolu_01J54asAucinLxLmLJjdyKut";

/** Il turno morto a meta': l'assistente chiede due tool, nessuno risponde. */
function storiaRotta(): AgentMessage[] {
  return [
    { role: "user", content: "fai la pagina pubblica del profilo" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Guardo com'e' fatto il relay." },
        { type: "tool_use", id: A, name: "read_file", input: { path: "relay/src/pagina-ospite.ts" } },
        { type: "tool_use", id: B, name: "list_dir", input: { path: "relay/src" } },
      ],
    },
  ];
}

describe("una storia con tool_use orfani non deve mai partire verso l'API", () => {
  test("li trova, e sono esattamente i due dell'errore vero", () => {
    expect(orphanToolUseIds(storiaRotta())).toEqual([A, B]);
  });

  test("li pota, e il TESTO dell'assistente sopravvive: era lavoro vero", () => {
    const out = pruneDanglingToolUses(storiaRotta());
    expect(orphanToolUseIds(out)).toEqual([]);
    expect(out).toHaveLength(2);
    expect(out[1]!.content).toEqual([{ type: "text", text: "Guardo com'e' fatto il relay." }]);
  });

  test("nessun tool_result INVENTATO: si toglie la domanda, non si finge una risposta", () => {
    // Un risultato inventato l'agente lo LEGGE e ci costruisce sopra: gli
    // farebbe credere che un comando sia andato a buon fine quando non e' mai
    // partito. Meglio che la richiesta non sia mai esistita.
    const out = pruneDanglingToolUses(storiaRotta());
    const blocchi = out.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    expect(blocchi.some((b) => b.type === "tool_result")).toBe(false);
  });

  test("un assistente che chiedeva SOLO tool sparisce: content vuoto e' a sua volta invalido", () => {
    const storia: AgentMessage[] = [
      { role: "user", content: "vai" },
      { role: "assistant", content: [{ type: "tool_use", id: A, name: "read_file", input: {} }] },
    ];
    const out = pruneDanglingToolUses(storia);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });

  test("una storia SANA passa identica: nessun costo, nessuna differenza", () => {
    const sana: AgentMessage[] = [
      { role: "user", content: "vai" },
      { role: "assistant", content: [{ type: "tool_use", id: A, name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: A, content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Fatto." }] },
    ];
    expect(orphanToolUseIds(sana)).toEqual([]);
    // Identita' referenziale: la potatura non tocca proprio niente.
    expect(pruneDanglingToolUses(sana)).toBe(sana as AgentMessage[]);
  });

  test("si pota SOLO l'orfano: il tool a cui era stato risposto resta", () => {
    const mista: AgentMessage[] = [
      { role: "user", content: "vai" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: A, name: "read_file", input: {} },
          { type: "tool_use", id: B, name: "list_dir", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: A, content: "ok" }] },
    ];
    const out = pruneDanglingToolUses(mista);
    const usi = (out[1]!.content as any[]).filter((b) => b.type === "tool_use");
    expect(usi).toHaveLength(1);
    expect(usi[0]!.id).toBe(A);
  });

  test("una storia a contenuto testuale (nessun blocco) non viene toccata", () => {
    const semplice: AgentMessage[] = [
      { role: "user", content: "ciao" },
      { role: "assistant", content: "ciao a te" },
    ];
    expect(pruneDanglingToolUses(semplice)).toBe(semplice as AgentMessage[]);
  });
});
