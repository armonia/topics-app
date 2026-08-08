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
  creaOspiteHttp, creaOspiteWs, creaRelayFinto,
  type AperturaWs, type RispostaTubo, type SocketOspite,
} from "../../../shared/relay-fake";
import { involucro, leggiMessaggio } from "../../../shared/relay-protocol";
import type { Intestazioni } from "../../../shared/relay-http";
import { creaRelayClient } from "../../../server/services/relay-client";

const INSTALLAZIONE = "e2e-relay";

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
    installationId: INSTALLAZIONE,
    // Il vecchio verbo dei link di condivisione non c'entra con questa strada:
    // qui si passa dal TUBO, e questi tre non vengono mai chiamati.
    trovaLink: () => null,
    serviRisorsa: async () => ({ status: 404, body: {} }),
    segnaApertura: () => {},
    apriSocket: () => filo as unknown as WebSocket,
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

  return {
    involucri,
    grezzi,
    sessioniHost: () => client.__sessioni(),

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
