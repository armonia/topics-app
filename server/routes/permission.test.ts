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
  * @covers PERM-06
 */
import { describe, test, expect } from "bun:test";
import { createPermissionRouter } from "./permission";
import { deliverAnswer, hasPendingAsk, cancelAsk } from "../lib/ask-user-bridge";
import { cancelPermission, hasPendingPermission, sessionHasPendingPermission } from "../lib/permission-bridge";

type Row = { tool_calls?: string | null; blocks?: string | null } | undefined;

function makeHarness(row: Row = undefined) {
  const broadcasts: Array<{ type: string } & Record<string, unknown>> = [];
  const toolCallWrites: Array<{ sessionKey: string; toolCallId: string; fields: Record<string, unknown> }> = [];

  /**
   * I topic della finta app. Uno per session key, coniato alla prima richiesta
   * con il livello che ha una chat normale (`auto-apply` → `acceptEdits`, cioè
   * la modalità che CHIEDE). Sono veri oggetti mutabili perché è esattamente
   * ciò che «passa a libero» va a scrivere, ed è l'unico modo di provare che
   * scrive sulla chat GIUSTA e su nessun'altra.
   */
  const topics = new Map<string, { id: string; sessionKey: string; autonomyLevel: string }>();
  const topicFor = (key: string) => {
    let t = topics.get(key);
    if (!t) {
      t = { id: `topic-of-${key}`, sessionKey: key, autonomyLevel: "auto-apply" };
      topics.set(key, t);
    }
    return t;
  };

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
    getTopicBySessionKey: (key: string) => topicFor(key),
    saveSingleTopic: (t: { id: string; sessionKey: string; autonomyLevel: string }) => {
      topics.set(t.sessionKey, { id: t.id, sessionKey: t.sessionKey, autonomyLevel: t.autonomyLevel });
    },
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
  return { call, broadcasts, toolCallWrites, topicFor };
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

/**
 * «PASSA A LIBERO» — la terza azione del pannello.
 *
 * Una sola pressione fa tre cose, e le tre si provano SEPARATE: se una sola
 * mancasse, un test che le guarda insieme resterebbe verde per il motivo
 * sbagliato. Il caso peggiore è proprio il verde a metà — la richiesta
 * consentita e la sessione NON liberata (il pannello successivo ricompare), o
 * la sessione liberata e nessuna traccia di chi l'ha deciso.
 */
describe("«Passa a libero»: consente ORA e libera la sessione", () => {
  test("(a) la richiesta in corso si risolve come CONSENTITA — e la CLI non vede mai la quarta parola", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_a") });
    const sk = "free:a";
    // Ordine reale: il bridge è già dentro la sua gamba quando la persona preme.
    const leg = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_a", legMs: 5_000 });
    await Bun.sleep(20);

    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, {
      toolCallId: "tu_free_a",
      decision: "allow_free",
    }))!;
    expect(resp.status).toBe(200);

    // La gamba si sblocca con un `allow`: `allow_free` è una decisione di
    // Topics su sé stesso, e consegnarla al figlio CLI sarebbe una parola
    // sconosciuta al posto di un permesso.
    expect(await (await leg)!.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_free_a")).toBe(false);
  });

  test("(b) la sessione passa in modalità libera, e il selettore di autonomia lo viene a sapere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_b") });
    const sk = "free:b";
    expect(h.topicFor(sk).autonomyLevel).toBe("auto-apply");

    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_b", legMs: 100 });
    const resp = (await h.call("POST", `/api/sessions/${sk}/permission-response`, {
      toolCallId: "tu_free_b",
      decision: "allow_free",
    }))!;

    expect((await resp.json()).autonomyLevel).toBe("yolo");
    expect(h.topicFor(sk).autonomyLevel).toBe("yolo");
    // Il `topic:updated` è ciò che fa dire «Libero» al selettore nel composer —
    // cioè l'unico comando da cui si torna indietro. Senza, il regime sarebbe
    // cambiato di nascosto.
    const updated = h.broadcasts.find((b) => b.type === "topic:updated");
    expect(updated).toBeTruthy();
    expect((updated!.topic as { autonomyLevel: string }).autonomyLevel).toBe("yolo");
  });

  test("(c) resta una riga nel thread: cosa è stato fatto, e da chi", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_c") });
    const sk = "free:c";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_c", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_free_c", decision: "allow_free" });

    // La traccia si scrive sulla RIGA della chat (`permissionOutcome`), che è
    // ciò che sopravvive al reload ed è quello che il thread disegna. Un
    // `allow` liscio non basterebbe: dopo, rileggendo, «consentito» e
    // «consentito e da qui non chiedo più» sembrerebbero la stessa cosa.
    const write = h.toolCallWrites.at(-1)!;
    const outcome = write.fields.permissionOutcome as { decision: string; actor?: string; decidedAt: string };
    expect(write.toolCallId).toBe("tu_free_c");
    expect(outcome.decision).toBe("allow_free");
    expect(outcome.actor).toBeTruthy();
    expect(outcome.decidedAt).toBeTruthy();
    // E arriva anche a chi sta guardando adesso, non solo a chi ricarica.
    const resolved = h.broadcasts.find((b) => b.type === "stream:tool_permission_resolved")!;
    expect((resolved.outcome as { decision: string }).decision).toBe("allow_free");
    expect((resolved.outcome as { actor?: string }).actor).toBeTruthy();
  });

  test("il turno prosegue: il pannello SUCCESSIVO non compare", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_free_next") });
    const sk = "free:next";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_free_next", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_free_next", decision: "allow_free" });
    const before = h.broadcasts.length;

    // Lo strumento DOPO, nello stesso turno, con lo stesso figlio CLI ancora
    // nato in `acceptEdits`: se questa gamba aprisse un pannello, «passa a
    // libero» avrebbe liberato la sessione solo dal turno successivo — cioè
    // non avrebbe fatto quello che dice.
    const next = (await h.call("POST", `/api/sessions/${sk}/permission`, {
      toolName: "mcp__gateway__kiwi__search-flight",
      toolUseId: "tu_free_next_2",
      legMs: 100,
    }))!;
    expect(await next.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_free_next_2")).toBe(false);
    expect(h.broadcasts.length).toBe(before);
  });

  test("vale per QUESTA sessione: le altre continuano a chiedere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_mia") });
    const mia = "free:mia";
    const altra = "free:altra";
    await h.call("POST", `/api/sessions/${mia}/permission`, { toolName: "Bash", toolUseId: "tu_mia", legMs: 100 });
    await h.call("POST", `/api/sessions/${mia}/permission-response`, { toolCallId: "tu_mia", decision: "allow_free" });

    // Il livello dell'altra chat non si è mosso…
    expect(h.topicFor(altra).autonomyLevel).toBe("auto-apply");
    // …e soprattutto il suo canale CHIEDE ancora: nessuna regola globale è
    // stata scritta. È la differenza con «Consenti sempre», che invece vale per
    // tutta l'app — e sarebbe stata la scorciatoia sbagliata da prendere qui.
    try {
      const resp = (await h.call("POST", `/api/sessions/${altra}/permission`, {
        toolName: "Bash",
        toolUseId: "tu_altra",
        legMs: 100,
      }))!;
      expect(await resp.json()).toEqual({ pending: true });
      expect(hasPendingPermission(altra, "tu_altra")).toBe(true);
    } finally {
      cancelPermission(altra, "tu_altra");
    }
  });

  test("è REVERSIBILE da dove si è cambiata: rimesso «agisce», si torna a chiedere", async () => {
    const h = makeHarness({ tool_calls: callRow("tu_rev") });
    const sk = "free:rev";
    await h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_rev", legMs: 100 });
    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_rev", decision: "allow_free" });
    expect(h.topicFor(sk).autonomyLevel).toBe("yolo");

    // Quello che fa il selettore di autonomia nel composer (PATCH del topic).
    h.topicFor(sk).autonomyLevel = "auto-apply";

    try {
      const resp = (await h.call("POST", `/api/sessions/${sk}/permission`, {
        toolName: "Bash",
        toolUseId: "tu_rev_2",
        legMs: 100,
      }))!;
      // Un permesso che si toglie e non si può rimettere non è un permesso.
      expect(await resp.json()).toEqual({ pending: true });
    } finally {
      cancelPermission(sk, "tu_rev_2");
    }
  });

  test("due pannelli aperti insieme: nessuno resta appeso a chiedere a vuoto", async () => {
    // La CLI può chiedere per più `tool_use` nello stesso messaggio (misurati a
    // 170 ms di distanza). Liberata la sessione, il secondo pannello non ha più
    // niente da chiedere: se restasse aperto, il turno resterebbe «in attesa di
    // una persona» — cioè fuori dalla vista di watchdog e reaper — mentre la
    // persona ha già risposto per tutti.
    const h = makeHarness({ tool_calls: callRow("tu_due_1") });
    const sk = "free:due";
    const primo = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Bash", toolUseId: "tu_due_1", legMs: 5_000 });
    const secondo = h.call("POST", `/api/sessions/${sk}/permission`, { toolName: "Write", toolUseId: "tu_due_2", legMs: 5_000 });
    await Bun.sleep(20);
    expect(hasPendingPermission(sk, "tu_due_2")).toBe(true);

    await h.call("POST", `/api/sessions/${sk}/permission-response`, { toolCallId: "tu_due_1", decision: "allow_free" });

    expect(await (await primo)!.json()).toEqual({ decision: "allow" });
    expect(await (await secondo)!.json()).toEqual({ decision: "allow" });
    expect(hasPendingPermission(sk, "tu_due_2")).toBe(false);
    expect(sessionHasPendingPermission(sk)).toBe(false);
    // E la riga del secondo non resta a girare su «in attesa della tua risposta».
    // L'ULTIMA scrittura, non la prima: la prima è il pannello che si dipinge.
    const write = h.toolCallWrites.filter((w) => w.toolCallId === "tu_due_2").at(-1)!;
    expect(write.fields.status).toBe("running");
    expect((write.fields.permissionOutcome as { decision: string }).decision).toBe("allow");
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
