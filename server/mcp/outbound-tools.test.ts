/**
 * THE TWO OUTBOUND TOOLS, from the MCP bridge side.
 *
 * There is no server here: what is under test is the bridge CONTRACT. That the
 * schemas say what an agent needs to know, that the poll loop never mistakes
 * "nobody has answered yet" for a successful send, and that a refusal comes
 * back as a tool ERROR rather than a line of text a model can skim past.
 *
 * The regressions it watches:
 *   - `pending` treated as an outcome: the agent would report "sent" to nobody;
 *   - a refusal returned as a success;
 *   - a tool that leaves the machine without declaring it (`openWorldHint`),
 *     i.e. invisible to whoever reads the annotations.
  * @covers OUTBOUND-04
 */
import { describe, expect, test } from "bun:test";
import { toolsForProfile } from "./topics-mcp-server";
import { callGoogleCall, callSendMail, OUTBOUND_MAX_LEGS } from "./outbound-tools";

const args = { baseUrl: "http://x", sessionKey: "topic:abcd1234" };

function stubFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return impl as typeof fetch;
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("gli schemi dei due strumenti", () => {
  const tools = toolsForProfile("dispatch") as unknown as Array<{
    name: string;
    description: string;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
  }>;

  test("sono pubblicati anche a un agente di board", () => {
    expect(tools.map((t) => t.name)).toContain("send_mail");
    expect(tools.map((t) => t.name)).toContain("google_call");
  });

  test("dichiarano di uscire dalla macchina e di NON essere di sola lettura", () => {
    for (const name of ["send_mail", "google_call"]) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.annotations?.openWorldHint).toBe(true);
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
  });

  test("la descrizione dice che la conferma e' del server e vale per UN messaggio", () => {
    const mail = tools.find((t) => t.name === "send_mail")!;
    expect(mail.description).toContain("CONFIRMS EVERY MESSAGE");
    expect(mail.description).toContain("one answer per message");
  });
});

describe("callSendMail", () => {
  test("gli argomenti che mancano si dicono per nome, prima di qualunque rete", async () => {
    let called = false;
    const fetchImpl = stubFetch(async () => { called = true; return jsonResponse({ sent: true }); });
    await expect(callSendMail(args, { subject: "x", body: "y" }, fetchImpl)).rejects.toThrow(/'to'/);
    await expect(callSendMail(args, { to: "a@esempio.test", body: "y" }, fetchImpl)).rejects.toThrow(/'subject'/);
    await expect(callSendMail(args, { to: "a@esempio.test", subject: "x" }, fetchImpl)).rejects.toThrow(/'body'/);
    expect(called).toBe(false);
  });

  test("`pending` non e' un esito: si torna a chiedere finche' non c'e' una risposta", async () => {
    const legs: number[] = [];
    let call = 0;
    const fetchImpl = stubFetch(async () => {
      call++;
      return call < 3
        ? jsonResponse({ pending: true })
        : jsonResponse({ sent: true, account: "primo", to: "a@esempio.test", subject: "Preventivo", traced: true });
    });
    const out = await callSendMail(
      args,
      { to: "a@esempio.test", subject: "Preventivo", body: "corpo" },
      fetchImpl,
      { onProgress: (leg) => legs.push(leg) },
    );
    expect(call).toBe(3);
    // Every silent leg is a round in which the MCP client can declare the call
    // hung: progress is the only currency that buys time.
    expect(legs).toEqual([1, 2]);
    expect(out).toContain("sent from primo");
    expect(out).toContain("trace was left on the card");
  });

  test("un rifiuto e' un ERRORE dello strumento, con la ragione", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse({ refused: true, reason: 'the person answered "Annulla"' }));
    await expect(
      callSendMail(args, { to: "a@esempio.test", subject: "x", body: "y" }, fetchImpl),
    ).rejects.toThrow(/nothing was done.*Annulla/);
  });

  test("finite le gambe si dice che NON e' partito niente", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse({ pending: true }));
    await expect(
      callSendMail(args, { to: "a@esempio.test", subject: "x", body: "y" }, fetchImpl, { maxLegs: 2 }),
    ).rejects.toThrow(/nothing was sent/);
  });

  test("un 400 e' una RISPOSTA: una POST sola, e l'agente legge l'errore vero", async () => {
    // `httpJson` throws on a lost socket AND on any status outside 2xx, and
    // the catch of the poll loop could not tell them apart: it counted the
    // answer as a transport failure, slept, and re-POSTED the same body. So
    // every talking error OUTBOUND-01 promises (missing variable, undeclared
    // account, refused attachment) reached the agent disguised as "I lost the
    // server", after a minute and a half of bouncing.
    let posts = 0;
    const fetchImpl = stubFetch(async () => {
      posts++;
      return new Response(JSON.stringify({ error: 'unknown account "terzo" (available: primo, secondo)', code: "unknown_account" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(
      callSendMail(args, { to: "a@esempio.test", subject: "x", body: "y", account: "terzo" }, fetchImpl, { backoffMs: [1] }),
    ).rejects.toThrow(/unknown account "terzo"/);
    expect(posts).toBe(1);
  });

  test("un 502 dopo la conferma NON si ri-manda: la seconda POST e' un secondo messaggio", async () => {
    // The worst shape of the same bug. The first leg already ran the CLI and
    // CONSUMED the confirmation; re-posting opens a NEW question for the same
    // message, and a person who says yes to it sends the mail twice.
    let posts = 0;
    const fetchImpl = stubFetch(async () => {
      posts++;
      return new Response(JSON.stringify({ error: "the CLI exited 1: quota exceeded", code: "send_failed" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    });
    await expect(
      callSendMail(args, { to: "a@esempio.test", subject: "x", body: "y" }, fetchImpl, { backoffMs: [1] }),
    ).rejects.toThrow(/quota exceeded/);
    expect(posts).toBe(1);
  });

  test("un socket caduto SI ritenta: e' l'unico caso che il giro esiste per coprire", async () => {
    let posts = 0;
    const fetchImpl = stubFetch(async () => {
      posts++;
      if (posts < 3) throw new TypeError("Unable to connect");
      return jsonResponse({ sent: true, account: "primo", to: "a@esempio.test", subject: "x" });
    });
    const out = await callSendMail(args, { to: "a@esempio.test", subject: "x", body: "y" }, fetchImpl, { backoffMs: [1] });
    expect(posts).toBe(3);
    expect(out).toContain("sent from primo");
  });

  test("il tetto anti-giro-a-vuoto resta un numero, non una vita", () => {
    expect(OUTBOUND_MAX_LEGS).toBeGreaterThan(100);
  });

  test("cio' che il modello scrive viaggia nel corpo della richiesta, non nel percorso", async () => {
    let seenBody: Record<string, unknown> | null = null;
    const fetchImpl = stubFetch(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ sent: true, account: "primo", to: "a@esempio.test", subject: "x" });
    });
    await callSendMail(
      args,
      { to: "a@esempio.test", subject: "x", body: "y", account: "secondo", attachments: ["report.pdf", 7] },
      fetchImpl,
    );
    expect(seenBody!.account).toBe("secondo");
    expect(seenBody!.attachments).toEqual(["report.pdf"]);
    expect(typeof seenBody!.legMs).toBe("number");
  });
});

describe("callGoogleCall", () => {
  test("una lettura risponde alla prima gamba e riporta l'uscita", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse({ ok: true, call: "calendar events list", output: '{"items":[]}' }));
    const out = await callGoogleCall(args, { service: "calendar", resource: "events", method: "list" }, fetchImpl);
    expect(out).toContain("calendar events list");
    expect(out).toContain('"items"');
  });

  test("params e body viaggiano come oggetti, e i campi obbligatori si dicono per nome", async () => {
    let seenBody: Record<string, unknown> | null = null;
    const fetchImpl = stubFetch(async (_input, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ ok: true, call: "drive files list" });
    });
    await expect(callGoogleCall(args, { resource: "files", method: "list" }, fetchImpl)).rejects.toThrow(/'service'/);
    await callGoogleCall(args, { service: "drive", resource: "files", method: "list", params: { pageSize: 5 } }, fetchImpl);
    expect(seenBody!.params).toEqual({ pageSize: 5 });
  });

  test("una scrittura rifiutata non diventa un successo silenzioso", async () => {
    const fetchImpl = stubFetch(async () => jsonResponse({ refused: true, reason: "nobody could confirm" }));
    await expect(
      callGoogleCall(args, { service: "calendar", resource: "events", method: "insert" }, fetchImpl),
    ).rejects.toThrow(/nothing was done/);
  });
});
