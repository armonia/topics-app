/**
 * `/api/billing` — la porta del pagamento. Non è la porta di ciò che è concesso.
 *
 * Le due domande sono diverse e devono restare separate:
 *   «questa installazione ha pagato?»  → Stripe, e si chiede QUI
 *   «questa installazione può fare X?» → `/api/license`, e SOLO lì
 *
 * Questa rotta non risponde mai alla seconda. Il webhook, nel caso migliore,
 * PASSA un gettone a `ServizioLicenza.installa`, che lo riverifica da capo con
 * la chiave pubblica: un evento contraffatto con dentro un gettone inventato
 * non concede niente, perché la chiave privata non sta qui. Se questa rotta
 * potesse alzare un `remoteAccess` da sé, esisterebbero due autorità sulla
 * stessa domanda — e quella che sbaglia è sempre quella che nessuno guarda.
 *
 * ── NON È UN CANCELLO, E LA `GET` NON TOCCA LA RETE ─────────────────────────
 * `GET` risponde `200` sempre e legge solo variabili d'ambiente: nessuna
 * chiamata, nessun timeout, nessun momento in cui Stripe giù cambia ciò che
 * questa macchina ti lascia fare (ORG-08). Senza configurazione — il caso di
 * ogni installazione che non paga, cioè quasi tutte — risponde
 * `configured: false` e i gesti che richiedono Stripe tornano un codice che
 * dice perché. Nessun `5xx`, che per chi guarda è indistinguibile da una
 * macchina rotta.
 *
 * ── GLI OSPITI NON ARRIVANO QUI ─────────────────────────────────────────────
 * `isGuestAllowedPath` (server/lib/grants.ts) è un'ALLOWLIST e `/api/billing`
 * non ci compare. Chi entra da un link condiviso non ha niente da sapere su chi
 * paga, e non deve poter aprire un checkout a nome di qualcun altro.
 */
import type { AppContext, RouteHandler } from "../types";
import {
  leggiConfigStripe, statoPubblico, verificaFirmaWebhook, interpretaEvento, creaCheckout,
} from "../lib/stripe";

/** Posti chiesti quando il client non lo dice. Due e non uno: uno è già il
 *  piano gratuito, e un checkout che vende ciò che è gratis è una schermata di
 *  pagamento che non ha senso aprire. */
const SLOTS_DEFAULT = 2;

export interface DepsBilling {
  /** Iniettabile per i test; in produzione è `process.env`. Si legge a OGNI
   *  richiesta e non al boot: una variabile cambiata a caldo che non ha effetto
   *  è la trappola che `resolveAllowedOrigins` ha già pagato una volta. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Il webhook è raggiungibile SENZA identità di dispositivo, e si autentica da
 * sé con la firma di Stripe.
 *
 * Sta qui e non in `isIdentityExemptPath` (device-auth.ts) apposta: quella
 * elenca i percorsi che SERVONO a ottenere un'identità — il pairing — e
 * infilarci dentro un webhook ne cambierebbe il significato, rendendo più
 * difficile accorgersi della prossima esenzione di troppo. Questa è un'altra
 * cosa: non «esente da autenticazione», ma autenticato in un modo diverso e
 * più forte di un cookie, cioè un HMAC sul corpo esatto.
 */
export const PERCORSO_WEBHOOK = "/api/billing/webhook";

export function isBillingWebhookPath(pathname: string): boolean {
  return pathname === PERCORSO_WEBHOOK;
}

export function createBillingRouter(ctx: AppContext, deps: DepsBilling = {}): RouteHandler {
  const { json, readJSON } = ctx;
  const adesso = deps.now ?? (() => Date.now());
  const config = () => leggiConfigStripe(deps.env ?? process.env);
  const iid = () => ctx.relayConfig?.().installationId ?? "";

  const rifiuto = (codice: string, status = 409) => json({ ok: false, code: codice }, status);

  return async function billingRouter(req, url, pathname, method) {
    if (pathname !== "/api/billing"
      && pathname !== "/api/billing/checkout"
      && pathname !== PERCORSO_WEBHOOK) return null;

    // ── Lo stato. Locale, sempre `200`, mai una richiesta in uscita.
    //    Due booleani e l'identificativo dell'installazione: della chiave non
    //    esce niente, nemmeno la coda.
    if (method === "GET" && pathname === "/api/billing") {
      return json({ ...statoPubblico(config()), installationId: iid() });
    }

    // ── Aprire un checkout.
    if (method === "POST" && pathname === "/api/billing/checkout") {
      const body = await readJSON(req) as { seats?: unknown } | null;
      const posti = typeof body?.seats === "number" ? body.seats : SLOTS_DEFAULT;

      // Gli indirizzi di ritorno si ricavano dall'ORIGINE di questa richiesta e
      // non si prendono dal corpo. Un `success_url` scelto da chi chiama è un
      // reindirizzamento aperto con la faccia di Stripe davanti: la persona
      // paga sul dominio giusto e atterra dove ha deciso qualcun altro.
      const origine = url.origin;
      const e = await creaCheckout({
        config: config(),
        installationId: iid(),
        posti,
        successUrl: `${origine}/?billing=ok`,
        cancelUrl: `${origine}/?billing=cancelled`,
        fetchImpl: deps.fetchImpl,
      });
      if (!e.ok) return rifiuto(e.codice);
      return json({ ok: true, url: e.url, id: e.id });
    }

    // ── Il webhook.
    if (method === "POST" && pathname === PERCORSO_WEBHOOK) {
      // Il corpo GREZZO, e non `readJSON`: la firma copre i byte esatti che
      // sono arrivati. Ri-serializzare un oggetto darebbe un altro testo — e
      // allora o non si verifica più niente, o si verifica qualcosa che nessuno
      // ha firmato.
      let grezzo: string;
      try {
        grezzo = await req.text();
      } catch {
        return json({ ok: false, code: "unreadable_body" }, 400);
      }

      const c = config();
      const firma = verificaFirmaWebhook(
        grezzo, req.headers.get("stripe-signature"), c.webhookSecret, adesso(),
      );
      if (!firma.ok) {
        // `503` per la SOLA configurazione mancante: è transitoria — qualcuno
        // metterà la variabile — e a Stripe conviene riprovare. Tutto il resto è
        // `400`, cioè «non riprovare»: una firma che non torna non tornerà
        // nemmeno al decimo tentativo, e insistere riempirebbe la coda delle
        // consegne fallite nascondendo quelle vere.
        const status = firma.motivo === "no_secret" ? 503 : 400;
        return json({ ok: false, code: firma.motivo }, status);
      }

      let corpo: unknown;
      try {
        corpo = JSON.parse(grezzo) as unknown;
      } catch {
        return json({ ok: false, code: "malformed_json" }, 400);
      }
      const evento = interpretaEvento(corpo);
      if (!evento) return json({ ok: false, code: "not_an_event" }, 400);

      // Da qui in poi si risponde SEMPRE `200`: l'evento è autentico e lo
      // abbiamo capito. Quel che resta sono decisioni nostre, e nessuna di esse
      // è una ragione per far riprovare Stripe.
      const ack = (action: string, applied: boolean, extra: Record<string, unknown> = {}) =>
        json({ received: true, id: evento.id, action, applied, ...extra });

      // Un evento che parla di un'ALTRA installazione non ci riguarda. Senza
      // questo controllo un webhook legittimo indirizzato a un'altra macchina
      // — o rigiocato verso questa — cambierebbe la licenza di chi non
      // c'entra.
      const mio = iid();
      if (evento.installationId && mio && evento.installationId !== mio) {
        return ack("ignore", false, { reason: "other_installation" });
      }

      const servizio = ctx.licenza?.();
      if (!servizio) return ack("ignore", false, { reason: "no_license_service" });

      switch (evento.azione.tipo) {
        case "install_token": {
          // LA PORTA UNICA. Il gettone viene riverificato qui dentro (firma
          // Ed25519, installazione, scadenza): se non regge, `motivo` lo dice e
          // non si è concesso niente.
          const esito = servizio.installa(evento.azione.token, adesso());
          const ok = esito.motivo === "valid";
          if (!ok) {
            console.warn(`[billing] gettone rifiutato su ${evento.id}: ${esito.motivo}`);
          }
          return ack("install_token", ok, { reason: esito.motivo });
        }
        case "remove_license":
          servizio.rimuovi();
          return ack("remove_license", true);
        case "ignore":
          return ack("ignore", false, { reason: evento.azione.perche });
      }
    }

    return null;
  };
}
