/**
 * Copertura di rotta per il CANALE UMANO (server/routes/permission.ts): le
 * gambe di `ask-user` e `permission`, il click di `permission-response` e le
 * regole di `/api/tool-grants`.
 *
 * I due bridge (ask-user-bridge, permission-bridge) girano VERI: sono mappe in
 * memoria, senza DB né rete, e mockarli avrebbe tolto proprio ciò che qui si
 * vuole provare — che le tre uscite del rendez-vous (deciso / in attesa /
 * annullato) siano quelle giuste e che una decisione arrivi alla richiesta
 * GIUSTA. Finto c'è solo il contesto: `ctx` minimo, con un `db.prepare().get()`
 * che restituisce la riga di chat che il test ha deciso.
 *
 * Le regressioni che sorveglia:
 *   - `mcp__topics__*` che chiede il permesso di mostrare un pannello (7 agosto):
 *     la regola incorporata deve tagliare corto PRIMA di aprire un rendez-vous;
 *   - il click che torna con l'id della RIGA mentre la richiesta è indicizzata
 *     con quello della CLI: senza l'alias scritto dalla gamba, la decisione
 *     cadeva nel vuoto (409) e il turno restava fermo;
 *   - una `decision` non riconosciuta che diventa un sì per inerzia.
 */
import { describe, test, expect } from "bun:test";
import { createPermissionRouter } from "./permission";
import { deliverAnswer, hasPendingAsk, cancelAsk } from "../lib/ask-user-bridge";
import { cancelPermission, hasPendingPermission } from "../lib/permission-bridge";

type Row = { tool_calls?: string | null; blocks?: string | null } | undefined;

function makeHarness(row: Row = undefined) {
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];
  const toolCallWrites: Array<{ sessionKey: string; toolCallId: string; fields: Record<string, unknown> }> = [];

  const ctx = {
    db: { prepare: () => ({ get: () => row }) },
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json(); } catch { return null; } },
    matchRoute: (pathname: string, pattern: string): Record<string, string> | null => {
      const pp = pattern.split("/");
      const xp = pathname.split("/");
      if (pp.length !== xp.length) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(xp[i]);
        else if (pp[i] !== xp[i]) return null;
      }
      return params;
    },
    broadcastToAll: (msg: { type: string } & Record<string, unknown>) => { broadcasts.push(msg); },
    getTopicBySessionKey: (key: string) => ({ id: `topic-of-${key}` }),
    updateToolCallFields: (sessionKey: string, toolCallId: string, fields: Record<string, unknown>) => {
      toolCallWrites.push({ sessionKey, toolCallId, fields });
    },
  } as any;

  const router = createPermissionRouter(ctx);
  const call = (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://topics.test${path}`);
    const req = new Request(url.toString(), {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return router(req, url, url.pathname, method) as Promise<Response | null>;
  };
  return { call, broadcasts, toolCallWrites };
}

const callRow = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify([{ id, name: "Bash", status: "running", ...extra }]);

describe("POST /api/sessions/:sessionKey/ask-user", () => {
  test("senza domande è 400 e NON apre nessuna attesa", async () => {
    const h = makeHarness();
    const sk = "ask:empty";
    const resp = (await h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [] }))!;
    expect(resp.status).toBe(400);
    // Un 400 che avesse comunque aperto l'ask lascerebbe la sessione «ferma su
    // una persona» per tutto il TTL, senza pannello a schermo.
    expect(hasPendingAsk(sk)).toBe(false);
  });

  test("la gamba scade: {pending:true} e la domanda resta APERTA", async () => {
    const h = makeHarness();
    const sk = "ask:leg";
    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [{ q: "?" }], legMs: 100 }))!;
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ pending: true });
      // La scadenza è della GAMBA, non dell'ask: se chiudesse la domanda, il
      // pannello sparirebbe dopo il primo poll.
      expect(hasPendingAsk(sk)).toBe(true);
    } finally { cancelAsk(sk); }
  });

  test("la risposta arriva: torna {answers} e la domanda si chiude", async () => {
    const h = makeHarness();
    const sk = "ask:answered";
    // Ordine reale: la gamba è già in attesa quando la persona preme invia.
    const inFlight = h.call("POST", `/api/sessions/${sk}/ask-user`, { questions: [{ q: "?" }], legMs: 5_000 });
    await Bun.sleep(20);
    expect(deliverAnswer(sk, { colore: "blu" })).toBe(true);
    const resp = (await inFlight)!;
    expect(await resp.json()).toEqual({ answers: { colore: "blu" } });
    expect(hasPendingAsk(sk)).toBe(false);
  });
});

describe("POST /api/sessions/:sessionKey/permission", () => {
  test("senza toolName o toolUseId è 400", async () => {
    const h = makeHarness();
    const a = (await h.call("POST", "/api/sessions/p:1/permission", { toolUseId: "tu_1" }))!;
    expect(a.status).toBe(400);
    const b = (await h.call("POST", "/api/sessions/p:1/permission", { toolName: "Bash" }))!;
    expect(b.status).toBe(400);
    expect(hasPendingPermission("p:1", "tu_1")).toBe(false);
  });

  test("le mani di Topics non chiedono: allow immediato, nessun pannello, nessuna attesa", async () => {
    const h = makeHarness();
    const sk = "p:bridge";
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, {
      toolName: "mcp__topics__ask_user_question", toolUseId: "tu_b", legMs: 100,
    }))!;
    expect(await resp.json()).toEqual({ decision: "allow" });
    // Il 7 agosto: per mostrare un pannello serviva il permesso di mostrare un
    // pannello. Se il corto-circuito cade, qui compare un frame e una richiesta
    // aperta — e questo caso deve rompersi.
    expect(h.broadcasts).toHaveLength(0);
    expect(hasPendingPermission(sk, "tu_b")).toBe(false);
  });

  test("riga in attesa già dipinta: NON si ridipinge (nessuna scrittura, nessun frame)", async () => {
    const h = makeHarness({
      tool_calls: callRow("tu_p", { status: "awaiting_permission", permissionRequest: { toolName: "Bash", input: {}, requestedAt: 1 } }),
    });
    const sk = "p:painted";
    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_p", legMs: 100 }))!;
      expect(await resp.json()).toEqual({ pending: true });
      expect(h.toolCallWrites).toHaveLength(0);
      expect(h.broadcasts).toHaveLength(0);
    } finally { cancelPermission(sk, "tu_p"); }
  });

  test("riga NON dipinta: scrive awaiting_permission e manda il frame del pannello", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_np") });
    const sk = "p:unpainted";
    try {
      await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_np", input: { command: "ls" }, legMs: 100 });
      expect(h.toolCallWrites).toHaveLength(1);
      expect(h.toolCallWrites[0]).toMatchObject({ sessionKey: sk, toolCallId: "tu_np" });
      expect(h.toolCallWrites[0].fields.status).toBe("awaiting_permission");
      const frame = h.broadcasts.find((b) => b.type === "stream:tool_permission_required")!;
      expect(frame).toMatchObject({ sessionKey: sk, toolCallId: "tu_np", topicId: `topic-of-${sk}` });
      expect((frame.request as { input: unknown }).input).toEqual({ command: "ls" });
    } finally { cancelPermission(sk, "tu_np"); }
  });
});

describe("POST /api/sessions/:sessionKey/permission-response", () => {
  test("senza toolCallId è 400", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:1/permission-response", { decision: "allow" }))!;
    expect(resp.status).toBe(400);
  });

  test("una decision che non riconosciamo è un 400, non un sì per inerzia", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:2/permission-response", { toolCallId: "x", decision: "yes" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("invalid_decision");
  });

  test("nessuna richiesta aperta sotto il pannello: 409, non un ok muto", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/sessions/r:3/permission-response", { toolCallId: "x", decision: "allow" }))!;
    expect(resp.status).toBe(409);
    expect((await resp.json()).code).toBe("permission_not_pending");
  });

  test("giro completo con RIPIEGO PER NOME: il click torna con l'id della riga e trova la richiesta", async () => {
    // La CLI passa `cli_id`, che Topics non ha persistito; la riga a schermo è
    // `riga`. La gamba dipinge su `riga` e SCRIVE l'alias — senza quello, il
    // click qui sotto sarebbe un 409 e il turno resterebbe fermo per sempre.
    const h = makeHarness({ tool_calls: callRow("riga") });
    const sk = "r:alias";
    const leg = (await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "cli_id", legMs: 100 }))!;
    expect(await leg.json()).toEqual({ pending: true });
    expect(h.broadcasts[0]).toMatchObject({ type: "stream:tool_permission_required", toolCallId: "riga" });

    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "riga", decision: "allow" }))!;
    expect(resp.status).toBe(200);
    expect(hasPendingPermission(sk, "cli_id")).toBe(false);
    // L'esito RESTA sulla riga: chi rilegge la chat vede chi ha detto cosa.
    const write = h.toolCallWrites.at(-1)!;
    expect(write.toolCallId).toBe("riga");
    expect(write.fields.status).toBe("running");
    expect((write.fields.permissionOutcome as { decision: string }).decision).toBe("allow");
    const resolved = h.broadcasts.find((b) => b.type === "stream:tool_permission_resolved")!;
    expect(resolved).toMatchObject({ sessionKey: sk, toolCallId: "riga" });
  });

  test("un DENY si consegna com'è e resta scritto sulla riga", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_d") });
    const sk = "r:deny";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_d", legMs: 100 });
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_d", decision: "deny" }))!;
    expect(resp.status).toBe(200);
    const outcome = h.toolCallWrites.at(-1)!.fields.permissionOutcome as { decision: string };
    expect(outcome.decision).toBe("deny");
  });
});

describe("/api/tool-grants", () => {
  test("GET elenca le regole", async () => {
    const h = makeHarness();
    const resp = (await h.call("GET", "/api/tool-grants"))!;
    expect(resp.status).toBe(200);
    expect(Array.isArray((await resp.json()).grants)).toBe(true);
  });

  test("POST senza pattern è 400", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/tool-grants", { pattern: "   " }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toContain("required");
  });

  test("un asterisco NUDO non è una regola: 400 con codice, non un consenso a tutto", async () => {
    const h = makeHarness();
    const resp = (await h.call("POST", "/api/tool-grants", { pattern: "*" }))!;
    expect(resp.status).toBe(400);
    expect((await resp.json()).code).toBe("invalid_pattern");
  });

  test("un percorso che non è del canale non viene rivendicato", async () => {
    const h = makeHarness();
    expect(await h.call("GET", "/api/topics")).toBeNull();
    expect(await h.call("POST", "/api/sessions/x/switch-topic", { topicId: "y" })).toBeNull();
  });
});
