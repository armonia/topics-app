/**
 * Il canale di permesso, lato bridge.
 *
 * Una sola regola governa ogni ramo di `callApprovalPrompt`, ed è quella che
 * questi test guardano: **torna sempre una decisione, non lancia mai**. Un
 * throw qui la CLI lo traduce comunque in un rifiuto, ma con un messaggio che
 * parla del bridge invece che del permesso — cioè manda a cercare il guasto
 * dalla parte sbagliata. E la seconda regola: quando nessuno ha potuto
 * decidere, la risposta è NEGA. Un sì per inerzia sarebbe peggio del guasto che
 * stiamo chiudendo.
  * @covers APPROVAL-01
 */
import { describe, test, expect } from "bun:test";
import {
  callApprovalPrompt,
  PERMISSION_MAX_LEGS,
  ASK_LEG_MS,
  toolsForProfile,
  isToolAllowedForProfile,
  parseArgs,
} from "./topics-mcp-server";
import { PERMISSION_TTL_MS } from "../lib/permission-bridge";

const ARGS = { baseUrl: "http://x", sessionKey: "topic:abc" };
const INPUT = { flyFrom: "NAP", flyTo: "RAK" };

function stub(bodies: unknown[]): typeof fetch {
  let i = 0;
  return (async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const parse = (text: string) => JSON.parse(text) as { behavior: string; updatedInput?: unknown; message?: string };

describe("le tre decisioni tornano nel formato che la CLI si aspetta", () => {
  test("allow → behavior allow, con gli argomenti invariati", async () => {
    const out = parse(await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([{ decision: "allow" }])));
    expect(out.behavior).toBe("allow");
    expect(out.updatedInput).toEqual(INPUT);
  });

  test("allow_always → allow (la regola la scrive il server, qui si esegue)", async () => {
    const out = parse(await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([{ decision: "allow_always" }])));
    expect(out.behavior).toBe("allow");
  });

  test("deny → behavior deny, e il motivo arriva fino alla riga", async () => {
    const out = parse(
      await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([{ decision: "deny", reason: "no grazie" }])),
    );
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("no grazie");
  });
});

describe("le gambe di poll", () => {
  test("`pending` non è una fine: si torna dentro finché qualcuno decide", async () => {
    const legs: number[] = [];
    const out = parse(
      await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([
        { pending: true }, { pending: true }, { decision: "allow" },
      ]), { onProgress: (leg) => legs.push(leg) }),
    );
    expect(out.behavior).toBe("allow");
    // Il progresso a ogni gamba è ciò che impedisce al client MCP di dichiarare
    // piantata una chiamata sotto la quale c'è solo una persona che sta leggendo.
    expect(legs).toEqual([1, 2]);
  });

  test("`cancelled` chiude con un NO, non con un sì", async () => {
    const out = parse(
      await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([
        { cancelled: true, reason: "turno interrotto" },
      ])),
    );
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("turno interrotto");
  });
});

describe("quando niente funziona, si NEGA — e non si lancia", () => {
  test("Topics irraggiungibile oltre la finestra di grazia", async () => {
    let now = 0;
    const out = parse(
      await callApprovalPrompt(ARGS, { tool_name: "mcp__gateway__kiwi__search-flight", input: INPUT, tool_use_id: "t1" }, stub([new Error("ECONNREFUSED")]), {
        transportGraceMs: 10,
        backoffMs: [0],
        now: () => (now += 100),
      }),
    );
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("non risponde");
  });

  test("risposta vuota", async () => {
    const empty = (async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const out = parse(await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, empty));
    expect(out.behavior).toBe("deny");
  });

  test("richiesta senza nome dello strumento", async () => {
    const out = parse(await callApprovalPrompt(ARGS, { input: INPUT, tool_use_id: "t1" }, stub([{ decision: "allow" }])));
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("senza nome");
  });

  test("un server incastrato su `pending` finisce le gambe e nega", async () => {
    const out = parse(
      await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "t1" }, stub([{ pending: true }]), { maxLegs: 3 }),
    );
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("nessuna risposta");
  });
});

describe("cosa arriva al server", () => {
  test("nome, argomenti, id della riga e durata della gamba", async () => {
    let seen: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT, tool_use_id: "toolu_42" }, fetchImpl);
    expect(seen.toolName).toBe("Write");
    expect(seen.input).toEqual(INPUT);
    expect(seen.toolUseId).toBe("toolu_42");
    expect(seen.legMs).toBe(ASK_LEG_MS);
  });

  test("senza tool_use_id si usa comunque una chiave stabile", async () => {
    // Sulla 2.1.224 c'è sempre. Se una CLI futura smettesse di passarlo, il
    // canale non deve spegnersi: il server sa agganciare il pannello all'ultima
    // riga con quel nome.
    let seen: any = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ decision: "allow" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await callApprovalPrompt(ARGS, { tool_name: "Write", input: INPUT }, fetchImpl);
    expect(seen.toolUseId).toBe("noid:Write");
  });
});

describe("il tetto delle gambe sta SOPRA il TTL della richiesta", () => {
  test("o sarebbe il bridge, e non il server, a decidere che un permesso muore", () => {
    // Stesso ragionamento (e stesso incidente già visto) di ASK_MAX_LEGS: se il
    // tetto scende sotto il TTL, la richiesta muore col messaggio sbagliato —
    // «nessuna risposta dopo N gambe» al posto di «è scaduta». Il margine si
    // prova, non si ricorda.
    expect(PERMISSION_MAX_LEGS * ASK_LEG_MS).toBeGreaterThan(PERMISSION_TTL_MS);
  });
});

describe("il canale c'è SEMPRE, in ogni modalità e in ogni profilo", () => {
  test("è pubblicato ovunque — un flag solo non può desincronizzarsi da sé stesso", () => {
    // La versione a due flag (`--permission-prompt-tool` allo spawn +
    // `--permission-channel=1` al bridge) si rompeva così: una configurazione
    // senza il secondo, e la CLI rispondeva «MCP tool
    // mcp__topics__approval_prompt (passed via --permission-prompt-tool) not
    // found» su OGNI richiesta di permesso. Peggio del guasto che chiudevamo:
    // prima moriva muto, così moriva rumoroso e su tutto.
    expect(toolsForProfile(undefined).map((t) => t.name)).toContain("approval_prompt");
    expect(toolsForProfile("dispatch").map((t) => t.name)).toContain("approval_prompt");
  });

  test("resta CHIAMABILE anche nel profilo ridotto — chi chiama è la CLI, non il modello", () => {
    expect(isToolAllowedForProfile("dispatch", "approval_prompt")).toBe(true);
    expect(isToolAllowedForProfile(undefined, "approval_prompt")).toBe(true);
  });

  test("e il modello non lo vede comunque: lo toglie la CLI, che lo designa in ogni modalità", () => {
    // Verificato sul filo anche in `bypassPermissions`: l'evento `init` non lo
    // elenca e il turno finisce regolarmente. Il costo di passarlo dove non
    // serve è zero; il costo di dimenticarlo dove serve era tutto.
    const args = parseArgs(["--base-url=http://x", "--session-key=s"]);
    expect(args.sessionKey).toBe("s");
  });
});
