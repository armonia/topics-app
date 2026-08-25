/**
 * La traduzione `session/update` → vocabolario della chat.
 *
 * È il pezzo che un agente ACP nuovo mette alla prova per primo, ed è puro: un
 * payload letterale entra, degli eventi escono. Se questi test reggono, aggiungere
 * un agente non richiede di spawnare niente per sapere se la chat lo disegnerà.
 * @covers USAGE-06
 */
import { describe, expect, test } from "bun:test";
import {
  contentText,
  newTranslateState,
  translateSessionUpdate,
  type AcpSessionUpdate,
} from "./translate";

function tr(update: AcpSessionUpdate, state = newTranslateState()) {
  return translateSessionUpdate(update, state);
}

describe("chunk di testo e pensiero", () => {
  test("agent_message_chunk → text", () => {
    expect(tr({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ciao" } })).toEqual([
      { kind: "text", text: "ciao" },
    ]);
  });

  test("agent_thought_chunk → thinking (non testo: non va nella trascrizione)", () => {
    expect(tr({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "rifletto" } })).toEqual([
      { kind: "thinking", text: "rifletto" },
    ]);
  });

  test("un chunk vuoto non produce eventi", () => {
    expect(tr({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toEqual([]);
    expect(tr({ sessionUpdate: "agent_message_chunk" })).toEqual([]);
  });

  test("user_message_chunk non produce niente: è l'eco del nostro prompt", () => {
    expect(tr({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "il mio prompt" } })).toEqual([]);
  });
});

describe("tool call", () => {
  test("il nome è il TITLE, e il kind finisce negli args per l'icona", () => {
    const out = tr({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Leggo la configurazione",
      kind: "read",
      status: "pending",
      rawInput: { path: "/etc/hosts" },
    });
    expect(out).toEqual([
      {
        kind: "tool_start",
        toolCallId: "c1",
        name: "Leggo la configurazione",
        args: { path: "/etc/hosts", kind: "read" },
      },
    ]);
  });

  test("senza title si ripiega sul kind, e senza nemmeno quello su 'tool'", () => {
    expect(tr({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute" })[0]).toMatchObject({ name: "execute" });
    expect(tr({ sessionUpdate: "tool_call", toolCallId: "c2" })[0]).toMatchObject({ name: "tool" });
  });

  test("una call si annuncia UNA volta sola: il secondo update porta solo gli args", () => {
    const state = newTranslateState();
    tr({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Scrivo" }, state);
    const out = tr({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Scrivo", rawInput: { path: "a.ts" } }, state);
    expect(out).toEqual([{ kind: "tool_args", toolCallId: "c1", args: { path: "a.ts" } }]);
  });

  test("un tool_call_update per una call MAI annunciata la annuncia lo stesso", () => {
    const out = tr({ sessionUpdate: "tool_call_update", toolCallId: "orfana", title: "Eseguo", status: "in_progress" });
    expect(out[0]).toMatchObject({ kind: "tool_start", toolCallId: "orfana" });
  });

  test("status completed → tool_result non in errore", () => {
    const state = newTranslateState();
    tr({ sessionUpdate: "tool_call", toolCallId: "c1", title: "Leggo" }, state);
    const out = tr(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "127.0.0.1" } }],
      },
      state,
    );
    expect(out).toEqual([{ kind: "tool_result", toolCallId: "c1", result: "127.0.0.1", isError: false }]);
  });

  test("status failed → tool_result in errore (la chat disegna la ✗ rossa)", () => {
    const state = newTranslateState();
    tr({ sessionUpdate: "tool_call", toolCallId: "c1" }, state);
    const out = tr({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", rawOutput: "ENOENT" }, state);
    expect(out).toEqual([{ kind: "tool_result", toolCallId: "c1", result: "ENOENT", isError: true }]);
  });

  test("output parziale senza status terminale → tool_update, non un risultato", () => {
    const state = newTranslateState();
    tr({ sessionUpdate: "tool_call", toolCallId: "c1" }, state);
    const out = tr(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c1",
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: "riga 1" } }],
      },
      state,
    );
    expect(out).toEqual([{ kind: "tool_update", toolCallId: "c1", partialResult: "riga 1" }]);
  });

  test("un diff si rende come diff, non come '[diff]'", () => {
    const out = tr({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "diff", path: "/a.ts", oldText: "vecchio", newText: "nuovo" }],
    });
    const result = out.find((e) => e.kind === "tool_result");
    expect(result).toMatchObject({ result: "--- /a.ts\n- vecchio\n+ nuovo" });
  });

  test("rawOutput oggetto si serializza quando non c'è content", () => {
    const out = tr({ sessionUpdate: "tool_call", toolCallId: "c1", status: "completed", rawOutput: { exitCode: 0 } });
    expect(out.find((e) => e.kind === "tool_result")).toMatchObject({ result: '{"exitCode":0}' });
  });

  test("senza toolCallId non si produce niente (una riga senza identità è ingestibile)", () => {
    expect(tr({ sessionUpdate: "tool_call", title: "Boh" })).toEqual([]);
  });

  test("le locations arrivano negli args (servono al click-to-file)", () => {
    const out = tr({
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      kind: "read",
      locations: [{ path: "/src/a.ts", line: 12 }],
    });
    expect(out[0]).toMatchObject({ args: { kind: "read", locations: [{ path: "/src/a.ts", line: 12 }] } });
  });
});

describe("usage_update", () => {
  test("used + size → context con la finestra dichiarata", () => {
    expect(tr({ sessionUpdate: "usage_update", used: 12345, size: 200000 })).toEqual([
      { kind: "context", tokens: 12345, windowTokens: 200000 },
    ]);
  });

  test("senza size si emette solo il numeratore", () => {
    expect(tr({ sessionUpdate: "usage_update", used: 10 })).toEqual([{ kind: "context", tokens: 10 }]);
  });

  test("senza used non si emette niente (un ring senza numeratore mente)", () => {
    expect(tr({ sessionUpdate: "usage_update", size: 200000 })).toEqual([]);
    expect(tr({ sessionUpdate: "usage_update", used: -1 })).toEqual([]);
    expect(tr({ sessionUpdate: "usage_update", used: Number.NaN })).toEqual([]);
  });
});

describe("plan → passi del goal (3.4)", () => {
  test("le entries diventano un evento plan, non testo del modello", () => {
    expect(
      tr({
        sessionUpdate: "plan",
        entries: [
          { content: "Leggere i file", priority: "high", status: "in_progress" },
          { content: "Scrivere il test", priority: "low", status: "pending" },
        ],
      }),
    ).toEqual([
      {
        kind: "plan",
        steps: [
          { content: "Leggere i file", status: "in_progress" },
          { content: "Scrivere il test", status: "pending" },
        ],
      },
    ]);
  });

  test("uno stato sconosciuto vale pending: il passo esiste comunque", () => {
    expect(tr({ sessionUpdate: "plan", entries: [{ content: "X", status: "boh" }] })).toEqual([
      { kind: "plan", steps: [{ content: "X", status: "pending" }] },
    ]);
    expect(tr({ sessionUpdate: "plan", entries: [{ content: "Y" }] })).toEqual([
      { kind: "plan", steps: [{ content: "Y", status: "pending" }] },
    ]);
  });

  test("le voci vuote si scartano, ma un piano SVUOTATO si emette", () => {
    // Un elenco che si svuota è un fatto («non c'è più un piano»): chi ascolta
    // deve poter cancellare. Un `plan` senza `entries` del tutto non dice niente.
    expect(tr({ sessionUpdate: "plan", entries: [{ content: "  " }] })).toEqual([
      { kind: "plan", steps: [] },
    ]);
    expect(tr({ sessionUpdate: "plan", entries: [] })).toEqual([]);
    expect(tr({ sessionUpdate: "plan" })).toEqual([]);
  });
});

describe("rami muti, di proposito", () => {
  test("le altre superfici che non abbiamo restano mute", () => {
    for (const s of ["available_commands_update", "current_mode_update", "config_option_update", "session_info_update"]) {
      expect(tr({ sessionUpdate: s })).toEqual([]);
    }
  });

  test("un sessionUpdate mai visto non rompe niente", () => {
    expect(tr({ sessionUpdate: "qualcosa_del_futuro", content: { text: "x" } })).toEqual([]);
    expect(tr(null as unknown as AcpSessionUpdate)).toEqual([]);
    expect(tr(undefined as unknown as AcpSessionUpdate)).toEqual([]);
  });
});

describe("contentText", () => {
  test("legge il testo diretto, la risorsa incorporata e il link", () => {
    expect(contentText({ type: "text", text: "ciao" })).toBe("ciao");
    expect(contentText({ type: "resource", resource: { uri: "file:///a", text: "contenuto" } })).toBe("contenuto");
    expect(contentText({ type: "resource", resource: { uri: "file:///a" } })).toBe("file:///a");
    expect(contentText({ type: "resource_link", uri: "file:///b" })).toBe("file:///b");
  });

  test("un blocco senza testo (immagine, audio) dà stringa vuota, non 'undefined'", () => {
    expect(contentText({ type: "image", mimeType: "image/png" })).toBe("");
    expect(contentText(null)).toBe("");
  });
});
