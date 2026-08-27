/**
 * Il giro intero: uno paga, e la sua macchina passa al piano che ha pagato.
 *
 * ── PERCHÉ SERVE UN TEST CHE LI METTA INSIEME ───────────────────────────────
 * I tre pezzi sono verdi ognuno per conto suo e non si importano a vicenda:
 *
 *   `scripts/conio-licenze.ts`   ascolta Stripe, conia, SCRIVE nei metadati
 *   Stripe                        rimette in giro l'abbonamento modificato
 *   `server/routes/billing.ts`    riceve, e passa il gettone alla porta unica
 *
 * Fra loro c'è un accordo tacito su UN nome — `metadata.license_token` — e su
 * dove sta l'identificativo dell'installazione. Sbagliare quel nome da un lato
 * non rompe nessun test dei tre: il conio scrive felice in un campo che nessuno
 * legge, il webhook risponde `no_token_in_event`, e il cliente che ha pagato
 * resta sul piano gratuito senza che niente diventi rosso. Questo file è la
 * catena montata: se un anello cambia nome, qui si vede.
 *
 * ── E LA RIGA CHE NON SI ATTRAVERSA ─────────────────────────────────────────
 * L'ultimo caso è il contrario: Stripe che dice «pagato» con dentro un gettone
 * INVENTATO non concede niente. Il conio automatico non ha spostato l'autorità
 * — la porta resta la firma Ed25519.
  * @covers LICENSE-07
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creaGestoreConio, leggiConfigConio } from "../../scripts/conio-licenze";
import { createBillingRouter } from "../../server/routes/billing";
import { creaServizioLicenza } from "../../server/lib/licenza";
import type { AppContext } from "../../server/types";

const IID = "0123456789abcdef01234567";
const ORA = 1_760_000_000_000;
const FINE_PERIODO_S = Math.floor(ORA / 1000) + 30 * 86_400;

/** Due segreti diversi apposta: l'endpoint del venditore e quello
 *  dell'installazione sono due endpoint distinti dello stesso account Stripe, e
 *  confonderli è il modo realistico di rompere questo giro. */
const SEGRETO_CONIO = "whsec_venditore";
const SECRET_INSTALL = "whsec_cliente";

const coppia = generateKeyPairSync("ed25519");
const PRIV = coppia.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64url");
const PUB = coppia.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");

function firma(corpo: string, segreto: string, tsMs = ORA): string {
  const t = Math.floor(tsMs / 1000);
  return `t=${t},v1=${createHmac("sha256", segreto).update(`${t}.${corpo}`, "utf8").digest("hex")}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Uno Stripe finto che si comporta come quello vero nell'unico modo che conta:
// una scrittura sui metadati FONDE le chiavi e rimette in giro l'abbonamento
// come `customer.subscription.updated`.
// ─────────────────────────────────────────────────────────────────────────────

function finziStripe() {
  const abbonamento: Record<string, unknown> = {
    id: "sub_e2e",
    status: "active",
    current_period_end: FINE_PERIODO_S,
    items: { data: [{ quantity: 5 }] },
    metadata: { installation_id: IID } as Record<string, string>,
  };
  const emessi: Array<Record<string, unknown>> = [];
  let n = 0;

  // `as unknown as typeof fetch` come in stripe.test.ts e approval-prompt.test.ts:
  // il tipo di `fetch` porta anche `preconnect`, che un finto non ha e non serve.
  const fetchImpl = (async (u: unknown, init?: { body?: unknown }) => {
    const url = String(u);
    if (!url.endsWith("/v1/subscriptions/sub_e2e")) return new Response("no", { status: 404 });
    const corpo = new URLSearchParams(String(init?.body ?? ""));
    const meta = abbonamento.metadata as Record<string, string>;
    for (const [k, v] of corpo) {
      const m = /^metadata\[(.+)\]$/.exec(k);
      if (m) meta[m[1]!] = v;
    }
    emessi.push({
      id: `evt_upd_${++n}`,
      type: "customer.subscription.updated",
      data: { object: structuredClone(abbonamento) },
    });
    return new Response(JSON.stringify(abbonamento), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    emessi,
    abbonamento,
    creato: () => ({
      id: "evt_created",
      type: "customer.subscription.created",
      data: { object: structuredClone(abbonamento) },
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// I due lati
// ─────────────────────────────────────────────────────────────────────────────

let stateDir = "";
let servizio: ReturnType<typeof creaServizioLicenza>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "conio-e2e-"));
  servizio = creaServizioLicenza({
    stateDir,
    // La pubblica di PROVA, non `CHIAVI_INTEGRATE`: questo file prova l'accordo
    // fra i pezzi, non la chiave con cui firmiamo davvero.
    env: { TOPICS_LICENSE_PUBKEYS: `prova-1:${PUB}` },
    installationId: IID,
    ora: () => ORA,
  });
});

afterEach(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true });
});

function latoInstallazione() {
  const ctx = {
    json: (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }),
    readJSON: async (req: Request) => { try { return await req.json() as unknown; } catch { return null; } },
    relayConfig: () => ({ baseUrl: null, installationId: IID }),
    licenza: () => servizio,
  } as unknown as AppContext;
  const router = createBillingRouter(ctx, {
    env: { STRIPE_WEBHOOK_SECRET: SECRET_INSTALL },
    now: () => ORA,
  });
  return async (evento: unknown) => {
    const corpo = JSON.stringify(evento);
    const req = new Request("https://cliente.local/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": firma(corpo, SECRET_INSTALL), "content-type": "application/json" },
      body: corpo,
    });
    const r = await router(req, new URL(req.url), "/api/billing/webhook", "POST");
    if (!r) throw new Error("la rotta non ha risposto");
    return { status: r.status, corpo: await r.json() as Record<string, unknown> };
  };
}

function latoVenditore(fetchImpl: typeof fetch, log: string[] = []) {
  const gestore = creaGestoreConio({
    config: () => leggiConfigConio({
      TOPICS_LICENSE_PRIVKEY: PRIV,
      CONIO_WEBHOOK_SECRET: SEGRETO_CONIO,
      STRIPE_SECRET_KEY: "sk_prova",
      STRIPE_API_BASE: "https://finto.stripe",
      TOPICS_LICENSE_KID: "prova-1",
    }),
    now: () => ORA,
    fetchImpl,
    log: (r) => log.push(r),
  });
  return async (evento: unknown) => {
    const corpo = JSON.stringify(evento);
    const r = await gestore(new Request("http://127.0.0.1/webhook", {
      method: "POST",
      headers: { "stripe-signature": firma(corpo, SEGRETO_CONIO), "content-type": "application/json" },
      body: corpo,
    }));
    return { status: r.status, corpo: await r.json() as Record<string, unknown> };
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("conio ↔ webhook · il giro intero", () => {
  it("uno paga e la sua macchina passa a team, senza che nessuno apra un terminale", async () => {
    const stripe = finziStripe();
    const venditore = latoVenditore(stripe.fetchImpl);
    const cliente = latoInstallazione();

    // Prima: piano gratuito, un posto. È lo stato di ogni installazione.
    expect(servizio.stato(ORA).piano).toBe("free");
    expect(servizio.stato(ORA).posti).toBe(1);

    // 1. il pagamento arriva al VENDITORE, che conia e scrive su Stripe
    const c = await venditore(stripe.creato());
    expect(c.status).toBe(200);
    expect(c.corpo).toMatchObject({ minted: true, seats: 5 });
    expect(stripe.emessi).toHaveLength(1);

    // 2. la scrittura ha generato l'evento che porta il gettone al CLIENTE
    const i = await cliente(stripe.emessi[0]!);
    expect(i.status).toBe(200);
    expect(i.corpo).toMatchObject({ action: "install_token", applied: true, reason: "valid" });

    // 3. e la macchina adesso ha ciò che ha pagato
    const stato = servizio.stato(ORA);
    expect(stato.piano).toBe("team");
    expect(stato.posti).toBe(5);
  });

  it("il ciclo si ferma al primo giro: l'evento della nostra scrittura non ne genera un altro", async () => {
    const stripe = finziStripe();
    const venditore = latoVenditore(stripe.fetchImpl);

    await venditore(stripe.creato());
    expect(stripe.emessi).toHaveLength(1);

    // Lo stesso evento che il cliente riceve torna anche al venditore: è lo
    // stesso account Stripe. Se questo secondo giro coniasse, il servizio
    // scriverebbe per sempre.
    const secondo = await venditore(stripe.emessi[0]!);
    expect(secondo.corpo).toMatchObject({ minted: false, reason: "already_minted" });
    expect(stripe.emessi).toHaveLength(1);
  });

  it("al rinnovo si riconia una volta sola, e il cliente resta team", async () => {
    const stripe = finziStripe();
    const venditore = latoVenditore(stripe.fetchImpl);
    const cliente = latoInstallazione();

    await venditore(stripe.creato());
    await cliente(stripe.emessi[0]!);
    expect(servizio.stato(ORA).piano).toBe("team");

    // Il periodo si sposta di un mese: il gettone in circolazione scadrebbe
    // prima della fine del nuovo periodo.
    stripe.abbonamento.current_period_end = FINE_PERIODO_S + 30 * 86_400;
    const r = await venditore({
      id: "evt_rinnovo",
      type: "customer.subscription.updated",
      data: { object: structuredClone(stripe.abbonamento) },
    });
    expect(r.corpo).toMatchObject({ minted: true });
    expect(stripe.emessi).toHaveLength(2);

    // …e il secondo giro si ferma di nuovo.
    expect((await venditore(stripe.emessi[1]!)).corpo).toMatchObject({ reason: "already_minted" });

    await cliente(stripe.emessi[1]!);
    expect(servizio.stato(ORA).piano).toBe("team");
  });

  it("chi compra tre posti in più li ha alla prima riscrittura", async () => {
    const stripe = finziStripe();
    const venditore = latoVenditore(stripe.fetchImpl);
    const cliente = latoInstallazione();

    await venditore(stripe.creato());
    await cliente(stripe.emessi[0]!);
    expect(servizio.stato(ORA).posti).toBe(5);

    stripe.abbonamento.items = { data: [{ quantity: 8 }] };
    await venditore({
      id: "evt_upgrade",
      type: "customer.subscription.updated",
      data: { object: structuredClone(stripe.abbonamento) },
    });
    await cliente(stripe.emessi[1]!);
    expect(servizio.stato(ORA).posti).toBe(8);
  });

  it("il conio automatico NON ha spostato l'autorità: un gettone inventato resta free", async () => {
    const cliente = latoInstallazione();
    const r = await cliente({
      id: "evt_falso",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_e2e",
          status: "active",
          metadata: { installation_id: IID, license_token: "eyJmYWtlIjoxfQ.ZmlybWE" },
        },
      },
    });
    // L'evento è AUTENTICO — firmato col segreto giusto — e la rotta risponde
    // `200` perché l'ha capito. Ma la porta unica non si apre.
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ action: "install_token", applied: false });
    expect(servizio.stato(ORA).piano).toBe("free");
  });

  it("un abbonamento disdetto non fa coniare, e la disdetta arriva al cliente per la sua strada", async () => {
    const stripe = finziStripe();
    const venditore = latoVenditore(stripe.fetchImpl);
    const cliente = latoInstallazione();

    await venditore(stripe.creato());
    await cliente(stripe.emessi[0]!);
    expect(servizio.stato(ORA).piano).toBe("team");

    stripe.abbonamento.status = "canceled";
    const r = await venditore({
      id: "evt_stop",
      type: "customer.subscription.updated",
      data: { object: structuredClone(stripe.abbonamento) },
    });
    expect(r.corpo).toMatchObject({ minted: false, reason: "subscription_over" });
    expect(stripe.emessi).toHaveLength(1);

    // Lo spegnimento non passa dal conio: è il webhook dell'installazione che
    // legge lo stato e torna al piano gratuito.
    await cliente({
      id: "evt_stop", type: "customer.subscription.updated",
      data: { object: structuredClone(stripe.abbonamento) },
    });
    expect(servizio.stato(ORA).piano).toBe("free");
  });
});
