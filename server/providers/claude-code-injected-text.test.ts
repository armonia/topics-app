/**
 * Il testo che la CLI INIETTA non è la risposta del modello.
 *
 * La sequenza qui replicata è registrata dal wire vero
 * (`claude --print --output-format stream-json` su una skill fittizia): dopo il
 * `tool_result` del tool `Skill` la CLI manda un evento `type:"user"` con un
 * blocco `text` che contiene l'INTERO SKILL.md. Finché il ciclo dei blocchi
 * trattava allo stesso modo gli eventi `assistant` e `user`, quel corpo entrava
 * in `fullText` e usciva a schermo dentro la risposta — nel turno reale il
 * prompt di `/recap` compariva prima della risposta, incollato senza spazio.
 *
 * Qui si blinda che: (a) esca solo il testo dell'assistente, (b) il corpo della
 * skill finisca sulla RIGA del tool che l'ha chiesto, (c) il resto sparisca.
 *
 * @covers THINK-01, THINK-02
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider } from "./claude-code";
import { SidechainTracker } from "./claude/sidechain-tracker";

function makeProviderWithStubProcess(sessionKey: string) {
  const provider = new ClaudeCodeProvider({ type: "claude-code" });
  const pp: any = {
    proc: { stdin: { write() { return true; }, end() {} }, kill() {}, on() {}, stdout: { on() {} }, stderr: { on() {} } },
    readline: { on() {}, close() {} },
    io: { writeStdin: () => {}, signal: () => {}, kill: () => {} },
    ready: Promise.resolve(),
    sessionKey,
    consumedOffset: 0,
    stderrBuf: "",
    spawnMeta: { claudeSessionId: "test-session", isNewSession: false },
    createdAt: Date.now(),
    lastActivity: Date.now(),
    alive: true,
    streamHandler: null,
    pendingResolve: null,
    pendingReject: null,
    fullText: "",
    activeToolCalls: new Set(),
    inactivityTimer: null,
    lifetimeTimer: null,
    heartbeatInterval: null,
    subAgentEmit: new Map(),
    lastEventAt: Date.now(),
    needsHistoryReplay: false,
    sidechain: new SidechainTracker(),
    pendingInputs: new Map(),
  };
  (provider as any).processes.set(sessionKey, pp);
  return { provider, pp };
}

function makeHandler() {
  const text: string[] = [];
  const thinking: string[] = [];
  const results: Array<{ id: string; result: string; isError?: boolean }> = [];
  const started: Array<{ id: string; name: string }> = [];
  return {
    text,
    thinking,
    results,
    started,
    handler: {
      onTextDelta: (t: string) => text.push(t),
      onThinkingDelta: (t: string) => thinking.push(t),
      onToolStart: (id: string, name: string) => started.push({ id, name }),
      onToolResult: (id: string, result: string, isError?: boolean) => results.push({ id, result, isError }),
      onDone: () => {},
      onError: () => {},
    },
  };
}

const emit = (provider: unknown, pp: unknown, event: unknown) =>
  (provider as any).handleStreamEvent(pp, event);

const SKILL_BODY = "MARKER_BODY_XYZ_777. Rispondi solo con la parola PONG e nient'altro.";
const SKILL_PAYLOAD = `Base directory for this skill: /tmp/x/.claude/skills/zzprobe\n\n${SKILL_BODY}\n`;
/** Il payload di un comando (`~/.claude/commands/recap.md`): nessun prefisso. */
const RECAP_BODY = "Fai un riassunto in massimo 2 righe di tutte le modifiche fatte in questa sessione di chat.";

describe("claude-code · testo iniettato negli eventi user", () => {
  test("la sequenza vera di una Skill: a schermo solo la risposta, il corpo va sulla riga del tool", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj1");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "zzprobe" } }] },
    });
    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "Launching skill: zzprobe" }] },
    });
    emit(provider, pp, {
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "text", text: SKILL_PAYLOAD }] },
    });
    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "text", text: "PONG" }] },
    });

    // (a) La risposta è solo la risposta.
    expect(h.text).toEqual(["PONG"]);
    expect(pp.fullText).toBe("PONG");
    expect(pp.fullText).not.toContain("MARKER_BODY_XYZ_777");

    // (b) Il corpo della skill è finito sulla riga del tool che l'ha chiesto,
    //     al posto di «Launching skill: …», che non diceva niente di nuovo.
    expect(h.results.map((r) => r.id)).toEqual(["toolu_skill", "toolu_skill"]);
    expect(h.results[0].result).toBe("Launching skill: zzprobe");
    expect(h.results[1].result).toBe(SKILL_BODY);
    expect(h.results[1].isError).toBe(false);
  });

  test("il caso reale: /recap e' un COMANDO, il suo corpo non ha prefisso e finiva incollato alla risposta", () => {
    // Questo è il turno da cui è partito tutto: nel DB il messaggio era
    // «Fai un riassunto in massimo 2 righe…solo testo inline.Corretto il
    // ritaglio delle finestre…» — il prompt del comando e la risposta vera,
    // attaccati senza nemmeno uno spazio.
    const { provider, pp } = makeProviderWithStubProcess("topic:inj7");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_recap", name: "Skill", input: { skill: "recap" } }] },
    });
    emit(provider, pp, {
      type: "user",
      tool_use_result: { success: true, commandName: "recap" },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_recap", content: "Launching skill: recap" }] },
    });
    emit(provider, pp, {
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "text", text: `${RECAP_BODY}\n` }] },
    });
    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Corretto il ritaglio delle finestre." }] },
    });

    expect(pp.fullText).toBe("Corretto il ritaglio delle finestre.");
    expect(pp.fullText).not.toContain("Fai un riassunto");
    expect(h.results[1].result).toBe(RECAP_BODY);
  });

  test("una skill senza corpo non si mangia il testo iniettato dopo", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj8");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_mute", name: "Skill", input: { skill: "muta" } }] },
    });
    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_mute", content: "Launching skill: muta" }] },
    });
    // Il modello riprende a parlare: nessun corpo sta arrivando.
    emit(provider, pp, { type: "assistant", message: { content: [{ type: "text", text: "Vado." }] } });
    // Testo iniettato PIU' TARDI: non è di quella skill.
    emit(provider, pp, {
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "text", text: "roba iniettata dopo" }] },
    });

    expect(h.results.map((r) => r.result)).toEqual(["Launching skill: muta"]);
    expect(pp.fullText).toBe("Vado.");
  });

  test("due Skill nello stesso messaggio: ogni corpo va sulla sua riga", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj9");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "toolu_a", name: "Skill", input: { skill: "alfa" } },
          { type: "tool_use", id: "toolu_b", name: "Skill", input: { skill: "beta" } },
        ],
      },
    });
    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "Launching skill: alfa" }] },
    });
    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_b", content: "Launching skill: beta" }] },
    });
    emit(provider, pp, { type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "corpo di alfa" }] } });
    emit(provider, pp, { type: "user", isSynthetic: true, message: { content: [{ type: "text", text: "corpo di beta" }] } });

    const byId = h.results.filter((r) => r.result.startsWith("corpo"));
    expect(byId).toEqual([
      { id: "toolu_a", result: "corpo di alfa", isError: false },
      { id: "toolu_b", result: "corpo di beta", isError: false },
    ]);
  });

  test("un promemoria di sistema non entra da nessuna parte", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj2");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "user",
      message: { content: [{ type: "text", text: "<system-reminder>ricordati di X</system-reminder>" }] },
    });
    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "text", text: "Fatto." }] },
    });

    expect(h.text).toEqual(["Fatto."]);
    expect(pp.fullText).toBe("Fatto.");
  });

  test("senza una Skill in attesa, un corpo di skill orfano si scarta invece di finire in chat", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj3");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, { type: "user", isSynthetic: true, message: { content: [{ type: "text", text: SKILL_PAYLOAD }] } });

    expect(h.text).toEqual([]);
    expect(h.results).toEqual([]);
  });

  test("il pensiero iniettato in un evento user non passa per onThinkingDelta", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj4");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, { type: "user", message: { content: [{ type: "thinking", thinking: "roba iniettata" }] } });
    emit(provider, pp, { type: "assistant", message: { content: [{ type: "thinking", thinking: "ci penso" }] } });

    expect(h.thinking).toEqual(["ci penso"]);
  });

  test("un tool_result a blocchi diventa testo, non un array JSON", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj5");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_mcp", name: "mcp__topics__get_task", input: {} }] },
    });
    emit(provider, pp, {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_mcp",
          content: [{ type: "text", text: "Task #12 — in review" }],
        }],
      },
    });

    expect(h.results).toHaveLength(1);
    expect(h.results[0].result).toBe("Task #12 — in review");
    expect(h.results[0].result).not.toContain('"type"');
  });

  test("il testo iniettato dentro un sotto-agente non entra nel suo log", () => {
    const { provider, pp } = makeProviderWithStubProcess("topic:inj6");
    const h = makeHandler();
    pp.streamHandler = h.handler;

    emit(provider, pp, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_task", name: "Task", input: { description: "esplora" } }] },
    });
    emit(provider, pp, {
      type: "user",
      parent_tool_use_id: "toolu_task",
      message: { content: [{ type: "text", text: SKILL_PAYLOAD }] },
    });
    emit(provider, pp, {
      type: "assistant",
      parent_tool_use_id: "toolu_task",
      message: { content: [{ type: "text", text: "trovato in App.tsx" }] },
    });

    const snap = pp.sidechain.snapshot("toolu_task");
    expect(snap.fullText).toBe("trovato in App.tsx");
    expect(snap.fullText).not.toContain("MARKER_BODY_XYZ_777");
  });
});
