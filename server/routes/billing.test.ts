/**
 * La rotta del pagamento, e la riga che non deve mai essere attraversata.
 *
 * Il modo in cui un aggancio a Stripe si guasta è sempre lo stesso: il webhook
 * comincia a decidere cosa è concesso. Da quel momento chiunque riesca a
 * consegnare un `POST` — un evento rigiocato, un URL indovinato, un account
 * Stripe compromesso — guadagna una capacità sulla macchina di qualcun altro.
 *
 * Qui sotto il caso è preso di petto: un webhook con una FIRMA BUONA che porta
 * un gettone di licenza CONTRAFFATTO. L'evento è autentico, la rotta risponde
 * `200` perché l'ha capito — e la licenza resta `free`, perché il gettone passa
 * comunque dalla porta unica che lo riverifica con la chiave pubblica.
  * @covers LICENSE-03
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBillingRouter, isBillingWebhookPath } from "./billing";
import { creaServizioLicenza, type CaricoGettone } from "../lib/licenza";
import type { AppContext } from "../types";

const IID = "installazione-di-prova";
const SEGRETO_WH = "whsec_prova";
const ORA = 1_700_000_000_000;

function nuovaCoppia() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privata: privateKey, pubblicaB64: der.subarray(der.length - 32).toString("base64") };
}

/** Il servizio vero, con la sua chiave. */
const servizio = nuovaCoppia();
/** Una coppia che NON è quella del servizio: è con questa che si contraffà. */
const impostore = nuovaCoppia();

function gettone(privata: KeyObject, carico: Partial<CaricoGettone> = {}): string {
  const pieno: CaricoGettone = {
    v: 1, iid: IID, plan: "team", seats: 5, exp: ORA + 86_400_000, ...carico,
  };
  const p = Buffer.from(JSON.stringify(pieno), "utf8").toString("base64url");
  return `${p}.${sign(null, Buffer.from(p, "ascii"), privata).toString("base64url")}`;
}

let stateDir = "";
let svc: ReturnType<typeof creaServizioLicenza>;

function creaCtx(env: Record<string, string | undefined>, fetchImpl?: typeof fetch) {
  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => {
      try { return await req.json() as unknown; } catch { return null; }
    },
    relayConfig: () => ({ baseUrl: null, installationId: IID }),
    licenza: () => svc,
  } as unknown as AppContext;
  return createBillingRouter(ctx, { env, fetchImpl, now: () => ORA });
}

/** Firma un corpo come farebbe Stripe. */
function firmaStripe(corpo: string, segreto = SEGRETO_WH, tsMs = ORA): string {
  const t = Math.floor(tsMs / 1000);
  const d = createHmac("sha256", segreto).update(`${t}.${corpo}`, "utf8").digest("hex");
  return `t=${t},v1=${d}`;
}

type Router = ReturnType<typeof createBillingRouter>;

function chiama(router: Router, method: string, percorso: string, opt: {
  corpo?: string; header?: string | null;
} = {}): Promise<Response | null> {
  const url = new URL(`http://127.0.0.1:3333${percorso}`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opt.header) headers["stripe-signature"] = opt.header;
  const req = new Request(url, {
    method,
    headers,
    ...(opt.corpo !== undefined ? { body: opt.corpo } : {}),
  });
  return router(req, url, url.pathname, method) as Promise<Response | null>;
}

/** Manda un evento con una firma BUONA. Il default è quello che serve quasi
 *  sempre: l'evento è autentico, e ciò che si sta provando è cosa ne facciamo. */
async function evento(router: Router, corpoOggetto: unknown, opt: {
  segreto?: string; tsMs?: number; header?: string | null;
} = {}) {
  const corpo = JSON.stringify(corpoOggetto);
  const header = opt.header !== undefined
    ? opt.header
    : firmaStripe(corpo, opt.segreto ?? SEGRETO_WH, opt.tsMs ?? ORA);
  const r = await chiama(router, "POST", "/api/billing/webhook", { corpo, header });
  return { status: r?.status ?? 0, body: await r?.json() as Record<string, unknown> };
}

const checkoutCompletato = (token: string) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { client_reference_id: IID, metadata: { license_token: token } } },
});

const ENV_PIENO = {
  STRIPE_SECRET_KEY: "sk_test_finta", STRIPE_PRICE_ID: "price_finto",
  STRIPE_WEBHOOK_SECRET: SEGRETO_WH, STRIPE_API_BASE: "https://finto.example",
};

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "billing-"));
  svc = creaServizioLicenza({
    stateDir,
    env: { TOPICS_LICENSE_PUBKEYS: `k1:${servizio.pubblicaB64}` },
    installationId: IID,
    ora: () => ORA,
  });
});
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

describe("billing · lo stato non è un cancello", () => {
  it("senza configurazione risponde 200 e lo DICE", async () => {
    const r = await chiama(creaCtx({}), "GET", "/api/billing");
    expect(r?.status).toBe(200);
    expect(await r?.json()).toEqual({
      configured: false, webhookConfigured: false, installationId: IID,
    });
  });

  it("configurato lo dice, e della chiave non esce niente", async () => {
    const r = await chiama(creaCtx({ ...ENV_PIENO, STRIPE_SECRET_KEY: "sk_live_segretissimo" }), "GET", "/api/billing");
    const testo = await r?.text() ?? "";
    expect(JSON.parse(testo).configured).toBe(true);
    expect(testo).not.toContain("sk_live");
    expect(testo).not.toContain("segretissimo");
    expect(testo).not.toContain("whsec");
  });

  it("un percorso che non è suo lo lascia passare oltre", async () => {
    expect(await chiama(creaCtx(ENV_PIENO), "GET", "/api/topics")).toBeNull();
  });
});

describe("billing · il checkout", () => {
  it("senza configurazione rifiuta con un codice, non con un 5xx", async () => {
    const r = await chiama(creaCtx({}), "POST", "/api/billing/checkout", { corpo: "{}" });
    expect(r?.status).toBe(409);
    expect(await r?.json()).toEqual({ ok: false, code: "not_configured" });
  });

  it("gli indirizzi di ritorno vengono dall'ORIGINE, non dal corpo", async () => {
    let inviato = "";
    const router = creaCtx(ENV_PIENO, (async (_u: string, init: RequestInit) => {
      inviato = String(init.body);
      return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.example/c" }));
    }) as unknown as typeof fetch);
    // Un `success_url` scelto da chi chiama sarebbe un reindirizzamento aperto:
    // si paga sul dominio giusto e si atterra dove ha deciso qualcun altro.
    const r = await chiama(router, "POST", "/api/billing/checkout", {
      corpo: JSON.stringify({ seats: 4, success_url: "https://cattivo.example/rubato" }),
    });
    expect(await r?.json()).toEqual({ ok: true, url: "https://checkout.example/c", id: "cs_1" });
    const p = new URLSearchParams(inviato);
    expect(p.get("success_url")).toBe("http://127.0.0.1:3333/?billing=ok");
    expect(inviato).not.toContain("cattivo.example");
    expect(p.get("line_items[0][quantity]")).toBe("4");
  });
});

describe("billing · il webhook si autentica da solo", () => {
  it("senza segreto configurato non accetta niente — e 503, così Stripe riprova", async () => {
    const corpo = JSON.stringify(checkoutCompletato(gettone(servizio.privata)));
    const r = await chiama(creaCtx({}), "POST", "/api/billing/webhook", {
      corpo, header: firmaStripe(corpo),
    });
    expect(r?.status).toBe(503);
    expect(await r?.json()).toEqual({ ok: false, code: "no_secret" });
    // …e soprattutto non ha concesso niente.
    expect(svc.stato(ORA).piano).toBe("free");
  });

  it("firma assente o sbagliata → 400, e Stripe non riprova", async () => {
    const router = creaCtx(ENV_PIENO);
    const buono = checkoutCompletato(gettone(servizio.privata));

    const senza = await evento(router, buono, { header: null });
    expect(senza.status).toBe(400);
    expect(senza.body.code).toBe("missing_header");

    const altra = await evento(router, buono, { segreto: "whsec_altro" });
    expect(altra.status).toBe(400);
    expect(altra.body.code).toBe("bad_signature");

    expect(svc.stato(ORA).piano).toBe("free");
  });

  it("un evento RIGIOCATO fuori finestra viene respinto", async () => {
    const r = await evento(creaCtx(ENV_PIENO), checkoutCompletato(gettone(servizio.privata)), {
      tsMs: ORA - 600_000,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("too_old");
    expect(svc.stato(ORA).piano).toBe("free");
  });

  it("un corpo manomesso DOPO la firma non passa", async () => {
    const corpo = JSON.stringify(checkoutCompletato(gettone(servizio.privata)));
    const header = firmaStripe(corpo);
    const manomesso = corpo.replace('"seats"', '"seats_"');
    const r = await chiama(creaCtx(ENV_PIENO), "POST", "/api/billing/webhook", {
      corpo: manomesso === corpo ? corpo + " " : manomesso, header,
    });
    expect(r?.status).toBe(400);
    expect((await r?.json()).code).toBe("bad_signature");
  });
});

describe("billing · Stripe non concede niente da solo", () => {
  it("LA RIGA: firma buona + gettone CONTRAFFATTO ⇒ resta `free`", async () => {
    const finto = gettone(impostore.privata, { seats: 9999 });
    const r = await evento(creaCtx(ENV_PIENO), checkoutCompletato(finto));

    // L'evento è autentico e lo abbiamo capito: `200`, non un errore.
    expect(r.status).toBe(200);
    expect(r.body.action).toBe("install_token");
    // Ma il gettone è passato dalla porta unica, che l'ha rifiutato.
    expect(r.body.applied).toBe(false);
    expect(r.body.reason).toBe("bad_signature");

    const stato = svc.stato(ORA);
    expect(stato.piano).toBe("free");
    expect(stato.posti).toBe(1);
    expect(stato.accessoRemoto).toBe(false);
  });

  it("un gettone per un'ALTRA installazione non vale qui", async () => {
    const altrui = gettone(servizio.privata, { iid: "un-altra-macchina" });
    const r = await evento(creaCtx(ENV_PIENO), checkoutCompletato(altrui));
    expect(r.body.applied).toBe(false);
    expect(r.body.reason).toBe("other_installation");
    expect(svc.stato(ORA).piano).toBe("free");
  });

  it("un gettone SCADUTO non vale", async () => {
    const vecchio = gettone(servizio.privata, { exp: ORA - 1 });
    const r = await evento(creaCtx(ENV_PIENO), checkoutCompletato(vecchio));
    expect(r.body.applied).toBe(false);
    expect(r.body.reason).toBe("expired");
    expect(svc.stato(ORA).piano).toBe("free");
  });

  // ── Il controllo POSITIVO. Senza di lui i test qui sopra sarebbero verdi
  //    anche con un webhook che non fa NIENTE, e non dimostrerebbero niente.
  it("col gettone VERO, invece, la licenza si installa davvero", async () => {
    const vero = gettone(servizio.privata, { seats: 5 });
    const r = await evento(creaCtx(ENV_PIENO), checkoutCompletato(vero));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "install_token", applied: true, reason: "valid" });

    const stato = svc.stato(ORA);
    expect(stato.piano).toBe("team");
    expect(stato.posti).toBe(5);
    expect(stato.accessoRemoto).toBe(true);
  });
});

describe("billing · il ciclo dell'abbonamento", () => {
  /** Porta l'installazione sul piano a pagamento, per poterlo poi perdere. */
  async function attiva(router: Router) {
    const r = await evento(router, checkoutCompletato(gettone(servizio.privata)));
    expect(r.body.applied).toBe(true);
    expect(svc.stato(ORA).piano).toBe("team");
  }

  it("la disdetta riporta al piano gratuito", async () => {
    const router = creaCtx(ENV_PIENO);
    await attiva(router);

    const r = await evento(router, {
      id: "evt_2", type: "customer.subscription.deleted",
      data: { object: { metadata: { installation_id: IID } } },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "remove_license", applied: true });
    expect(svc.stato(ORA).piano).toBe("free");
  });

  it("una disdetta per un'ALTRA macchina non tocca la nostra licenza", async () => {
    const router = creaCtx(ENV_PIENO);
    await attiva(router);

    const r = await evento(router, {
      id: "evt_3", type: "customer.subscription.deleted",
      data: { object: { metadata: { installation_id: "non-sono-io" } } },
    });
    expect(r.body).toMatchObject({ action: "ignore", applied: false, reason: "other_installation" });
    // Il punto: la licenza è ancora qui.
    expect(svc.stato(ORA).piano).toBe("team");
  });

  it("`past_due` non spegne niente: il rinnovo sta ancora ritentando", async () => {
    const router = creaCtx(ENV_PIENO);
    await attiva(router);

    await evento(router, {
      id: "evt_4", type: "customer.subscription.updated",
      data: { object: { status: "past_due", metadata: { installation_id: IID } } },
    });
    expect(svc.stato(ORA).piano).toBe("team");
  });

  it("un tipo di evento che non ci interessa è `200` e non fa niente", async () => {
    const router = creaCtx(ENV_PIENO);
    await attiva(router);

    const r = await evento(router, { id: "evt_5", type: "invoice.created", data: { object: {} } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "ignore", reason: "unhandled_type" });
    expect(svc.stato(ORA).piano).toBe("team");
  });

  it("un corpo firmato ma che non è un evento è `400`", async () => {
    const r = await evento(creaCtx(ENV_PIENO), { non: "un evento" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("not_an_event");
  });
});

describe("billing · il percorso esente dall'identità è UNO SOLO", () => {
  it("solo il webhook, e non il resto della rotta", () => {
    expect(isBillingWebhookPath("/api/billing/webhook")).toBe(true);
    for (const p of ["/api/billing", "/api/billing/checkout", "/api/license", "/api/topics"]) {
      expect(isBillingWebhookPath(p)).toBe(false);
    }
  });
});
