/**
 * Il relay di Topics: instrada, e non capisce.
 *
 * Due porte sole:
 *   `GET /agent/:installationId`  ← la MACCHINA, che chiama FUORI
 *   `GET /s/:installationId`      ← l'OSPITE, che apre un link
 *
 * Entrambe finiscono nello stesso Durable Object, uno per installazione, che è
 * il punto d'incontro. La macchina non ascolta su nessuna porta: apre lei la
 * connessione. È il motivo per cui in questo prodotto la parola «tunnel» non
 * compare — non c'è niente da esporre.
 *
 * Quello che il Worker NON fa, ed è deliberato (RELAY-04): non decide chi sei.
 * Stabilisce un canale. Chi sei e cosa puoi vedere lo decide l'installazione,
 * con le stesse regole della rete locale. Due autorità sull'identità vanno
 * tenute d'accordo per sempre, e quella che sbaglia è sempre quella che nessuno
 * guarda.
 */
export { SessioneRelay } from "./relay-do";
import { PAGINA_OSPITE } from "./pagina-ospite";

interface Env {
  SESSIONE: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // ── La PAGINA che un ospite apre cliccando il link.
    //
    // Statica e identica per tutti: non sa niente di nessuno. La chiave sta nel
    // frammento dell'URL, che il browser non manda al server — quindi mentre
    // serviamo il visore non vediamo cosa aprirà. Il relay resta cieco anche
    // qui.
    if (/^\/g\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
      return new Response(PAGINA_OSPITE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Un link condiviso non si mette in cache lungo la strada e non
          // finisce in un motore di ricerca.
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          "referrer-policy": "no-referrer",
        },
      });
    }

    const m = url.pathname.match(/^\/(agent|s)\/([A-Za-z0-9_-]{1,128})$/);

    if (!m) {
      // Nessuna pagina, nessun indice: un relay che risponde qualcosa a una
      // richiesta qualunque è un relay che invita a frugare.
      return new Response("not found", { status: 404 });
    }

    const [, ruolo, installationId] = m;
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("serve un upgrade websocket", { status: 426 });
    }

    // `idFromName` dà lo STESSO oggetto per lo stesso nome, sempre: è ciò che
    // fa incontrare una macchina e i suoi ospiti senza tenere un registro da
    // qualche parte.
    const id = env.SESSIONE.idFromName(installationId);
    const stub = env.SESSIONE.get(id);
    const dentro = new URL(req.url);
    dentro.searchParams.set("ruolo", ruolo === "agent" ? "host" : "guest");
    return stub.fetch(new Request(dentro.toString(), req));
  },
};
