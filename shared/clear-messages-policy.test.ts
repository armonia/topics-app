/**
 * @covers CLEAR-01
 */
import { describe, expect, test } from "bun:test";
import { shouldHonorClearMessages } from "./clear-messages-policy";

/** La forma minima su cui decide il predicato: è quella che hanno sia la riga
 *  SQLite del server sia il `ChatMessage` del client. */
interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: unknown[];
}

/** Riga utente, o riga assistente CON del testo (cioè che ha già risposto). */
function msg(role: "user" | "assistant", id: string): StoredMessage {
  return {
    id,
    role,
    content: role === "user" ? "hello" : "hi",
    timestamp: new Date().toISOString(),
  };
}

/** Il SEGNAPOSTO: la riga che lo stream crea prima che il modello dica niente.
 *  È l'unica forma di riga assistente che può essere buttata via. */
function placeholder(id: string): StoredMessage {
  return { id, role: "assistant", content: "", timestamp: new Date().toISOString() };
}

/** La riga di un turno agentico: nessuna prosa, ma diciassette tool eseguiti.
 *  È la forma esatta del turno che l'8 agosto 2026 lo Stop ha cancellato. */
function agenticTurn(id: string): StoredMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "toolu_1",
        name: "mcp__gateway__kiwi__search-flight",
        args: { flyFrom: "SUF", flyTo: "MXP" },
        // Lo stato del turno perduto: fermo sul pannello del permesso.
        status: "awaiting_permission",
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

describe("shouldHonorClearMessages", () => {
  test("permette lo svuotamento su un thread del tutto vuoto", () => {
    const d = shouldHonorClearMessages([]);
    expect(d.shouldWipe).toBe(true);
    expect(d).toMatchObject({ userCount: 0, assistantCount: 0, assistantDidWork: false });
  });

  test("permette lo svuotamento col solo primo messaggio utente", () => {
    const d = shouldHonorClearMessages([msg("user", "u1")]);
    expect(d.shouldWipe).toBe(true);
    expect(d).toMatchObject({ userCount: 1, assistantCount: 0, assistantDidWork: false });
  });

  test("permette lo svuotamento col SEGNAPOSTO vuoto: è il caso per cui la scorciatoia esiste", () => {
    const d = shouldHonorClearMessages([msg("user", "u1"), placeholder("a1")]);
    expect(d.shouldWipe).toBe(true);
    expect(d.assistantDidWork).toBe(false);
  });

  // ── La regressione dell'incidente ─────────────────────────────────────────
  // Questi due test sostituiscono quello che diceva «1 utente + 1 assistente →
  // wipe OK, è comunque un primo turno usa-e-getta». Non lo è: in questa app
  // TUTTO il lavoro di un turno sta dentro quell'unica riga, quindi «1+1» non
  // distingue un turno mai partito da uno che ha macinato per minuti. Lo Stop
  // cancellava il secondo. Misurato al momento del fix: 208 sessioni, 31,1 MB.

  test("RIFIUTA quando l'assistente ha già scritto del testo", () => {
    const d = shouldHonorClearMessages([msg("user", "u1"), msg("assistant", "a1")]);
    expect(d.shouldWipe).toBe(false);
    expect(d).toMatchObject({ userCount: 1, assistantCount: 1, assistantDidWork: true });
  });

  test("RIFIUTA su un turno agentico: nessuna prosa, ma tool eseguiti", () => {
    // La forma che il conteggio non poteva vedere — ed è quella che ha perso
    // una chat vera: lo Stop sotto un pannello di permesso, con 17 tool già
    // dentro la riga e zero caratteri di testo.
    const d = shouldHonorClearMessages([msg("user", "u1"), agenticTurn("a1")]);
    expect(d.shouldWipe).toBe(false);
    expect(d.assistantDidWork).toBe(true);
  });

  test("RIFIUTA un secondo turno utente (regressione: cancellazione della history)", () => {
    // Lo scenario per cui la guardia era nata: il client manda clearMessages=true
    // perché la sua mappa in memoria sembrava vuota dopo un hot reload, ma il DB
    // ha più turni.
    const stored = [msg("user", "u1"), msg("assistant", "a1"), msg("user", "u2")];
    const d = shouldHonorClearMessages(stored);
    expect(d.shouldWipe).toBe(false);
    expect(d).toMatchObject({ userCount: 2, assistantCount: 1 });
  });

  test("RIFIUTA un thread lungo", () => {
    const stored: StoredMessage[] = [];
    for (let i = 0; i < 25; i++) {
      stored.push(msg("user", `u${i}`));
      stored.push(msg("assistant", `a${i}`));
    }
    const d = shouldHonorClearMessages(stored);
    expect(d.shouldWipe).toBe(false);
    expect(d.userCount).toBe(25);
    expect(d.assistantCount).toBe(25);
  });

  test("RIFIUTA quando la sessione ha righe FUORI dal ramo attivo", () => {
    // Il predicato guarda il ramo attivo, ma la cancellazione fa
    // `DELETE ... WHERE session_key = ?`: butta anche i rami abbandonati che
    // non ha mai visto. Qui il ramo attivo è la forma «si può cancellare»
    // (utente + segnaposto vuoto), ma la sessione ne ha altre quattro.
    const attivo = [msg("user", "u1"), placeholder("a1")];
    const d = shouldHonorClearMessages(attivo, 6);
    expect(d.shouldWipe).toBe(false);
    expect(d.hiddenRows).toBe(4);
  });

  test("il conteggio di sessione che COINCIDE col ramo attivo non cambia nulla", () => {
    const attivo = [msg("user", "u1"), placeholder("a1")];
    expect(shouldHonorClearMessages(attivo, 2).shouldWipe).toBe(true);
    // Omesso = comportamento storico, per i chiamanti che non lo passano.
    expect(shouldHonorClearMessages(attivo).shouldWipe).toBe(true);
  });

  test("un conteggio più PICCOLO del ramo attivo non finge righe nascoste", () => {
    // Non dovrebbe succedere; se succede, non è una ragione per cancellare.
    const attivo = [msg("user", "u1"), placeholder("a1")];
    expect(shouldHonorClearMessages(attivo, 1).hiddenRows).toBe(0);
  });

  test("RIFIUTA con 1 utente e 2 assistenti (rami)", () => {
    const stored = [msg("user", "u1"), msg("assistant", "a1"), msg("assistant", "a2")];
    const d = shouldHonorClearMessages(stored);
    expect(d.shouldWipe).toBe(false);
    expect(d).toMatchObject({ userCount: 1, assistantCount: 2 });
  });
});
