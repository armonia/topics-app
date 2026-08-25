/**
 * What the client is allowed to wipe when a session is stopped, and why it
 * may not before it has hydrated.
 *
 * @covers CHAT-01
 */
import { describe, expect, test } from "bun:test";
import { decideClientWipeOnStop } from "./stopSessionPolicy";
import type { AssistantTurnShape } from "../../../shared/empty-turn";

const user = (): AssistantTurnShape => ({ role: "user", content: "ciao" });
/** Il SEGNAPOSTO: la riga creata all'inizio dello stream, ancora vuota. */
const placeholder = (): AssistantTurnShape => ({ role: "assistant", content: "" });
const assistantWithText = (): AssistantTurnShape => ({ role: "assistant", content: "eccomi" });
/** Turno agentico: nessuna prosa, ma tool già eseguiti. */
const agenticTurn = (): AssistantTurnShape => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id: "toolu_1", name: "Edit", status: "success" }],
});

describe("decideClientWipeOnStop", () => {
  describe("not hydrated", () => {
    // The whole point of the guard: until the server told us what the thread
    // actually contains, the local list is structurally unreliable. The
    // function must refuse every wipe regardless of how it looks, including
    // shapes that *would* be valid wipes if we were hydrated.

    test("refuses to wipe with an empty local thread (cold mount)", () => {
      expect(decideClientWipeOnStop(false, [])).toBe(false);
    });

    test("refuses to wipe with 1 local user message", () => {
      // Could be the brand-new-chat case OR a hot-reload race that dropped
      // 49 previous turns. We can't tell, so we refuse.
      expect(decideClientWipeOnStop(false, [user()])).toBe(false);
    });

    test("refuses to wipe with many local user messages", () => {
      const many = Array.from({ length: 50 }, user);
      expect(decideClientWipeOnStop(false, many)).toBe(false);
    });
  });

  describe("hydrated", () => {
    test("permits wipe of empty thread (no user message stored yet)", () => {
      expect(decideClientWipeOnStop(true, [])).toBe(true);
    });

    test("permits wipe of first-turn thread (one user message)", () => {
      // The chat was just created, user typed once, cancels before AI replies.
      // Wipe is the intended UX: discard the throwaway thread.
      expect(decideClientWipeOnStop(true, [user()])).toBe(true);
    });

    test("permits wipe when the assistant row is still the empty placeholder", () => {
      expect(decideClientWipeOnStop(true, [user(), placeholder()])).toBe(true);
    });

    test("refuses to wipe an established thread (two user messages)", () => {
      // Two user turns means the chat has progressed past "I changed my mind
      // immediately"; the user is stopping mid-conversation, not discarding.
      expect(decideClientWipeOnStop(true, [user(), assistantWithText(), user()])).toBe(false);
    });

    test("refuses to wipe a long thread", () => {
      const long: AssistantTurnShape[] = [];
      for (let i = 0; i < 25; i++) long.push(user(), assistantWithText());
      expect(decideClientWipeOnStop(true, long)).toBe(false);
    });
  });

  // ── La regressione del 10 agosto 2026 ──────────────────────────────────────
  // Il client contava i messaggi UTENTE e si fermava lì. Ma in questa app tutto
  // il lavoro di un turno sta dentro l'unica riga assistente creata all'inizio
  // dello stream: un primo turno lungo otto minuti resta «1 utente + 1
  // assistente» esattamente come un turno mai partito. Su quel `true` il client
  // svuotava la pagina, chiudeva la pane e (dalla sidebar) archiviava il topic —
  // mentre il server, che il predicato giusto ce l'aveva già, rifiutava di
  // cancellare. Adesso il predicato è LO STESSO: `shared/clear-messages-policy`.
  describe("primo turno che ha già lavorato", () => {
    test("RIFIUTA quando l'assistente ha già scritto del testo", () => {
      expect(decideClientWipeOnStop(true, [user(), assistantWithText()])).toBe(false);
    });

    test("RIFIUTA su un turno agentico: nessuna prosa, ma tool eseguiti", () => {
      expect(decideClientWipeOnStop(true, [user(), agenticTurn()])).toBe(false);
    });

    test("RIFIUTA quando l'assistente ha solo ragionato", () => {
      const thinkingOnly: AssistantTurnShape = { role: "assistant", content: "", thinking: "hmm" };
      expect(decideClientWipeOnStop(true, [user(), thinkingOnly])).toBe(false);
    });

    test("RIFIUTA con due righe assistente (rami)", () => {
      expect(decideClientWipeOnStop(true, [user(), placeholder(), placeholder()])).toBe(false);
    });
  });
});
