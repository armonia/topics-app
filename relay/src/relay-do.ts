/**
 * Un'installazione e le sue sessioni, dentro un Durable Object.
 *
 * ── UNA SESSIONE È UN CANALE, NON UN LINK ───────────────────────────────────
 * Ogni capo che si aggancia riceve un identificatore, e su quello si consegna:
 * l'installazione può averne addosso molte insieme — ospiti di link e
 * dispositivi appaiati da un'altra rete — e nessuna aspetta le altre. Il RUOLO
 * di ognuna nasce dal percorso da cui si è entrati (`worker.ts`) e viaggia
 * nell'involucro: è la sola cosa che il relay aggiunge di suo, perché è la sola
 * che sa senza guardare dentro niente.
 *
 * ── QUESTO FILE SI ESEGUE ───────────────────────────────────────────────────
 * `relay-do.run.test.ts` istanzia questa classe e la guida come la guida il
 * runtime — `fetch()` e poi i metodi — con un contorno finto (coppia di socket,
 * tag, storage). Serve perché `relay-contract.test.ts` legge questo file come
 * una STRINGA: presidia i due difetti che non hanno sintomi, ma approverebbe
 * anche un instradamento sbagliato scritto con le parole giuste.
 *
 * ── L'IBERNAZIONE È UN REQUISITO, NON UN'OTTIMIZZAZIONE (RELAY-02) ──────────
 * Si usa `state.acceptWebSocket()` e MAI `ws.accept()`. La differenza non è di
 * stile: con `accept()` l'oggetto resta vivo in memoria per tutto il tempo in
 * cui la socket è aperta, e si paga la durata anche mentre nessuno parla.
 * L'esempio ufficiale di Cloudflare misura lo stesso identico carico nei due
 * modi: **$416/mese contro $10**. Quaranta volte, appese a quale funzione si
 * chiama.
 *
 * La conseguenza è che i gestori sono metodi dell'oggetto (`webSocketMessage`,
 * `webSocketClose`) e non `addEventListener`: fra un messaggio e l'altro
 * l'istanza può essere sfrattata dalla memoria, quindi **non si può tenere
 * niente in un campo**. Chi è ogni socket si ricava dai TAG che le si sono
 * attaccati all'accettazione, che sopravvivono all'ibernazione.
 *
 * ── IL RELAY NON CAPISCE (RELAY-03) ─────────────────────────────────────────
 * `payload` è opaco: si guarda solo l'involucro per sapere dove consegnare. La
 * chiave sta nel frammento dell'URL, che il browser non manda mai al server —
 * quindi non passa nemmeno di qui.
 */
import {
  leggiMessaggio, RELAY_PROTOCOL_VERSION,
  type MessaggioRelay, type Rifiutato, type RuoloSessione,
} from "../../shared/relay-protocol";

/** I tag identificano una socket DOPO l'ibernazione: sono l'unico stato che
 *  sopravvive allo sfratto dalla memoria. */
const TAG_MACCHINA = "host";

/**
 * Due tag per ogni sessione, e non uno solo con dentro tutto.
 *
 * `s:<id>` è l'INDIRIZZO: è su questo che si consegna, ed è l'unica chiave che
 * serve per instradare. `r:<ruolo>` è la porta da cui si è entrati. Tenerli
 * separati vuol dire che consegnare non richiede di sapere che tipo di sessione
 * sia — se fossero un tag solo (`guest:<id>`), aggiungere una seconda porta
 * costringerebbe ogni consegna a provare tutte le forme, e la forma dimenticata
 * sarebbe una sessione a cui non arriva più niente.
 */
const tagSessione = (sid: string) => `s:${sid}`;
const tagRuolo = (r: RuoloSessione) => `r:${r}`;

interface Stato {
  storage: DurableObjectStorage;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

export class SessioneRelay {
  constructor(private state: Stato) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const ruolo = url.searchParams.get("ruolo");
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("serve un upgrade websocket", { status: 426 });
    }

    const coppia = new WebSocketPair();
    const [client, mio] = [coppia[0], coppia[1]];

    if (ruolo === "host") {
      // Una macchina sola per installazione: se ne arriva una seconda, la
      // prima se ne va. Due host sullo stesso oggetto vorrebbe dire due
      // risposte alla stessa domanda, e nessun modo di sapere quale è viva.
      for (const vecchia of this.state.getWebSockets(TAG_MACCHINA)) {
        try { vecchia.close(4000, "sostituita"); } catch { /* già chiusa */ }
      }
      this.state.acceptWebSocket(mio, [TAG_MACCHINA]);
      mio.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION } satisfies MessaggioRelay));
    } else {
      const host = this.state.getWebSockets(TAG_MACCHINA);
      if (host.length === 0) {
        // Un motivo suo, non un errore generico: all'ospite va detto che la
        // macchina è spenta, invece di lasciarlo davanti a una pagina vuota
        // che si legge come «non ti hanno condiviso niente» (RELAY-05).
        return new Response(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
      // Il ruolo lo decide il PERCORSO, che è roba del relay: non si legge da
      // niente che il capo abbia scritto. Tutto ciò che non è la porta dei
      // dispositivi è un ospite — un valore inventato non promuove nessuno.
      const sessione: RuoloSessione = ruolo === "device" ? "device" : "guest";
      const sid = crypto.randomUUID();
      this.state.acceptWebSocket(mio, [tagSessione(sid), tagRuolo(sessione)]);
      mio.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, sessionId: sid } satisfies MessaggioRelay));
      host[0].send(JSON.stringify({ t: "guest-joined", sessionId: sid, ruolo: sessione } satisfies MessaggioRelay));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Chi è questa socket, letto dai tag. L'unico modo: fra un messaggio e
   *  l'altro l'istanza può essere stata sfrattata dalla memoria. */
  private chiE(ws: WebSocket): { host: true } | { sid: string; ruolo: RuoloSessione } | null {
    const tags = (this.state as unknown as { getTags(ws: WebSocket): string[] }).getTags(ws);
    if (tags.includes(TAG_MACCHINA)) return { host: true };
    const g = tags.find((t) => t.startsWith("s:"));
    if (!g) return null;
    return {
      sid: g.slice("s:".length),
      ruolo: tags.includes(tagRuolo("device")) ? "device" : "guest",
    };
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return; // i binari non fanno parte del protocollo
    let m: MessaggioRelay | null = null;
    try { m = leggiMessaggio(JSON.parse(raw)); } catch { m = null; }
    if (!m) {
      // Un capo che accetta ciò che quasi capisce è un capo che un giorno
      // accetta ciò che non capisce affatto.
      ws.send(JSON.stringify({ t: "denied", motivo: "bad-version" } satisfies Rifiutato));
      return;
    }

    const chi = this.chiE(ws);
    if (!chi) return;

    if ("host" in chi && m.t === "to-guest") {
      const dest = this.state.getWebSockets(tagSessione(m.to));
      // Una busta per un ospite che se n'è andato si lascia cadere in silenzio:
      // non è un errore della macchina, è il mondo che è cambiato.
      dest[0]?.send(raw);
      return;
    }

    if ("sid" in chi && m.t === "to-host") {
      const host = this.state.getWebSockets(TAG_MACCHINA);
      if (host.length === 0) {
        ws.send(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato));
        return;
      }
      // È il RELAY ad attaccare il mittente, non l'ospite: se lo scegliesse lui
      // potrebbe spacciarsi per un'altra sessione.
      host[0].send(JSON.stringify({ t: "to-guest", to: chi.sid, payload: m.payload } satisfies MessaggioRelay));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const chi = this.chiE(ws);
    if (!chi) return;

    if ("host" in chi) {
      // La macchina se n'è andata: gli ospiti devono saperlo, o restano a
      // guardare qualcosa che non si aggiorna più senza capire perché.
      for (const g of this.state.getWebSockets()) {
        const suo = this.chiE(g);
        if (suo && "sid" in suo) {
          try { g.send(JSON.stringify({ t: "denied", motivo: "host-offline" } satisfies Rifiutato)); } catch { /* va bene */ }
        }
      }
      return;
    }

    const host = this.state.getWebSockets(TAG_MACCHINA);
    host[0]?.send(JSON.stringify({ t: "guest-left", sessionId: chi.sid, ruolo: chi.ruolo } satisfies MessaggioRelay));
  }
}
