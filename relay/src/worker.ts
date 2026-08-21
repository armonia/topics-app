/**
 * Il relay di Topics: instrada, e non capisce.
 *
 * Tre porte per chi parla già il protocollo:
 *   `GET /agent/:relayId`  ← la MACCHINA, che chiama FUORI
 *   `GET /s/:relayId`      ← l'OSPITE, che apre un link
 *   `GET /d/:relayId`      ← il DISPOSITIVO appaiato, da un'altra rete
 *
 * …e una per chi non parla niente:
 *   `*   /i/:relayId/…`    ← il BROWSER, che ha solo aperto un indirizzo
 *
 * `relayId` è il nome del punto d'incontro, ed è il DIGEST di un segreto che
 * non esce dalla macchina (`shared/relay-identita.ts`). Tre porte su quattro
 * non chiedono altro — chi arriva con un link ha solo il nome, ed è giusto
 * così. La prima chiede la preimmagine, perché non domanda una risorsa:
 * dichiara di ESSERE la macchina.
 *
 * Le prime tre sono agganci: chiedono un upgrade WebSocket e da lì in poi il
 * tubo. La quarta è una traduzione — una richiesta HTTPS qualunque entra, esce
 * come frame verso la macchina, e la sua risposta torna indietro come
 * `Response`. Senza di lei il tubo esisteva ma non aveva nessuna porta da cui
 * un telefono potesse entrare, perché un telefono non ha modo di diventare un
 * client del protocollo prima di bussare.
 *
 * Sulla quarta passano anche gli UPGRADE, e non è un caso a parte: l'ospite
 * del ponte è il relay, che accetta la stretta di mano del browser, apre un
 * canale nel tubo e fa da ponte nei due versi fino alla chiusura. Serve perché
 * l'applicazione non è fatta di sole richieste — ne apre quattro di socket per
 * pannello — e un sito che si carica ma non si aggiorna non è un sito che
 * funziona.
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
import { PAGINA_SENZA_CASA } from "./pagina-senza-casa";
import { PERCORSO_PONTE } from "./ponte";
import { INTESTAZIONE_SEGRETO, segretoCorrisponde } from "../../shared/relay-identita";

/** Quale installazione sta guardando questo browser. */
export const BISCOTTO_INSTALLAZIONE = "topics_inst";

/**
 * L'installazione ricordata, letta in modo stretto.
 *
 * Stretto perché questo valore sceglie a QUALE macchina instradare: una
 * stringa qualunque qui dentro è un modo di far cercare al relay un Durable
 * Object con un nome scritto da chi bussa. La forma è la stessa che il
 * percorso già impone.
 */
export function leggiInstallazione(cookie: string | null): string | null {
  if (!cookie) return null;
  for (const pezzo of cookie.split(";")) {
    const eq = pezzo.indexOf("=");
    if (eq === -1) continue;
    if (pezzo.slice(0, eq).trim() !== BISCOTTO_INSTALLAZIONE) continue;
    const v = pezzo.slice(eq + 1).trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null;
  }
  return null;
}

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
    // ── L'INSTALLAZIONE SI RICORDA, invece di stare nel percorso.
    //
    // Il bundle dell'app chiede `/assets/…`, `/boot.js`, `/manifest.json`:
    // percorsi ASSOLUTI dalla radice. Serviti sotto `/i/<id>/` il browser li
    // cerca fuori dal prefisso e prende 404 — pagina bianca, con l'HTML
    // arrivato e nient'altro. Visto dal vivo, ed è il motivo di questo giro.
    //
    // Riscrivere i percorsi nell'HTML non funziona: un `<base>` gli assoluti
    // li ignora per definizione, e riscrivere il bundle vorrebbe dire che il
    // relay ne capisce il contenuto.
    //
    // Quindi: la prima visita col prefisso DEPOSITA quale installazione, e
    // rimanda alla radice. Da lì in poi l'indirizzo è pulito e i percorsi
    // assoluti tornano a essere veri.
    const ponte = url.pathname.match(PERCORSO_PONTE);
    if (ponte) {
      const iid = ponte[1] ?? "";
      const resto = ponte[2] && ponte[2].length > 0 ? ponte[2] : "/";
      // Il rimando vale SOLO per la prima navigazione, cioè per la richiesta
      // che apre una pagina. Applicarlo a tutto — com'era nel primo tentativo
      // — rimanda anche gli asset, le chiamate all'API e una PUT con un corpo,
      // e un 302 su una PUT è un corpo che si perde per strada. Il prefisso
      // continua a funzionare per tutto il resto, e chi lo usa direttamente
      // (un client, un test, una curl) non si accorge di niente.
      const navigazione = req.method === "GET"
        && (req.headers.get("sec-fetch-dest") === "document"
          || (req.headers.get("accept") ?? "").includes("text/html"));
      if (!navigazione) {
        return env.SESSIONE.get(env.SESSIONE.idFromName(iid)).fetch(req);
      }
      return new Response(null, {
        status: 302,
        headers: {
          location: `${resto}${url.search}`,
          // `Path=/` perché vale per ogni percorso della sessione, non solo
          // per quello d'ingresso. Host-only e `Secure`: non esce da qui e non
          // viaggia in chiaro. `Lax` perché la navigazione che lo usa è quella
          // che l'utente fa cliccando, non una richiesta di terzi.
          "set-cookie": `${BISCOTTO_INSTALLAZIONE}=${iid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          "cache-control": "no-store",
        },
      });
    }

    // Ogni richiesta successiva: l'installazione viene dal biscotto.
    const ricordata = leggiInstallazione(req.headers.get("cookie"));
    if (ricordata && !/^\/(agent|s|d)\//.test(url.pathname)) {
      // Il prefisso torna, ma solo QUI DENTRO: il Durable Object riconosce una
      // richiesta da ponte guardando il percorso (`PERCORSO_PONTE`), e alla
      // radice non lo troverebbe. Rimetterlo per il salto interno tiene UNA
      // sola forma d'indirizzo fra chi instrada e chi traduce — che è la
      // ragione per cui quel modello sta scritto in un posto solo — senza che
      // chi apre il link se lo debba vedere.
      const dentro = new URL(url.toString());
      dentro.pathname = `/i/${ricordata}${url.pathname}`;
      return env.SESSIONE.get(env.SESSIONE.idFromName(ricordata)).fetch(new Request(dentro, req));
    }

    const m = url.pathname.match(/^\/(agent|s|d)\/([A-Za-z0-9_-]{1,128})$/);

    if (!m) {
      // ── IL VICOLO CIECO CHE STAVA QUI ──────────────────────────────────────
      //
      // Si arriva a questa riga anche quando a bussare è l'APP, e succede tutte
      // le volte che il biscotto non c'è: la PWA installata ha `start_url: "/"`
      // (`manifest.json`), quindi ogni avvio parte dalla radice. Finché il
      // biscotto è in vita il ramo sopra la manda a casa sua; quando scade,
      // quando il telefono lo butta per spazio o per privacy, o quando la PWA
      // viene reinstallata, resta questo — `404 not found`, in testo semplice,
      // per SEMPRE. Non c'è nessun gesto dentro l'app che possa rimediare,
      // perché l'app non è nemmeno stata servita.
      //
      // Misurato il 21/08/2026: `GET /` senza cookie → 404, e la schermata sul
      // telefono restava a «riprovo da solo fra qualche secondo» ritentando un
      // 404 che non sarebbe mai cambiato.
      //
      // Un 404 di testo è la risposta giusta per chi fruga, ed è la risposta
      // sbagliata per chi sta aprendo la propria app. Le due si distinguono da
      // ciò che il browser dichiara di volere: una NAVIGAZIONE riceve una
      // pagina che spiega e offre l'uscita, tutto il resto continua a ricevere
      // il 404 di prima. Il relay resta cieco: quella pagina non sa niente di
      // nessuno, non nomina nessuna installazione, e non ne cerca nessuna.
      const navigazione = req.method === "GET"
        && (req.headers.get("sec-fetch-dest") === "document"
          || (req.headers.get("accept") ?? "").includes("text/html"));
      if (navigazione) {
        return new Response(PAGINA_SENZA_CASA, {
          status: 404,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-robots-tag": "noindex, nofollow",
            "referrer-policy": "no-referrer",
          },
        });
      }
      // Nessuna pagina, nessun indice: un relay che risponde qualcosa a una
      // richiesta qualunque è un relay che invita a frugare.
      return new Response("not found", { status: 404 });
    }

    const [, ruolo, installationId] = m;
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("serve un upgrade websocket", { status: 426 });
    }

    // ── LA PORTA DELLA MACCHINA CHIEDE LA PREIMMAGINE ───────────────────────
    //
    // Le altre due porte non chiedono niente, ed è giusto: un ospite arriva con
    // un link e ciò che può aprire lo decide la macchina, non il relay. Questa
    // è diversa, perché non chiede una risorsa — dichiara di ESSERE la
    // macchina. E il Durable Object, per non tenere due host insieme, sfratta
    // quello di prima quando ne arriva uno nuovo: senza questo controllo, chi
    // conosceva il nome (cioè chiunque avesse ricevuto un link, dove il nome
    // sta scritto) poteva cacciare la macchina e prendersi tutto il traffico
    // dei suoi ospiti.
    //
    // Il controllo è una funzione pura e basta a se stessa: il nome è il digest
    // di un segreto, quindi chi presenta il segreto dimostra di aver creato il
    // nome. Nessun registro, nessuno stato, nessun primo-che-arriva-vince — e
    // il relay continua a non sapere CHI sei (RELAY-04), sa solo che quel nome
    // potevi costruirlo tu.
    if (ruolo === "agent") {
      const ok = await segretoCorrisponde(req.headers.get(INTESTAZIONE_SEGRETO), installationId ?? "");
      // Lo stesso corpo che darebbe un nome inesistente: a chi bussa senza
      // segreto non si conferma che quel punto d'incontro esiste.
      if (!ok) return new Response("not found", { status: 404 });
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
