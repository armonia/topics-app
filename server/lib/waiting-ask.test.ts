/**
 * @covers HOLD-04
 */
import { describe, expect, test } from "bun:test";
import { waitingAskStartedAt } from "./waiting-ask";

const ASK = (over: Record<string, unknown> = {}) => JSON.stringify([
  { id: "t0", name: "Bash", status: "success" },
  { id: "t1", name: "mcp__topics__ask_user_question", status: "waiting_for_input", startedAt: 1_700_000_000_000, ...over },
]);

describe("waitingAskStartedAt — l'attesa si legge dalla riga", () => {
  test("un tool in attesa dice da quando", () => {
    expect(waitingAskStartedAt(ASK(), null)).toBe(1_700_000_000_000);
  });

  test("nessun tool in attesa: la chat sta lavorando, non aspetta", () => {
    const done = JSON.stringify([{ id: "t1", name: "Bash", status: "success" }]);
    expect(waitingAskStartedAt(done, null)).toBeNull();
    expect(waitingAskStartedAt(null, null)).toBeNull();
  });

  test("la domanda sta nei blocchi e non nella colonna vecchia: si trova lo stesso", () => {
    // La timeline è la fonte che il renderer preferisce; una riga scritta di
    // recente può avere solo quella.
    const blocks = JSON.stringify([
      { kind: "text", text: "ci penso" },
      { kind: "tool", toolCall: { id: "t1", name: "mcp__topics__ask_user_question", status: "waiting_for_input", startedAt: 42 } },
    ]);
    expect(waitingAskStartedAt(null, blocks)).toBe(42);
  });

  test("attesa senza timestamp: lo STATO vale comunque, con l'ora che passa chi chiama", () => {
    const noTs = JSON.stringify([{ id: "t1", name: "ask", status: "waiting_for_input" }]);
    expect(waitingAskStartedAt(noTs, null, 999)).toBe(999);
    // Senza nemmeno un ripiego non si inventa un numero.
    expect(waitingAskStartedAt(noTs, null)).toBeNull();
  });

  test("JSON illeggibile non fa esplodere lo scatto di tutte le altre chat", () => {
    expect(waitingAskStartedAt("{rotto", "[[", 1)).toBeNull();
  });
});
