/**
 * `/api/auth/account` — l'unica porta dell'account remoto.
 *
 * Quattro gesti e nient'altro: LEGGERE lo stato, chiedere un codice, verificarlo,
 * staccarsi. Le decisioni non si prendono qui — stanno in `server/lib/account.ts`
 * — e questa rotta le mostra. È la differenza fra una porta e una seconda copia
 * delle regole: due copie rispondono diversamente il giorno in cui una viene
 * aggiornata e l'altra no.
 *
 * ── NON È UN CANCELLO, E LA GET NON TOCCA LA RETE ───────────────────────────
 * `GET` risponde `200` sempre, e legge solo il database: nessuna chiamata,
 * nessun timeout, nessun momento in cui un servizio giù cambia ciò che questa
 * macchina ti lascia fare (ORG-08). Perdere il contatto col servizio non
 * scollega nessuno e non fa comparire un errore: fa fallire il gesto di
 * collegare un account NUOVO, con un codice che dice perché.
 *
 * Per la stessa ragione nessun ramo qui dentro risponde `5xx`. Un `5xx` è
 * indistinguibile, per chi guarda, da una macchina rotta — e questa macchina
 * funziona: semplicemente non può, adesso, parlare con un servizio esterno.
 * `409` per «lo stato non lo permette», `400` solo per una richiesta malformata.
 *
 * ── STA SOTTO `/api/auth/` E QUESTO BASTA A TENERE FUORI GLI OSPITI ─────────
 * `isGuestAllowedPath` (server/lib/grants.ts) è un'ALLOWLIST: elenca ciò che un
 * ospite può toccare, e `/api/auth/account` non ci compare. Chi arriva da un
 * link condiviso non ha niente da sapere su chi ha un account su questa
 * macchina, e non deve poterne collegare uno.
 */
import type { AppContext, RouteHandler } from "../types";
import { actingPersonId } from "../lib/orgs";
import {
  leggiAccountUrl, normalizzaEmail, statoAccount, collegaAccount, scollegaAccount,
  chiediCodice, verificaCodice, type CodiceAccount, type OpzioniServizio,
} from "../lib/account";

export interface DepsAccount {
  /** Iniettabile per i test; in produzione è `process.env`. Si legge a OGNI
   *  richiesta e non al boot: una variabile cambiata a caldo che non ha effetto
   *  è la trappola che `resolveAllowedOrigins` ha già pagato una volta. */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createAccountRouter(ctx: AppContext, deps: DepsAccount = {}): RouteHandler {
  const { json, readJSON, db } = ctx as AppContext & {
    db: { query: (sql: string) => { get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } };
  };
  const adesso = deps.now ?? (() => Date.now());

  const servizio = (): OpzioniServizio => ({
    baseUrl: leggiAccountUrl(deps.env ?? process.env),
    fetchImpl: deps.fetchImpl ?? fetch,
    installationId: ctx.relayConfig?.().installationId ?? "",
  });

  /** Chi sta agendo, con la STESSA funzione che usano le rotte dei gruppi: una
   *  seconda definizione di «chi sono» è il modo in cui due rotte cominciano a
   *  rispondere diversamente alla stessa domanda. */
  const persona = (req: Request): string | null =>
    actingPersonId(db as never, ctx.requestIdentity?.(req)?.deviceId ?? null);

  const stato = (req: Request) =>
    statoAccount(db as never, persona(req), !!leggiAccountUrl(deps.env ?? process.env));

  /** Un rifiuto ha SEMPRE un codice, e il codice è il protocollo: l'interfaccia
   *  ci scrive sopra la propria frase, nella propria lingua. */
  const rifiuto = (codice: CodiceAccount, status = 409) =>
    json({ ok: false, code: codice }, status);

  return async function accountRouter(req, _url, pathname, method) {
    if (pathname !== "/api/auth/account"
      && pathname !== "/api/auth/account/code"
      && pathname !== "/api/auth/account/verify") return null;

    // ── Lo stato. Locale, sempre `200`, mai una richiesta in uscita.
    if (method === "GET" && pathname === "/api/auth/account") {
      return json(stato(req));
    }

    // ── «Mandami un codice». L'unica chiamata in uscita del primo passo.
    if (method === "POST" && pathname === "/api/auth/account/code") {
      const body = await readJSON(req) as { email?: unknown } | null;
      const email = normalizzaEmail(body?.email);
      // `400` perché è la RICHIESTA a essere storta, non lo stato: è l'unico
      // caso in cui il chiamante ha sbagliato a comporre la domanda.
      if (!email) return rifiuto("invalid_email", 400);

      const e = await chiediCodice(servizio(), email);
      if (!e.ok) return rifiuto(e.codice);
      return json({ ok: true, expiresAt: e.dato.expiresAt });
    }

    // ── «Ecco il codice»: in cambio, l'identità remota, che viene AGGANCIATA a
    //    una persona già esistente. Mai creata: `collegaAccount` non ha una sola
    //    INSERT su `people`.
    if (method === "POST" && pathname === "/api/auth/account/verify") {
      const body = await readJSON(req) as { email?: unknown; code?: unknown } | null;
      const email = normalizzaEmail(body?.email);
      if (!email) return rifiuto("invalid_email", 400);
      const codice = typeof body?.code === "string" ? body.code.trim() : "";
      if (!codice) return rifiuto("bad_code", 400);

      const e = await verificaCodice(servizio(), email, codice);
      if (!e.ok) return rifiuto(e.codice);

      const agganciato = collegaAccount(db as never, {
        identita: e.dato,
        actingPersonId: persona(req),
        now: adesso(),
      });
      if (!agganciato.ok) return rifiuto(agganciato.codice);

      // Lo stato esce dalla STESSA funzione della `GET`, e non ricomposto a
      // mano: due forme della stessa risposta sono due risposte che col tempo
      // si allontanano, e la seconda nessuno la rilegge. E parla della stessa
      // persona: `collegaAccount` aggancia l'identità a chi agisce o a nessuno,
      // quindi `agganciato.personId` è la persona di cui rispondono anche la
      // `GET` e la `DELETE` qui sotto.
      return json({ ok: true, ...statoAccount(db as never, agganciato.personId, true) });
    }

    // ── Staccarsi. Gesto LOCALE: funziona senza rete, e deve — altrimenti un
    //    servizio giù ti lascerebbe legato a un'identità che non puoi togliere.
    if (method === "DELETE" && pathname === "/api/auth/account") {
      const chi = persona(req);
      const e = scollegaAccount(db as never, chi, adesso());
      if (!e.ok) return rifiuto(e.codice);
      return json({ ok: true, ...stato(req) });
    }

    return null;
  };
}
