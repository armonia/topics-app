/**
 * Il relay, montato per intero dentro un test E2E.
 *
 * ── COSA C'È DI VERO QUI DENTRO ─────────────────────────────────────────────
 * Tutto tranne la rete fra i due capi. Il capo MACCHINA è
 * `creaRelayClient` — lo stesso modulo che gira in produzione, col suo proxy —
 * e la porta contro cui rigioca è l'ascoltatore dedicato del server di test,
 * cioè lo stesso `Bun.serve` completo che in produzione sta dietro al tunnel.
 * Il capo OSPITE è quello di `shared/relay-fake.ts`, che è una SECONDA
 * implementazione del protocollo: se il proxy cominciasse a dipendere da un
 * campo che il formato non promette, questo smetterebbe di capirlo.
 *
 * In mezzo c'è `creaRelayFinto`, che instrada e non capisce — esattamente come
 * il Worker. Il Worker vero non si tocca e non si deploya: quello è un passo
 * umano, separato.
 *
 * ── PERCHÉ DUE SESSIONI E NON UNA ───────────────────────────────────────────
 * `creaOspiteHttp` e `creaOspiteWs` hanno ciascuno il PROPRIO contatore di
 * stream, e i due contatori del lato ospite partono dallo stesso numero. Su una
 * sessione sola il secondo riaprirebbe uno stream già vivo, e il riassemblatore
 * della macchina avrebbe ragione a rifiutarlo. Due sessioni sono anche la cosa
 * più onesta da rappresentare: sono due agganci dello stesso dispositivo, che è
 * ciò che succede quando una pagina apre l'API e la socket.
 */
import {
  creaOspiteHttp, creaOspiteWs, creaRelayFinto, SEGRETO_FINTO,
  type AperturaWs, type RispostaTubo, type SocketOspite,
} from "../../../shared/relay-fake";
import { involucro, leggiFramePayload, leggiMessaggio, type FrameTubo } from "../../../shared/relay-protocol";
import type { Intestazioni } from "../../../shared/relay-http";
import { creaRelayClient } from "../../../server/services/relay-client";
import {
  creaPonte, macchinaSpenta, PERCORSO_PONTE, upgradeRifiutato, type SocketPonte,
} from "../../../relay/src/ponte";
import { openSocketWithHeaders } from "./node-websocket";

const INSTALLAZIONE = "e2e-relay";

/**
 * L'origine su cui vive il relay in questi test.
 *
 * Serve perché il ponte parte da una `Request` VERA — quella che farebbe un
 * telefono — e una `Request` senza origine non esiste. Il nome non risolve e
 * non deve: nessuno lo apre davvero, il tubo lo prende da lì e basta.
 */
const ORIGINE_RELAY = "https://relay.esempio";

/** Un filo che non è una rete: la stessa forma di `WebSocket` per i due soli
 *  versi che il client usa (mandare, e ricevere nel richiamo). */
class FiloFinto {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Dove finisce ciò che la macchina manda. */
  consegna: ((d: string) => void) | null = null;
  send(d: string) { this.consegna?.(d); }
  close() { this.readyState = 3; }
}

export interface RispostaRelay {
  stato: number;
  corpo: string;
}

export interface SocketRelay {
  socket: SocketOspite;
  /** Ciò che è arrivato su questa socket, in ordine. */
  frame: string[];
  /** Il codice di chiusura, quando è arrivata. */
  chiusura: () => { c: number; r: string; stato?: number } | null;
  /** Aspetta che almeno un frame soddisfi il predicato. */
  attendi(p: (f: string) => boolean, ms?: number): Promise<boolean>;
}

/**
 * Il socket di un BROWSER che è entrato dal ponte.
 *
 * È il capo che nel Worker vero il runtime regala a chi ha bussato: ciò che il
 * ponte ci scrive sopra è ciò che la pagina riceve, e ciò che si manda di qui è
 * ciò che la pagina invia.
 */
export interface SocketBrowser {
  /** Lo stato della risposta all'upgrade: `101` quando è stato aperto, oppure
   *  quello che il ponte fa leggere a chi ha bussato (`upgradeRifiutato`). */
  stato: number;
  /** I frame arrivati alla pagina, in ordine. */
  frame: string[];
  /** Un frame dalla pagina verso la macchina. `false` = questo socket qui non
   *  esiste, che è ciò che nel Worker fa chiudere il filo. */
  manda(dato: string | Uint8Array): boolean;
  /** La pagina chiude. */
  chiudi(codice?: number, motivo?: string): void;
  /** Con che codice il ponte ha chiuso verso la pagina, quando l'ha fatto. */
  chiusura: () => { c?: number; r?: string } | null;
  attendi(p: (f: string) => boolean, ms?: number): Promise<boolean>;
}

export interface RelayE2E {
  /** Una richiesta HTTP che entra dal relay. */
  chiedi(
    metodo: string, percorso: string,
    extra?: { cookie?: string; corpo?: string },
  ): Promise<RispostaRelay>;
  /** Un WebSocket che entra dal relay. Torna quando la stretta di mano è finita
   *  — riuscita o rifiutata: il chiamante guarda `socket.stato()`. */
  apriSocket(percorso: string, extra?: { cookie?: string }, ms?: number): Promise<SocketRelay>;
  /** Gli INVOLUCRI di tutto ciò che è passato dal relay. Niente contenuti: è la
   *  promessa del protocollo, e qui si può guardare che sia vera. */
  involucri: Array<Record<string, unknown>>;
  /** Le buste INTERE, come sono passate sul filo. Servono da controllo
   *  positivo: senza, «l'id non compare nell'involucro» sarebbe verde anche se
   *  quell'id non fosse mai stato sul filo. */
  grezzi: string[];
  /** Quante sessioni ospiti tiene aperte la macchina. */
  sessioniHost: () => number;

  // ── IL PONTE: dal browser, senza nessun client speciale ──────────────────
  /** L'indirizzo di questa installazione sul relay: è quello che si scrive
   *  nella barra. Da qui esce l'URL da cui parte una `Request` vera. */
  indirizzo(percorso: string): string;
  /**
   * Una richiesta HTTPS normale, servita dal ponte.
   *
   * Entra una `Request` e esce una `Response` — nessuna delle due parla il
   * protocollo del tubo, che è esattamente il punto: chi apre il link non ha
   * niente di speciale in mano.
   */
  dalBrowser(req: Request): Promise<Response>;
  /** Un upgrade WebSocket normale, servito dal ponte. */
  socketDalBrowser(req: Request): Promise<SocketBrowser>;
  /** I frame del TUBO passati sotto il ponte, nei due versi. Servono da
   *  controllo positivo: senza, «il corpo è tornato intero» non direbbe se è
   *  tornato in un pezzo solo o in dodici. */
  framePonte: Array<{ verso: "chiede" | "risponde"; f: FrameTubo }>;
  /** La macchina si scollega dal relay, come quando cade la rete di casa. */
  spegniMacchina(): void;

  chiudi(): void;
}

/**
 * Alza relay finto + macchina, e torna i verbi per entrarci da fuori.
 *
 * `portaTunnel` è l'ascoltatore dedicato del server di test: è LÌ che il proxy
 * rigioca, e non sulla porta principale — quella è la porta di cui ogni
 * richiesta è locale, cioè proprietaria senza credenziali.
 */
export function alzaRelayE2E(portaTunnel: number | null): RelayE2E {
  const relay = creaRelayFinto();
  const involucri: Array<Record<string, unknown>> = [];
  const grezzi: string[] = [];
  const daChiudere: Array<() => void> = [];

  /** Ogni busta che tocca il relay, per intero e ridotta a ciò che il relay
   *  può leggerne. Le due liste servono insieme: la seconda da sola non
   *  dimostrerebbe niente. */
  const registra = (raw: string) => {
    grezzi.push(raw);
    const m = leggiMessaggio((() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })());
    if (m) involucri.push(involucro(m));
  };

  // ── Il capo MACCHINA: il client vero, su un filo finto ────────────────────
  const filo = new FiloFinto();
  const macchina = relay.collegaMacchina((m) => {
    const raw = JSON.stringify(m);
    registra(raw);
    filo.onmessage?.({ data: raw });
  });
  filo.consegna = (d) => { registra(d); macchina.ricevi(JSON.parse(d) as unknown); };

  const client = creaRelayClient({
    baseUrl: "http://relay.finto",
    relayId: INSTALLAZIONE,
    segreto: SEGRETO_FINTO,
    // Il vecchio verbo dei link di condivisione non c'entra con questa strada:
    // qui si passa dal TUBO, e questi tre non vengono mai chiamati.
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 404, body: {} }),
    segnaApertura: () => {},
    apriSocket: () => filo as unknown as WebSocket,
    // Il socket verso l'ascoltatore del tunnel lo apre il PROXY vero, e qui il
    // proxy vero gira dentro Node — non dentro Bun, come in produzione. Il suo
    // valore di serie è `new WebSocket(url, { headers })`, che su Bun è l'unico
    // modo di portare il biscotto dell'ospite fino alla stretta di mano; su Node
    // 20 (il runner CI) `WebSocket` globale non esiste, la riga solleva, il
    // proxy trasforma il guasto nel rifiuto che sa dire — `502` — e la spec
    // legge «l'upgrade non si apre» senza sapere che manca un globale. È il giro
    // che ha tinto di rosso RELAY-E2E-03/08/09 il 2026-08-15, verdi su ogni
    // macchina di sviluppo.
    //
    // Non si tocca la produzione per un runtime che la produzione non ha: il
    // cardine iniettabile esiste apposta, e ciò che ci si mette è lo STESSO
    // socket quando la piattaforma ce l'ha (quindi su un portatile si continua a
    // misurare la strada vera), `ws` quando non c'è — l'unico client di qua che
    // accetta intestazioni senza dipendere da un globale.
    apriSocketLocale: (url, o) => openSocketWithHeaders(url, {
      headers: Object.fromEntries(o.intestazioni),
      protocols: o.protocolli,
    }) as WebSocket,
    portaTunnel,
  });
  client.avvia();
  // Il filo è già «aperto»: lo si dichiara, ed è quello che fa partire l'hello.
  filo.onopen?.();

  /** Un aggancio nuovo di questo dispositivo, con il suo capo ospite. */
  function agganciaDispositivo(consegnaPayload: (p: string) => void) {
    const capo = relay.collegaDispositivo(INSTALLAZIONE, (m) => {
      registra(JSON.stringify(m));
      if (m.t === "to-guest") consegnaPayload(m.payload);
    });
    if (capo.sessionId() === null) throw new Error("il relay finto non ha visto la macchina collegata");
    daChiudere.push(() => capo.scollega());
    return (payload: string) => {
      const busta = { t: "to-host" as const, payload };
      registra(JSON.stringify(busta));
      capo.ricevi(busta);
    };
  }

  // ── Il capo PONTE: quello del Worker, su questa sessione ──────────────────
  //
  // Uno solo per installazione, come in produzione: il ponte ha UN contatore di
  // stream per HTTP e WebSocket insieme, quindi le due strade non si pestano i
  // numeri e non serve una sessione a testa. È anche ciò che il Durable Object
  // fa davvero (`ponteVivo()` in `relay-do.ts`), e tenerlo uguale è il motivo
  // per cui questo test parla del prodotto e non di sé stesso.
  const framePonte: Array<{ verso: "chiede" | "risponde"; f: FrameTubo }> = [];
  let ponte: ReturnType<typeof creaPonte> | null = null;
  let macchinaViva = true;

  function ponteVivo(): ReturnType<typeof creaPonte> {
    if (ponte) return ponte;
    const versoHost = agganciaDispositivo((p) => {
      const f = leggiFramePayload(p);
      if (f) framePonte.push({ verso: "risponde", f });
      ponte?.ricevi(p);
    });
    ponte = creaPonte({
      invia: (p) => {
        const f = leggiFramePayload(p);
        if (f) framePonte.push({ verso: "chiede", f });
        versoHost(p);
      },
    });
    return ponte;
  }

  /**
   * Da un URL al percorso che la macchina rigioca — le STESSE tre righe del
   * Durable Object (`relay-do.ts`, ramo del ponte).
   *
   * Sono ricopiate e non importate perché lì stanno dentro `fetch()` di un
   * oggetto che vuole il runtime di Cloudflare, e montarlo qui vorrebbe dire
   * portarsi dietro `WebSocketPair` e l'ibernazione per provare una cosa che
   * non le riguarda. Ciò che si sta provando sta sotto: il ponte, il tubo, la
   * macchina e il server veri.
   */
  function instrada(url: string): { percorso: string; prefisso: string } | null {
    const u = new URL(url);
    const m = u.pathname.match(PERCORSO_PONTE);
    if (!m) return null;
    return {
      percorso: `${m[2] && m[2].length > 0 ? m[2] : "/"}${u.search}`,
      prefisso: `/i/${m[1]}`,
    };
  }

  /** Il capo del browser, ridotto a ciò che il ponte gli fa. */
  class CapoBrowser implements SocketPonte {
    frame: string[] = [];
    chiusa: { c?: number; r?: string } | null = null;
    send(d: string | Uint8Array | ArrayBuffer): void {
      if (this.chiusa) throw new Error("socket chiusa");
      this.frame.push(typeof d === "string" ? d : new TextDecoder().decode(d as Uint8Array));
    }
    close(c?: number, r?: string): void { this.chiusa ??= { c, r }; }
  }

  return {
    involucri,
    grezzi,
    framePonte,
    sessioniHost: () => client.__sessioni(),

    indirizzo: (percorso) => `${ORIGINE_RELAY}/i/${INSTALLAZIONE}${percorso}`,

    async dalBrowser(req) {
      const r = instrada(req.url);
      // Un indirizzo che non è quello del ponte non è affar suo: nel Worker
      // vero cade sulle altre porte, che vogliono tutte un upgrade.
      if (!r) return new Response("upgrade websocket required\n", { status: 426 });
      // Il cancello del Durable Object: senza macchina collegata non c'è
      // niente a cui girare la domanda, e lo si DICE invece di aspettare che
      // scada — mezzo minuto di scheda che gira per una cosa già nota.
      if (!macchinaViva) return macchinaSpenta();
      return ponteVivo().servi(req, r.percorso, r.prefisso);
    },

    async socketDalBrowser(req) {
      const vuoto: SocketBrowser = {
        stato: 426, frame: [],
        manda: () => false, chiudi: () => {}, chiusura: () => null,
        attendi: async () => false,
      };
      const r = instrada(req.url);
      if (!r) return vuoto;
      if (!macchinaViva) return { ...vuoto, stato: macchinaSpenta().status };

      const p = ponteVivo();
      const e = await p.apriWs(req, r.percorso);
      if (!e.ok) return { ...vuoto, stato: upgradeRifiutato(e.stato).status };

      const capo = new CapoBrowser();
      p.collegaWs(e.sIn, capo);
      daChiudere.push(() => p.chiudiWs(e.sIn, 1000, "fine del test"));

      return {
        stato: 101,
        frame: capo.frame,
        manda: (d) => p.messaggioWs(e.sIn, d),
        chiudi: (c, m) => p.chiudiWs(e.sIn, c, m),
        chiusura: () => capo.chiusa,
        async attendi(pred, attesa = 10_000) {
          const limite = Date.now() + attesa;
          while (Date.now() < limite) {
            if (capo.frame.some(pred)) return true;
            await new Promise((res) => setTimeout(res, 25));
          }
          return capo.frame.some(pred);
        },
      };
    },

    spegniMacchina() {
      if (!macchinaViva) return;
      macchinaViva = false;
      // Le stesse due mosse di `scollegaPonte()`: chi aspettava non aspetta
      // più, e i socket vivi si chiudono dicendo perché. Senza, resterebbero
      // aperti verso una macchina che non c'è — cioè somiglierebbero a
      // funzionare.
      ponte?.abbandona();
      macchina.scollega();
    },

    async chiedi(metodo, percorso, extra = {}) {
      let ospiteHttp: ReturnType<typeof creaOspiteHttp> | null = null;
      const versoHost = agganciaDispositivo((p) => ospiteHttp?.ricevi(p));
      ospiteHttp = creaOspiteHttp({ invia: versoHost });

      const h: Intestazioni = [];
      if (extra.cookie) h.push(["cookie", extra.cookie]);
      if (extra.corpo !== undefined) h.push(["content-type", "application/json"]);

      const r: RispostaTubo | null = await ospiteHttp.chiedi(metodo, percorso, {
        h, ...(extra.corpo !== undefined ? { corpo: extra.corpo } : {}),
      }).risposta;
      // `null` = la corsia è morta. Si dice con uno stato che NON esiste sul
      // filo, così nessun test può scambiarlo per una risposta del server.
      if (!r) return { stato: 0, corpo: "" };
      return { stato: r.stato, corpo: r.testo() };
    },

    async apriSocket(percorso, extra = {}, ms = 15_000) {
      let ospiteWs: ReturnType<typeof creaOspiteWs> | null = null;
      const versoHost = agganciaDispositivo((p) => ospiteWs?.ricevi(p));
      ospiteWs = creaOspiteWs({ invia: versoHost });

      const frame: string[] = [];
      let chiusura: { c: number; r: string; stato?: number } | null = null;
      let finito = false;

      const h: Intestazioni = [];
      if (extra.cookie) h.push(["cookie", extra.cookie]);

      // Il richiamo può rientrare DENTRO `apri()` — il trasporto qui è
      // sincrono fino alla stretta di mano vera — quindi chi risolve va
      // preparato prima di aprire, e non dopo.
      let sveglia: (() => void) | null = null;
      const fine = new Promise<void>((res) => { sveglia = res; });
      const finisci = () => { if (!finito) { finito = true; sveglia?.(); } };

      const cb: AperturaWs = {
        h,
        suAperto: finisci,
        suMessaggio: (d) => frame.push(typeof d === "string" ? d : new TextDecoder().decode(d)),
        suChiuso: (c, r, stato) => {
          chiusura = { c, r, ...(stato !== undefined ? { stato } : {}) };
          finisci();
        },
      };
      const socket: SocketOspite = ospiteWs.apri(percorso, cb);
      daChiudere.push(() => { try { socket.chiudi(); } catch { /* già chiusa */ } });

      let scadenza: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([fine, new Promise<void>((res) => { scadenza = setTimeout(res, ms); })]);
      if (scadenza) clearTimeout(scadenza);

      return {
        socket,
        frame,
        chiusura: () => chiusura,
        async attendi(p, attesa = 10_000) {
          const limite = Date.now() + attesa;
          while (Date.now() < limite) {
            if (frame.some(p)) return true;
            await new Promise((r) => setTimeout(r, 25));
          }
          return frame.some(p);
        },
      };
    },

    chiudi() {
      while (daChiudere.length > 0) daChiudere.pop()?.();
      client.ferma();
    },
  };
}
