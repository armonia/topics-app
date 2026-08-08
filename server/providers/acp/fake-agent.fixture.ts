/**
 * Un agente ACP finto, vero processo.
 *
 * Serve ai test del provider, e il punto è che sia un PROCESSO: la parte che si
 * rompe davvero in un'integrazione su stdio non è la semantica, è tutto il
 * resto — lo spawn, l'env, il framing a righe, la morte del figlio a metà
 * turno. Un finto peer in-process quei pezzi non li tocca, e sono esattamente
 * quelli che poi falliscono in produzione.
 *
 * Lo pilota il testo del prompt (`TOOL`, `THINK`, `USAGE`, `PERM`, `SLOW`,
 * `REFUSE`, `CRASH`): così un test si legge in una riga e non serve un canale
 * di controllo a parte.
 *
 * Si lancia con `bun <questo file>` — vedi `acp-provider.test.ts`.
 */

interface Msg {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

let nextSessionId = 1;
let nextClientRequestId = 1;
/** sessionId → è nata con `session/new` o è stata ricaricata? */
const sessions = new Map<string, "new" | "loaded">();
/** Prompt in attesa di `session/cancel`, per sessione. */
const slowPrompts = new Map<string, (stopReason: string) => void>();
/** Risposte del client alle NOSTRE richieste. */
const clientPending = new Map<number, (result: Record<string, unknown>) => void>();

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
}

function update(sessionId: string, payload: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: payload } });
}

function askClient(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextClientRequestId++;
  return new Promise((resolve) => {
    clientPending.set(id, resolve);
    send({ id, method, params });
  });
}

async function handlePrompt(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sessionId = String(params.sessionId ?? "");
  const prompt = Array.isArray(params.prompt) ? params.prompt : [];
  const text = prompt
    .map((b) => (b && typeof b === "object" ? String((b as Record<string, unknown>).text ?? "") : ""))
    .join("");

  if (text.includes("CRASH")) {
    // Muore a metà turno, senza rispondere: è il caso più cattivo.
    process.exit(1);
  }

  if (text.includes("THINK")) {
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "rifletto" } });
  }

  if (text.includes("TOOL")) {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Leggo la configurazione",
      kind: "read",
      status: "pending",
      rawInput: { path: "/etc/hosts" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "127.0.0.1 localhost" } }],
    });
  }

  if (text.includes("USAGE")) {
    update(sessionId, { sessionUpdate: "usage_update", used: 12_345, size: 200_000 });
  }

  if (text.includes("PERM")) {
    const res = await askClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "call-perm", title: "Scrivo un file", kind: "edit" },
      options: [
        { optionId: "no", name: "Rifiuta", kind: "reject_once" },
        { optionId: "si", name: "Consenti", kind: "allow_once" },
        { optionId: "sempre", name: "Consenti sempre", kind: "allow_always" },
      ],
    });
    const outcome = (res.outcome ?? {}) as Record<string, unknown>;
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `perm:${String(outcome.optionId ?? outcome.outcome ?? "?")}` },
    });
  }

  if (text.includes("SLOW")) {
    // Annuncia di essere ENTRATO nel turno lento, prima di appendersi.
    //
    // Serve al test: per verificare che un abort arrivi su un turno VIVO bisogna
    // sapere che il turno è cominciato, e l'unica cosa che il test può osservare da
    // fuori è ciò che gli arriva dall'handler. Senza questo chunk restava solo
    // `await Bun.sleep(150)` — un'attesa a tempo fisso che sotto carico non basta:
    // l'abort partiva prima della sessione e il turno finiva con
    // ACP_PROVIDER_STOPPED invece di `cancelled`. Due test non-deterministici, che
    // fallivano a caso anche in isolamento.
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "slow:started" },
    });
    return new Promise<Record<string, unknown>>((resolve) => {
      slowPrompts.set(sessionId, (stopReason) => resolve({ stopReason }));
    });
  }

  if (text.includes("REFUSE")) {
    return { stopReason: "refusal" };
  }

  // L'eco porta con sé l'id di sessione e come è nata: è così che i test
  // verificano il riuso della sessione senza guardare dentro al provider.
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `[${sessionId}/${sessions.get(sessionId) ?? "?"}] ${text}` },
  });
  return { stopReason: "end_turn" };
}

async function handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        // Di norma 1. `FAKE_ACP_PROTOCOL_VERSION` serve a UN caso solo: l'agente
        // che risponde con una versione più alta di quella chiesta, cioè il
        // ramo in cui il client DEVE chiudere. Dall'env e non dal testo del
        // prompt perché `initialize` arriva prima di qualunque prompt.
        protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL_VERSION ?? 1),
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      };
    case "session/new": {
      const id = `sess-${nextSessionId++}`;
      sessions.set(id, "new");
      return { sessionId: id };
    }
    case "session/load": {
      const id = String(params.sessionId ?? "");
      // Un agente vero le tiene su disco: qui basta accettare ciò che sembra
      // nostro e rifiutare il resto, che è il ramo che il provider deve gestire.
      if (!/^sess-\d+$/.test(id)) throw new Error(`sessione sconosciuta: ${id}`);
      sessions.set(id, "loaded");
      return {};
    }
    case "session/prompt":
      return handlePrompt(params);
    default:
      throw new Error(`metodo non implementato: ${method}`);
  }
}

function handleNotification(method: string, params: Record<string, unknown>): void {
  if (method !== "session/cancel") return;
  const sessionId = String(params.sessionId ?? "");
  const resolve = slowPrompts.get(sessionId);
  if (!resolve) return;
  slowPrompts.delete(sessionId);
  resolve("cancelled");
}

function handleLine(line: string): void {
  let msg: Msg;
  try {
    msg = JSON.parse(line) as Msg;
  } catch {
    return;
  }
  if (typeof msg.method === "string") {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    if (msg.id === undefined || msg.id === null) {
      handleNotification(msg.method, params);
      return;
    }
    const id = msg.id;
    void Promise.resolve()
      .then(() => handleRequest(msg.method as string, params))
      .then((result) => send({ id, result: result ?? {} }))
      .catch((err: unknown) =>
        send({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } }),
      );
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    const resolve = clientPending.get(Number(msg.id));
    if (!resolve) return;
    clientPending.delete(Number(msg.id));
    resolve((msg.result ?? {}) as Record<string, unknown>);
  }
}

let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
