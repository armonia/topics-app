/**
 * L'adattatore di Stripe, e le due cose che deve fare bene.
 *
 * La PRIMA è la firma: è l'unica ragione per cui crediamo che un evento venga
 * da Stripe e non da chiunque abbia indovinato l'URL. Il vettore qui sotto è
 * calcolato con `openssl` — un'implementazione indipendente da quella in prova
 * — apposta perché ricalcolare l'atteso con la stessa funzione che si sta
 * verificando è un test che passa anche quando la costruzione è sbagliata: se
 * qualcuno togliesse il timestamp dal carico, o il prefisso `whsec_` dalla
 * chiave, un test «simmetrico» resterebbe verde e questo diventa rosso.
 *
 * La SECONDA è che senza configurazione non succede niente di brutto. Non è un
 * dettaglio da sviluppo: è lo stato di ogni installazione che non paga, cioè
 * quella della maggior parte delle persone.
 *
 * @covers LICENSE-03
 */
import { describe, expect, it } from "bun:test";
import {
  leggiConfigStripe, statoPubblico, verificaFirmaWebhook, interpretaEvento,
  creaCheckout, TOLLERANZA_MS, POSTI_MAX_CHECKOUT,
} from "./stripe";

// ── Il vettore indipendente ──────────────────────────────────────────────────
// openssl dgst -sha256 -hmac 'whsec_test_secret' su `1699999999.{corpo}`.
const SEGRETO = "whsec_test_secret";
const CORPO = '{"id":"evt_1","type":"ping"}';
const TS = 1699999999;
const DIGEST = "3772cc261576fa0fae84663f353dddd0cc97eb66a336bb62dd84b2943ea9698b";
/** Un istante dentro la tolleranza, così i test non dipendono dall'orologio. */
const ORA = TS * 1000 + 1_000;

const header = (t: number | string, ...v1: string[]) =>
  [`t=${t}`, ...v1.map((v) => `v1=${v}`)].join(",");

describe("stripe · la configurazione viene solo dall'ambiente", () => {
  it("senza variabili non è configurato, e non solleva", () => {
    const c = leggiConfigStripe({});
    expect(c.secretKey).toBeNull();
    expect(c.webhookSecret).toBeNull();
    expect(c.priceId).toBeNull();
    expect(c.apiBase).toBe("https://api.stripe.com");
    expect(statoPubblico(c)).toEqual({ configured: false, webhookConfigured: false });
  });

  it("una variabile vuota o di soli spazi vale ASSENTE", () => {
    const c = leggiConfigStripe({ STRIPE_SECRET_KEY: "   ", STRIPE_PRICE_ID: "" });
    expect(c.secretKey).toBeNull();
    expect(statoPubblico(c).configured).toBe(false);
  });

  it("uno spazio DENTRO il valore è un incollaggio storto, non una chiave", () => {
    expect(leggiConfigStripe({ STRIPE_SECRET_KEY: "sk_test abc" }).secretKey).toBeNull();
  });

  it("il checkout vuole chiave E listino: una sola non basta", () => {
    expect(statoPubblico(leggiConfigStripe({ STRIPE_SECRET_KEY: "sk_test_x" })).configured).toBe(false);
    expect(statoPubblico(leggiConfigStripe({ STRIPE_PRICE_ID: "price_x" })).configured).toBe(false);
    expect(statoPubblico(leggiConfigStripe({
      STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_x",
    })).configured).toBe(true);
  });

  it("il webhook è un asse SEPARATO dal checkout", () => {
    const c = leggiConfigStripe({ STRIPE_WEBHOOK_SECRET: SEGRETO });
    expect(statoPubblico(c)).toEqual({ configured: false, webhookConfigured: true });
  });

  it("statoPubblico non lascia trapelare NIENTE della chiave", () => {
    const c = leggiConfigStripe({
      STRIPE_SECRET_KEY: "sk_live_supersegretissimo", STRIPE_PRICE_ID: "price_x",
      STRIPE_WEBHOOK_SECRET: SEGRETO,
    });
    // Il canale di osservazione funziona (è `true`, non un oggetto vuoto), e
    // dentro non c'è un pezzo del segreto in nessuna forma.
    const s = statoPubblico(c);
    expect(s.configured).toBe(true);
    const serializzato = JSON.stringify(s);
    expect(serializzato).not.toContain("sk_live");
    expect(serializzato).not.toContain("supersegretissimo");
    expect(serializzato).not.toContain("whsec");
  });

  it("STRIPE_API_BASE si normalizza, e ciò che non è http(s) si ignora", () => {
    expect(leggiConfigStripe({ STRIPE_API_BASE: "https://finto.example/v/" }).apiBase)
      .toBe("https://finto.example/v");
    expect(leggiConfigStripe({ STRIPE_API_BASE: "file:///etc/passwd" }).apiBase)
      .toBe("https://api.stripe.com");
  });
});

describe("stripe · la firma del webhook", () => {
  it("accetta il vettore calcolato da openssl", () => {
    expect(verificaFirmaWebhook(CORPO, header(TS, DIGEST), SEGRETO, ORA)).toEqual({ ok: true });
  });

  it("un corpo cambiato di UN carattere non passa più", () => {
    const alterato = CORPO.replace("ping", "pong");
    expect(verificaFirmaWebhook(alterato, header(TS, DIGEST), SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "bad_signature" });
  });

  it("un segreto diverso non passa", () => {
    expect(verificaFirmaWebhook(CORPO, header(TS, DIGEST), "whsec_altro", ORA))
      .toEqual({ ok: false, motivo: "bad_signature" });
  });

  it("il timestamp è DENTRO ciò che si firma: cambiarlo invalida", () => {
    expect(verificaFirmaWebhook(CORPO, header(TS + 1, DIGEST), SEGRETO, ORA + 1000))
      .toEqual({ ok: false, motivo: "bad_signature" });
  });

  it("senza segreto non si accetta NIENTE, nemmeno una firma buona", () => {
    expect(verificaFirmaWebhook(CORPO, header(TS, DIGEST), null, ORA))
      .toEqual({ ok: false, motivo: "no_secret" });
  });

  it("header assente o vuoto", () => {
    expect(verificaFirmaWebhook(CORPO, null, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "missing_header" });
    expect(verificaFirmaWebhook(CORPO, "   ", SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "missing_header" });
  });

  it("header senza `t` o senza `v1` è malformato, non «firma sbagliata»", () => {
    expect(verificaFirmaWebhook(CORPO, `v1=${DIGEST}`, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "malformed_header" });
    expect(verificaFirmaWebhook(CORPO, `t=${TS}`, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "malformed_header" });
  });

  it("un `t` non numerico è `bad_timestamp`, non uno zero che diventa «vecchio»", () => {
    // Senza il controllo di forma, `Number("")` darebbe 0 → 1970 → `too_old`,
    // e un header rotto si travestirebbe da rigioco.
    expect(verificaFirmaWebhook(CORPO, `t=,v1=${DIGEST}`, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "bad_timestamp" });
    expect(verificaFirmaWebhook(CORPO, `t=abc,v1=${DIGEST}`, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "bad_timestamp" });
  });

  it("fuori tolleranza è un RIGIOCO, e si vede dal motivo", () => {
    const tardi = ORA + TOLLERANZA_MS + 1;
    expect(verificaFirmaWebhook(CORPO, header(TS, DIGEST), SEGRETO, tardi))
      .toEqual({ ok: false, motivo: "too_old" });
    // …e appena dentro la finestra passa ancora: senza questo, il test sopra
    // sarebbe verde anche con una tolleranza di zero.
    expect(verificaFirmaWebhook(CORPO, header(TS, DIGEST), SEGRETO, TS * 1000 + TOLLERANZA_MS))
      .toEqual({ ok: true });
  });

  it("più `v1` (rotazione del segreto): ne basta UNO buono", () => {
    const h = header(TS, "0".repeat(64), DIGEST);
    expect(verificaFirmaWebhook(CORPO, h, SEGRETO, ORA)).toEqual({ ok: true });
  });

  it("`v0` non vale: è lo schema vecchio e non lo si accetta", () => {
    expect(verificaFirmaWebhook(CORPO, `t=${TS},v0=${DIGEST}`, SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "malformed_header" });
  });

  it("spazi attorno ai pezzi non cambiano l'esito", () => {
    expect(verificaFirmaWebhook(CORPO, ` t=${TS} , v1=${DIGEST} `, SEGRETO, ORA))
      .toEqual({ ok: true });
  });

  it("una firma di lunghezza diversa non fa esplodere il confronto", () => {
    // `timingSafeEqual` solleva su lunghezze diverse: senza la guardia questo
    // sarebbe un `500` su un header malevolo, cioè un modo per far riprovare
    // Stripe all'infinito.
    expect(verificaFirmaWebhook(CORPO, header(TS, "abc"), SEGRETO, ORA))
      .toEqual({ ok: false, motivo: "bad_signature" });
  });
});

describe("stripe · dall'evento all'azione", () => {
  const evento = (type: string, dato: Record<string, unknown> = {}) =>
    ({ id: "evt_1", type, data: { object: dato } });

  it("un corpo che non è un evento torna null", () => {
    expect(interpretaEvento(null)).toBeNull();
    expect(interpretaEvento("stringa")).toBeNull();
    expect(interpretaEvento({ type: "x" })).toBeNull();      // manca id
    expect(interpretaEvento({ id: "evt_1" })).toBeNull();    // manca type
  });

  it("il checkout completato con un gettone lo CONSEGNA alla porta unica", () => {
    const e = interpretaEvento(evento("checkout.session.completed", {
      client_reference_id: "iid-1",
      metadata: { license_token: "carico.firma" },
    }));
    expect(e?.installationId).toBe("iid-1");
    expect(e?.azione).toEqual({ tipo: "install_token", token: "carico.firma" });
  });

  it("pagato ma SENZA gettone non inventa niente", () => {
    const e = interpretaEvento(evento("checkout.session.completed", { client_reference_id: "iid-1" }));
    expect(e?.azione).toEqual({ tipo: "ignore", perche: "no_token_in_event" });
  });

  it("l'id dell'installazione si legge anche dai metadati dell'abbonamento", () => {
    // È la strada che conta davvero: gli eventi di rinnovo arrivano mesi dopo
    // e portano l'abbonamento, non la sessione di checkout.
    const e = interpretaEvento(evento("customer.subscription.updated", {
      status: "active",
      metadata: { installation_id: "iid-2", license_token: "t.f" },
    }));
    expect(e?.installationId).toBe("iid-2");
    expect(e?.azione).toEqual({ tipo: "install_token", token: "t.f" });
  });

  it("l'abbonamento cancellato toglie la licenza", () => {
    const e = interpretaEvento(evento("customer.subscription.deleted", {
      metadata: { installation_id: "iid-1" },
    }));
    expect(e?.azione).toEqual({ tipo: "remove_license" });
  });

  it("uno stato FINITO toglie la licenza anche su `updated`", () => {
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
      const e = interpretaEvento(evento("customer.subscription.updated", {
        status, metadata: { installation_id: "iid-1", license_token: "t.f" },
      }));
      expect(e?.azione).toEqual({ tipo: "remove_license" });
    }
  });

  it("`past_due` NON toglie niente: il rinnovo sta ancora ritentando", () => {
    const e = interpretaEvento(evento("customer.subscription.updated", {
      status: "past_due", metadata: { installation_id: "iid-1", license_token: "t.f" },
    }));
    expect(e?.azione).toEqual({ tipo: "install_token", token: "t.f" });
  });

  it("un tipo che non conosciamo si IGNORA, e non è un errore", () => {
    const e = interpretaEvento(evento("invoice.created", {}));
    expect(e?.azione).toEqual({ tipo: "ignore", perche: "unhandled_type" });
  });
});

describe("stripe · aprire un checkout", () => {
  const base = {
    installationId: "iid-1", posti: 3,
    successUrl: "https://app.example/ok", cancelUrl: "https://app.example/no",
  };
  const fullCfg = leggiConfigStripe({
    STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_x",
    STRIPE_API_BASE: "https://finto.example",
  });

  it("senza configurazione non chiama NESSUNO", async () => {
    let chiamate = 0;
    const e = await creaCheckout({
      ...base, config: leggiConfigStripe({}),
      fetchImpl: (async () => { chiamate++; return new Response("{}"); }) as unknown as typeof fetch,
    });
    expect(e).toEqual({ ok: false, codice: "not_configured" });
    expect(chiamate).toBe(0);
  });

  it("manda a Stripe l'id dell'installazione in tutti e tre i posti", async () => {
    let corpo = "";
    // Un oggetto e non una `let`: TypeScript restringe una variabile assegnata
    // solo dentro una callback al suo valore iniziale, e il confronto dopo non
    // compilerebbe più.
    const visto: { auth: string | null } = { auth: null };
    const e = await creaCheckout({
      ...base, config: fullCfg,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        corpo = String(init.body);
        visto.auth = new Headers(init.headers).get("authorization");
        return new Response(JSON.stringify({ id: "cs_1", url: "https://checkout.example/c" }));
      }) as unknown as typeof fetch,
    });
    expect(e).toEqual({ ok: true, id: "cs_1", url: "https://checkout.example/c" });
    const p = new URLSearchParams(corpo);
    expect(p.get("client_reference_id")).toBe("iid-1");
    expect(p.get("metadata[installation_id]")).toBe("iid-1");
    // Il terzo è quello che fa funzionare gli eventi di rinnovo.
    expect(p.get("subscription_data[metadata][installation_id]")).toBe("iid-1");
    expect(p.get("line_items[0][quantity]")).toBe("3");
    expect(p.get("mode")).toBe("subscription");
    expect(visto.auth).toBe("Bearer sk_test_x");
  });

  it("posti fuori scala si fermano PRIMA di diventare un addebito", async () => {
    let chiamate = 0;
    const f = (async () => { chiamate++; return new Response("{}"); }) as unknown as typeof fetch;
    for (const posti of [0, -1, POSTI_MAX_CHECKOUT + 1]) {
      expect(await creaCheckout({ ...base, posti, config: fullCfg, fetchImpl: f }))
        .toEqual({ ok: false, codice: "bad_seats" });
    }
    expect(chiamate).toBe(0);
    // Il canale funziona: al limite esatto passa.
    expect((await creaCheckout({
      ...base, posti: POSTI_MAX_CHECKOUT, config: fullCfg,
      fetchImpl: (async () => new Response(JSON.stringify({ id: "cs_1", url: "https://u" }))) as unknown as typeof fetch,
    })).ok).toBe(true);
  });

  it("una rete che non risponde torna `unreachable`, non un'eccezione", async () => {
    const e = await creaCheckout({
      ...base, config: fullCfg,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    expect(e).toEqual({ ok: false, codice: "unreachable" });
  });

  it("una risposta di Stripe non-ok, o senza url, è `upstream_error`", async () => {
    const err = async (r: Response) => creaCheckout({
      ...base, config: fullCfg, fetchImpl: (async () => r) as unknown as typeof fetch,
    });
    expect(await err(new Response("no", { status: 402 }))).toEqual({ ok: false, codice: "upstream_error" });
    expect(await err(new Response("non-json"))).toEqual({ ok: false, codice: "upstream_error" });
    expect(await err(new Response(JSON.stringify({ id: "cs_1" })))).toEqual({ ok: false, codice: "upstream_error" });
  });

  it("senza installazione non si compra per nessuno", async () => {
    const e = await creaCheckout({
      ...base, installationId: "  ", config: fullCfg,
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    expect(e).toEqual({ ok: false, codice: "no_installation" });
  });
});
