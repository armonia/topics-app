/**
 * What a node is told about a card: its description, then the thread that was said on it.
 * The lane's own case (the reviewer's feedback reaches `createRun`) is in
 * `task-dispatcher-remote-node.test.ts`; here is the builder alone.
 *
 * @covers KANBAN-76
 */
import { describe, it, expect } from "bun:test";
import type { TaskComment } from "../../shared/board";
import { MAX_COMMENT_CHARS, MAX_REVIEW_CHARS, MAX_THREAD_CHARS, nodeRunDescription } from "./node-run-brief";

let n = 0;
function comment(over: Partial<TaskComment>): TaskComment {
  n += 1;
  return {
    id: `c${n}`, taskId: "t", author: "attilio", content: "x", mentions: [], media: [],
    createdAt: new Date(Date.UTC(2026, 9, 26, 10, n)).toISOString(), kind: "comment", ...over,
  };
}

describe("nodeRunDescription", () => {
  it("un allegato non viaggia, ma il nodo sa che c'è", () => {
    const out = nodeRunDescription("d", [comment({ content: "guarda lo screenshot", media: ["/Users/x/uploads/a.png", "/Users/x/uploads/b.png"] })]);
    expect(out).toContain("2 attached file(s)");
    expect(out).not.toContain("/Users/x/uploads");
  });

  it("senza parole dette la descrizione passa identica, anche vuota", () => {
    expect(nodeRunDescription("la mia descrizione", [])).toBe("la mia descrizione");
    expect(nodeRunDescription(null, [])).toBe("");
    // Bookkeeping is not speech.
    expect(nodeRunDescription("d", [
      comment({ kind: "service", content: "Task in coda" }),
      comment({ kind: "status", content: "todo→in_progress" }),
      comment({ kind: "review-note", content: "check verdi" }),
      // Written by the system as plain `comment`s (seen on ff293eda): still not anybody's voice.
      comment({ author: "system", content: "Consegnato dal nodo «PC Windows»: il ramo è stato piantato" }),
    ])).toBe("d");
  });

  it("porta il feedback e la consegna precedente, dal più vecchio, dopo la descrizione", () => {
    const out = nodeRunDescription("descrizione", [
      comment({ author: "agent", kind: "delivery", content: "PRIMA CONSEGNA" }),
      comment({ content: "FEEDBACK DEL REVIEWER" }),
    ]);
    expect(out.startsWith("descrizione")).toBe(true);
    expect(out.indexOf("PRIMA CONSEGNA")).toBeGreaterThan(out.indexOf("descrizione"));
    expect(out.indexOf("FEEDBACK DEL REVIEWER")).toBeGreaterThan(out.indexOf("PRIMA CONSEGNA"));
    // The agent is told its checkout does not hold the previous delivery.
    expect(out).toContain("NOT in it");
  });

  it("il commento di revisione più recente arriva intero fino a 20.000 caratteri", () => {
    // A reviewer's list of defects, longer than the old 2.000 cut: the middle used to be dropped.
    const list = `INIZIO-ELENCO\n${"difetto riga\n".repeat(400)}FINE-ELENCO-MEZZO-${"x".repeat(2_000)}`;
    expect(list.length).toBeGreaterThan(MAX_COMMENT_CHARS);
    expect(list.length).toBeLessThan(MAX_REVIEW_CHARS);
    const out = nodeRunDescription("", [comment({ content: list })]);
    expect(out).toContain("INIZIO-ELENCO");
    expect(out).toContain("FINE-ELENCO-MEZZO-");
    expect(out).not.toContain("[...cut");

    const over = comment({ content: `${"A".repeat(MAX_REVIEW_CHARS + 500)}\nLA CODA` });
    const capped = nodeRunDescription("", [over]);
    expect(capped).toContain("LA CODA");
    // Past the cap the node is told the middle is out of reach, and that it can ask for it.
    expect(capped).toContain("NOT reachable from this machine");
    expect(capped.length).toBeLessThan(MAX_REVIEW_CHARS + 1_500);
  });

  it("un commento più vecchio di quello di revisione resta tagliato, e i più vecchi cadono prima dei nuovi", () => {
    const huge = comment({ content: `${"A".repeat(MAX_COMMENT_CHARS * 3)}\nLA RICHIESTA IN CODA` });
    const cut = nodeRunDescription("", [huge, comment({ content: "feedback nuovo" })]);
    expect(cut.length).toBeLessThan(MAX_COMMENT_CHARS + 2_000);
    expect(cut).toContain("NOT reachable from this machine");
    // The end of a long comment is where the reviewer asks for the thing.
    expect(cut).toContain("LA RICHIESTA IN CODA");

    const old = Array.from({ length: 20 }, (_, i) => comment({ content: `vecchio-${i} ${"b".repeat(MAX_COMMENT_CHARS - 20)}` }));
    const newest = comment({ content: "L'ULTIMO FEEDBACK" });
    const out = nodeRunDescription("d", [...old, newest]);
    expect(out).toContain("L'ULTIMO FEEDBACK");
    expect(out).not.toContain("vecchio-0 ");
    expect(out).toContain("older comment(s) left out");
    expect(out.length).toBeLessThan(MAX_THREAD_CHARS + 2_500);
  });
});
