/**
 * Il servizio di conio, provato dove può fare danno.
 *
 * Tre cose sono presidiate qui e non altrove:
 *   1. **il ciclo si ferma** — scrivere il gettone nei metadati genera l'evento
 *      che torna qui, e senza uno stop il servizio scriverebbe per sempre;
 *   2. **non si conia a chi non ha pagato** — è l'unico errore di questo file
 *      che regala prodotto;
 *   3. **il gettone coniato VERIFICA davvero** sull'installazione giusta, con
 *      la stessa funzione che gira nell'app spedita. Un gettone che esce ma non
 *      verifica è indistinguibile, dal lato cliente, da nessun gettone.
  * @covers MINT-01
 */
import { describe, expect, it } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import {
  decidiConio, creaGestoreConio, leggiConfigConio, scriviGettone,
  GRAZIA_MS, TOLLERANZA_SCADENZA_MS,
} from "./conio-licenze";
import type { FetchLike } from "./conio-licenze";
import { caricaPrivata, coniaGettone, leggiCaricoNonVerificato } from "./conio-lib";
import { caricaChiavi, verificaGettone } from "../server/lib/licenza";

// ─────────────────────────────────────────────────────────────────────────────
// Una coppia di prova (NON quella di produzione: quella non sta in un file)
// ─────────────────────────────────────────────────────────────────────────────

const coppia = generateKeyPairSync("ed25519");
const PRIV_B64 = coppia.privateKey.export({ type: "pkcs8", format: "der" })
  .subarray(-32).toString("base64url");
const PUB_B64 = coppia.publicKey.export({ type: "spki", format: "der" })
  .subarray(-32).toString("base64url");
const CHIAVE = (() => {
  const c = caricaPrivata(PRIV_B64);
  if (!c.ok) throw new Error("la coppia di prova non si carica");
  return c.chiave;
})();

const IID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const ORA = 1_760_000_000_000;
const FINE_PERIODO_S = Math.floor(ORA / 1000) + 30 * 86_400;
const EXPIRY_WAIT = FINE_PERIODO_S * 1000 + GRAZIA_MS;
const SEGRETO = "whsec_prova";

function abbonamento(extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    id: "sub_123",
    status: "active",
    current_period_end: FINE_PERIODO_S,
    items: { data: [{ quantity: 5, price: { id: "price_1" } }] },
    metadata: { installation_id: IID, ...meta },
    ...extra,
  };
}

function evento(type: string, oggetto: unknown, id = "evt_1") {
  return { id, type, data: { object: oggetto } };
}

// ─────────────────────────────────────────────────────────────────────────────
// La decisione
// ─────────────────────────────────────────────────────────────────────────────

describe("conio · quando si conia", () => {
  it("un abbonamento nuovo, attivo e con installazione: si conia", () => {
    const d = decidiConio(evento("customer.subscription.created", abbonamento()));
    expect(d).toEqual({
      tipo: "conia",
      subscriptionId: "sub_123",
      installationId: IID,
      posti: 5,
      scadenza: EXPIRY_WAIT,
    });
  });

  it("la scadenza è la fine del periodo PIÙ la grazia, non la fine del periodo", () => {
    const d = decidiConio(evento("customer.subscription.created", abbonamento()));
    if (d.tipo !== "conia") throw new Error("doveva coniare");
    // Il verso in cui si sbaglia: qualche giorno in più a chi ha smesso, mai un
    // minuto in meno a chi paga mentre il rinnovo è in volo.
    expect(d.scadenza).toBeGreaterThan(FINE_PERIODO_S * 1000);
  });

  it("i posti si sommano su TUTTE le righe, non si legge solo la prima", () => {
    const d = decidiConio(evento("customer.subscription.updated", abbonamento({
      items: { data: [{ quantity: 3 }, { quantity: 4 }] },
    })));
    if (d.tipo !== "conia") throw new Error("doveva coniare");
    expect(d.posti).toBe(7);
  });

  it("se le righe non dicono i posti si ripiega su `quantity`, non su 1", () => {
    const d = decidiConio(evento("customer.subscription.updated", abbonamento({
      items: { data: [{}] }, quantity: 9,
    })));
    if (d.tipo !== "conia") throw new Error("doveva coniare");
    expect(d.posti).toBe(9);
  });

  it("la fine periodo sulla RIGA vale quanto quella sull'abbonamento (API recenti)", () => {
    const sub = abbonamento({
      current_period_end: undefined,
      items: { data: [{ quantity: 2, current_period_end: FINE_PERIODO_S }] },
    });
    const d = decidiConio(evento("customer.subscription.updated", sub));
    if (d.tipo !== "conia") throw new Error("doveva coniare");
    expect(d.scadenza).toBe(EXPIRY_WAIT);
  });

  it("`trialing` conia: la prova è servizio concesso, e senza gettone non c'è", () => {
    const d = decidiConio(evento("customer.subscription.created", abbonamento({ status: "trialing" })));
    expect(d.tipo).toBe("conia");
  });

  it("`past_due` conia ancora: la carta scaduta si ritenta, e spegnere al primo tentativo è un cliente perso per un guasto suo", () => {
    const d = decidiConio(evento("customer.subscription.updated", abbonamento({ status: "past_due" })));
    expect(d.tipo).toBe("conia");
  });
});

describe("conio · lo stop al ciclo", () => {
  // Questa è LA prova del file. La scrittura del gettone genera un
  // `customer.subscription.updated` che torna qui: senza «already_minted» il
  // servizio scrive, si risveglia, riscrive, per sempre.
  it("l'evento generato dalla nostra stessa scrittura non fa coniare di nuovo", () => {
    const gettone = coniaGettone({
      installationId: IID, posti: 5, scadenza: EXPIRY_WAIT, adesso: ORA, chiave: CHIAVE,
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: gettone })));
    expect(d).toEqual({ tipo: "niente", perche: "already_minted" });
  });

  it("ma al RINNOVO sì: il periodo si è spostato e il gettone vecchio scadrebbe prima", () => {
    const vecchio = coniaGettone({
      installationId: IID, posti: 5, scadenza: ORA + 86_400_000, adesso: ORA, chiave: CHIAVE,
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: vecchio })));
    expect(d.tipo).toBe("conia");
  });

  it("e se cambiano i posti sì: chi compra tre postazioni in più le vuole adesso", () => {
    const vecchio = coniaGettone({
      installationId: IID, posti: 5, scadenza: EXPIRY_WAIT, adesso: ORA, chiave: CHIAVE,
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({ items: { data: [{ quantity: 8 }] } }, { license_token: vecchio })));
    if (d.tipo !== "conia") throw new Error("doveva riconiare");
    expect(d.posti).toBe(8);
  });

  it("un gettone di UN'ALTRA installazione nei metadati non conta come già coniato", () => {
    const altrui = coniaGettone({
      installationId: "bbbbbbbbbbbbbbbbbbbbbbbb", posti: 5, scadenza: EXPIRY_WAIT,
      adesso: ORA, chiave: CHIAVE,
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: altrui })));
    expect(d.tipo).toBe("conia");
  });

  it("dopo una rotazione di chiave si riconia, anche se il vecchio gettone è ancora buono", () => {
    const vecchio = coniaGettone({
      installationId: IID, posti: 5, scadenza: EXPIRY_WAIT, adesso: ORA,
      chiave: CHIAVE, kid: "armonia-1",
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: vecchio })), { kid: "armonia-2" });
    expect(d.tipo).toBe("conia");
  });

  it("un `license_token` spazzatura non blocca il conio (né fa esplodere niente)", () => {
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: "non-un-gettone" })));
    expect(d.tipo).toBe("conia");
  });

  it("la tolleranza è un giorno, non un istante: un secondo di deriva non fa riscrivere", () => {
    const gettone = coniaGettone({
      installationId: IID, posti: 5,
      scadenza: EXPIRY_WAIT - TOLLERANZA_SCADENZA_MS + 1_000,
      adesso: ORA, chiave: CHIAVE,
    });
    const d = decidiConio(evento("customer.subscription.updated",
      abbonamento({}, { license_token: gettone })));
    expect(d).toEqual({ tipo: "niente", perche: "already_minted" });
  });
});

describe("conio · quando NON si conia", () => {
  it("un abbonamento disdetto non riceve niente", () => {
    for (const stato of ["canceled", "unpaid", "incomplete_expired"]) {
      expect(decidiConio(evento("customer.subscription.updated", abbonamento({ status: stato }))))
        .toEqual({ tipo: "niente", perche: "subscription_over" });
    }
  });

  it("`incomplete` è un checkout a metà: coniare lì regalerebbe un anno", () => {
    expect(decidiConio(evento("customer.subscription.created", abbonamento({ status: "incomplete" }))))
      .toEqual({ tipo: "niente", perche: "not_paid_yet" });
  });

  it("senza installazione nei metadati non c'è nessuno per cui coniare", () => {
    const sub = abbonamento();
    sub.metadata = {} as never;
    expect(decidiConio(evento("customer.subscription.created", sub)))
      .toEqual({ tipo: "niente", perche: "no_installation_id" });
  });

  it("senza fine periodo non si inventa una scadenza", () => {
    expect(decidiConio(evento("customer.subscription.created",
      abbonamento({ current_period_end: undefined, items: { data: [{ quantity: 5 }] } }))))
      .toEqual({ tipo: "niente", perche: "no_period_end" });
  });

  it("posti fuori scala si fermano prima della firma", () => {
    expect(decidiConio(evento("customer.subscription.created",
      abbonamento({ items: { data: [{ quantity: 999_999 }] } }))))
      .toEqual({ tipo: "niente", perche: "bad_seats" });
  });

  it("`checkout.session.completed` non conia: la sessione non porta né posti né periodo", () => {
    // Non è una dimenticanza: per un abbonamento Stripe emette comunque
    // `customer.subscription.created` subito dopo, con tutto quel che serve.
    expect(decidiConio(evento("checkout.session.completed", { id: "cs_1", client_reference_id: IID })))
      .toEqual({ tipo: "niente", perche: "unhandled_type" });
  });

  it("gli eventi che non conosciamo sono `ignore`, non errori", () => {
    expect(decidiConio(evento("invoice.paid", { id: "in_1" })))
      .toEqual({ tipo: "niente", perche: "unhandled_type" });
  });

  it("un corpo che non è un evento non solleva", () => {
    for (const c of [null, 42, "ciao", [], {}, { id: "evt" }]) {
      expect(decidiConio(c)).toEqual({ tipo: "niente", perche: "not_an_event" });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Il gettone coniato deve VERIFICARE nell'app spedita
// ─────────────────────────────────────────────────────────────────────────────

describe("conio · il gettone che esce vale davvero", () => {
  const chiavi = caricaChiavi({}, [`armonia-prova:${PUB_B64}`]);

  it("verifica sull'installazione giusta e dà i posti pagati", () => {
    const d = decidiConio(evento("customer.subscription.created", abbonamento()));
    if (d.tipo !== "conia") throw new Error("doveva coniare");
    const g = coniaGettone({
      installationId: d.installationId, posti: d.posti, scadenza: d.scadenza,
      adesso: ORA, chiave: CHIAVE, kid: "armonia-prova",
    });
    const e = verificaGettone(g, { chiavi, installationId: IID, ora: ORA });
    expect(e.piano).toBe("team");
    expect(e.posti).toBe(5);
    expect(e.motivo).toBe("valid");
  });

  it("lo stesso gettone su un'ALTRA macchina non concede niente", () => {
    const g = coniaGettone({
      installationId: IID, posti: 5, scadenza: EXPIRY_WAIT, adesso: ORA,
      chiave: CHIAVE, kid: "armonia-prova",
    });
    const e = verificaGettone(g, { chiavi, installationId: "cccccccccccccccccccccccc", ora: ORA });
    expect(e.piano).toBe("free");
  });

  it("`leggiCaricoNonVerificato` legge ciò che abbiamo firmato (è la base dello stop al ciclo)", () => {
    const g = coniaGettone({
      installationId: IID, posti: 5, scadenza: EXPIRY_WAIT, adesso: ORA, chiave: CHIAVE,
    });
    expect(leggiCaricoNonVerificato(g)).toEqual({
      iid: IID, seats: 5, exp: EXPIRY_WAIT, kid: "armonia-1",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Il gestore HTTP: firma, risposte, e la scrittura su Stripe
// ─────────────────────────────────────────────────────────────────────────────

function signedRequest(corpo: unknown, segreto = SEGRETO, ora = ORA): Request {
  const testo = JSON.stringify(corpo);
  const t = Math.floor(ora / 1000);
  const v1 = createHmac("sha256", segreto).update(`${t}.${testo}`, "utf8").digest("hex");
  return new Request("http://127.0.0.1/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${v1}`, "content-type": "application/json" },
    body: testo,
  });
}

const FULL_CONFIG = () => leggiConfigConio({
  TOPICS_LICENSE_PRIVKEY: PRIV_B64,
  CONIO_WEBHOOK_SECRET: SEGRETO,
  STRIPE_SECRET_KEY: "sk_prova",
  STRIPE_API_BASE: "https://finto.stripe",
  TOPICS_LICENSE_KID: "armonia-prova",
});

describe("conio · il gestore del webhook", () => {
  it("conia e SCRIVE il gettone nei metadati dell'abbonamento", async () => {
    const chiamate: Array<{ url: string; body: string; headers: Headers }> = [];
    const finto: FetchLike = async (u, init) => {
      chiamate.push({
        url: String(u),
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
      });
      return new Response("{}", { status: 200 });
    };
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, fetchImpl: finto, log: () => {},
    });

    const r = await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ minted: true, seats: 5 });

    expect(chiamate).toHaveLength(1);
    expect(chiamate[0]!.url).toBe("https://finto.stripe/v1/subscriptions/sub_123");
    // Idempotenza: la riconsegna dello STESSO evento non è una seconda scrittura.
    expect(chiamate[0]!.headers.get("idempotency-key")).toBe("conio:evt_1");

    // E il gettone scritto è quello che l'installazione saprà verificare.
    const scritto = new URLSearchParams(chiamate[0]!.body).get("metadata[license_token]")!;
    const e = verificaGettone(scritto, {
      chiavi: caricaChiavi({}, [`armonia-prova:${PUB_B64}`]),
      installationId: IID,
      ora: ORA,
    });
    expect(e.piano).toBe("team");
    expect(e.posti).toBe(5);
  });

  it("scrive SOLO `license_token`: `installation_id` non si tocca", async () => {
    let corpo = "";
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, log: () => {},
      fetchImpl: async (_u, init) => { corpo = String(init?.body ?? ""); return new Response("{}"); },
    });
    await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect([...new URLSearchParams(corpo).keys()]).toEqual(["metadata[license_token]"]);
  });

  it("una firma sbagliata è `400` e NON tocca Stripe", async () => {
    let toccato = false;
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, log: () => {},
      fetchImpl: async () => { toccato = true; return new Response("{}"); },
    });
    const r = await g(signedRequest(evento("customer.subscription.created", abbonamento()), "whsec_altro"));
    expect(r.status).toBe(400);
    expect(toccato).toBe(false);
  });

  it("senza segreto del webhook è `503`: è una configurazione da sistemare, e Stripe deve ritentare", async () => {
    const g = creaGestoreConio({
      config: () => leggiConfigConio({ TOPICS_LICENSE_PRIVKEY: PRIV_B64 }),
      now: () => ORA, log: () => {},
    });
    const r = await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect(r.status).toBe(503);
  });

  it("chiave privata assente ma evento buono: `503`, perché uno ha pagato e non ha ricevuto", async () => {
    const righe: string[] = [];
    const g = creaGestoreConio({
      config: () => leggiConfigConio({
        CONIO_WEBHOOK_SECRET: SEGRETO, STRIPE_SECRET_KEY: "sk_prova",
      }),
      now: () => ORA, log: (r) => righe.push(r),
    });
    const r = await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect(r.status).toBe(503);
    expect(righe.join("\n")).toContain("ALLARME");
  });

  it("Stripe che rifiuta la scrittura è `500`: quello va ritentato", async () => {
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, log: () => {},
      fetchImpl: async () => new Response("no", { status: 402 }),
    });
    const r = await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect(r.status).toBe(500);
  });

  it("un evento che non ci riguarda è `200` e non chiama nessuno", async () => {
    let toccato = false;
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, log: () => {},
      fetchImpl: async () => { toccato = true; return new Response("{}"); },
    });
    const r = await g(signedRequest(evento("invoice.paid", { id: "in_1" })));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ minted: false, reason: "unhandled_type" });
    expect(toccato).toBe(false);
  });

  it("il gettone NON finisce nei log: una riga di log è il posto meno sorvegliato dove possa stare una licenza", async () => {
    const righe: string[] = [];
    let scritto = "";
    const g = creaGestoreConio({
      config: FULL_CONFIG, now: () => ORA, log: (r) => righe.push(r),
      fetchImpl: async (_u, init) => {
        scritto = new URLSearchParams(String(init?.body ?? "")).get("metadata[license_token]") ?? "";
        return new Response("{}");
      },
    });
    await g(signedRequest(evento("customer.subscription.created", abbonamento())));
    expect(scritto.length).toBeGreaterThan(50);
    expect(righe.join("\n")).not.toContain(scritto);
    expect(righe.join("\n")).toContain(IID);
  });

  it("una GET non è un webhook", async () => {
    const g = creaGestoreConio({ config: FULL_CONFIG, now: () => ORA, log: () => {} });
    const r = await g(new Request("http://127.0.0.1/webhook"));
    expect(r.status).toBe(405);
  });
});

describe("conio · la scrittura su Stripe non solleva mai", () => {
  it("una rete che non risponde torna `unreachable`", async () => {
    const e = await scriviGettone({
      apiBase: "https://finto.stripe", secretKey: "sk", subscriptionId: "sub_1",
      gettone: "g", eventId: "evt_1",
      fetchImpl: async () => { throw new Error("giù"); },
    });
    expect(e).toEqual({ ok: false, codice: "unreachable" });
  });

  it("la chiave Stripe va nell'header e non nel corpo", async () => {
    // In un oggetto e non in due `let`: TS non segue le assegnazioni fatte
    // dentro una callback, quindi `auth` resterebbe stretto a `null` e il
    // confronto qui sotto non compilerebbe.
    const visto: { auth: string | null; corpo: string } = { auth: null, corpo: "" };
    await scriviGettone({
      apiBase: "https://finto.stripe", secretKey: "sk_segretissima", subscriptionId: "sub_1",
      gettone: "g", eventId: "evt_1",
      fetchImpl: async (_u, init) => {
        visto.auth = new Headers(init?.headers).get("authorization");
        visto.corpo = String(init?.body ?? "");
        return new Response("{}");
      },
    });
    expect(visto.auth).toBe("Bearer sk_segretissima");
    expect(visto.corpo).not.toContain("sk_segretissima");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La configurazione
// ─────────────────────────────────────────────────────────────────────────────

describe("conio · la configurazione", () => {
  it("un ambiente vuoto non solleva: dice solo che manca tutto", () => {
    const c = leggiConfigConio({});
    expect(c.privata).toBeNull();
    expect(c.webhookSecret).toBeNull();
    expect(c.secretKey).toBeNull();
    expect(c.apiBase).toBe("https://api.stripe.com");
  });

  it("una variabile di soli spazi vale assente, non «configurato male»", () => {
    const c = leggiConfigConio({ CONIO_WEBHOOK_SECRET: "   ", STRIPE_SECRET_KEY: "" });
    expect(c.webhookSecret).toBeNull();
    expect(c.secretKey).toBeNull();
  });

  it("una privata storta non diventa una chiave a metà", () => {
    expect(leggiConfigConio({ TOPICS_LICENSE_PRIVKEY: "troppo-corta" }).privata).toBeNull();
    expect(caricaPrivata("troppo-corta")).toEqual({ ok: false, motivo: "lunghezza" });
  });
});
