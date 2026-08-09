/**
 * Il relay di Topics: instrada, e non capisce.
 *
 * Tre porte per chi parla già il protocollo:
 *   `GET /agent/:installationId`  ← la MACCHINA, che chiama FUORI
 *   `GET /s/:installationId`      ← l'OSPITE, che apre un link
 *   `GET /d/:installationId`      ← il DISPOSITIVO appaiato, da un'altra rete
 *
 * …e una per chi non parla niente:
 *   `*   /i/:installationId/…`    ← il BROWSER, che ha solo aperto un indirizzo
 *
 * Le prime tre sono agganci: chiedono un upgrade WebSocket e da lì in poi il
 * tubo. La quarta è una traduzione — una richiesta HTTPS qualunque entra, esce
 * come frame verso la macchina, e la sua risposta torna indietro come
 * `Response`. Senza di lei il tubo esisteva ma non aveva nessuna porta da cui
 * un telefono potesse entrare, perché un telefono non ha modo di diventare un
 * client del protocollo prima di bussare.
 *
 * Tutte finiscono nello stesso Durable Object, uno per installazione, che è il
 * punto d'incontro. La macchina non ascolta su nessuna porta: apre lei la
 * connessione. È il motivo per cui in questo prodotto la parola «tunnel» non
 * compare — non c'è niente da esporre.
 *
 * ── PERCHÉ IL DISPOSITIVO HA UNA PORTA SUA ──────────────────────────────────
 * Un ospite di link è una CAPACITÀ su una risorsa: una domanda, una risposta.
 * Un dispositivo appaiato ha davanti l'installazione intera e ci resta per ore,
 * con decine di richieste in volo insieme. Sono due posture diverse dal lato
 * della macchina, e la macchina deve poterle distinguere PRIMA di aprire la
 * busta. Il percorso è la sola cosa che il relay sa di suo, quindi il ruolo
 * nasce lì e viaggia nell'involucro — e non si ricava mai dal contenuto, che
 * resta roba di nessuno tranne i due capi.
 *
 * Quello che il Worker NON fa, ed è deliberato (RELAY-04): non decide chi sei.
 * Stabilisce un canale. Chi sei e cosa puoi vedere lo decide l'installazione,
 * con le stesse regole della rete locale. Due autorità sull'identità vanno
 * tenute d'accordo per sempre, e quella che sbaglia è sempre quella che nessuno
 * guarda.
 */
export { SessioneRelay } from "./relay-do";
import { PAGINA_OSPITE } from "./pagina-ospite";
import { PERCORSO_PONTE } from "./ponte";

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

    // ── LA PORTA DEL BROWSER: `/i/:installationId/<qualsiasi cosa>`
    //
    // Le altre tre chiedono tutte un upgrade WebSocket, ed è giusto: chi le usa
    // parla già il protocollo. Questa no — chi arriva qui è un browser
    // qualunque che ha aperto un indirizzo, e non ha modo di diventare
    // qualcos'altro prima di bussare. Il Durable Object traduce la richiesta in
    // frame del tubo e la risposta in una `Response`: da lì in poi è un sito
    // web, e sul telefono non serve installare niente.
    //
    // La richiesta si gira INTERA e senza toccarla — è anche l'unico modo di
    // portarsi dietro un corpo che arriva a pezzi — e il ruolo resta scritto
    // nel PERCORSO, dove lo ha messo chi ha aperto il link. Non in un
    // parametro, che finirebbe in ciò che la macchina rigioca, e non in
    // un'intestazione, che chi bussa può scrivere da sé: `/d/:id` non deve
    // poter essere letta come una traduzione perché qualcuno l'ha dichiarata.
    // Il modello è UNO e sta accanto al ponte: due copie della stessa forma
    // sono due cose che un giorno dicono percorsi diversi, e quel giorno chi
    // instrada e chi traduce non parlano più dello stesso indirizzo.
    const ponte = url.pathname.match(PERCORSO_PONTE);
    if (ponte) {
      const id = env.SESSIONE.idFromName(ponte[1] ?? "");
      return env.SESSIONE.get(id).fetch(req);
    }

    const m = url.pathname.match(/^\/(agent|s|d)\/([A-Za-z0-9_-]{1,128})$/);

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
    // Una tabella e non una catena di ternari: aggiungere una porta domani deve
    // essere una riga, e una porta che non c'è deve cadere sul valore meno
    // potente invece che su quello più comodo.
    const RUOLI: Record<string, string> = { agent: "host", s: "guest", d: "device" };
    dentro.searchParams.set("ruolo", RUOLI[ruolo ?? ""] ?? "guest");
    return stub.fetch(new Request(dentro.toString(), req));
  },
};
