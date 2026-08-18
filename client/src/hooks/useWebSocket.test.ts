/**
 * IL CANE DA GUARDIA SUL `pong`, guidato attraverso l'hook vero.
 *
 * Il guasto: il client mandava un `ping` ogni 30 secondi e non guardava MAI la
 * risposta. Su una connessione mezza aperta — il server ucciso di netto, il Mac
 * che dorme, Tailscale che cade — la socket resta `readyState === OPEN` e il
 * `send` non solleva niente. Nessun evento scatta: `onclose` non arriva, il
 * backoff non parte, e la board continua a mostrare lo stato di prima del
 * guasto finche' qualcuno non ricarica la pagina. Un ping senza qualcuno che
 * aspetti la risposta e' una lettera spedita a un indirizzo vuoto.
 *
 * PERCHE' L'HOOK E NON UNA FUNZIONE PURA. La sottrazione fra due istanti non e'
 * la cosa che si puo' rompere: cio' che si rompe e' il CABLAGGIO — il `pong`
 * datato dopo la validazione (dove uno schema mancante lo scarterebbe), il
 * `lastPongAt` non azzerato alla riapertura (e allora una socket nuova nasce
 * gia' scaduta e si chiude al primo giro), il timer che continua a chiamare
 * `close` a vuoto. Sono tutti difetti che una funzione pura passa a pieni voti.
 *
 * I timer sono finti e `Date.now` pure: l'orologio lo muove il test, cosi' le
 * soglie si provano in millisecondi invece che in minuti.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as React from 'react';
import { mount } from '../test/reactHarness';
import { useWebSocket } from './useWebSocket';

const g = globalThis as unknown as Record<string, unknown>;

/** La socket che il test guida a mano. Nessuna rete, nessun evento vero. */
class SocketFinta {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SocketFinta.CONNECTING;
  readonly inviati: string[] = [];
  chiusure = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { socket.push(this); }
  send(d: string): void { this.inviati.push(d); }
  close(): void { this.chiusure += 1; this.readyState = SocketFinta.CLOSING; }
  /** Il server ha accettato: e' qui che l'hook arma il ping. */
  apri(): void { this.readyState = SocketFinta.OPEN; this.onopen?.(); }
  consegna(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
  /** I frame che il client ha spedito, decodificati. */
  tipiInviati(): string[] { return this.inviati.map((s) => (JSON.parse(s) as { type: string }).type); }
}

let socket: SocketFinta[] = [];
/** Le richiamate di `setInterval` ancora armate: le fa scattare il test. */
let intervalli = new Map<number, () => void>();
let orologio = 0;

const salvati: Record<string, unknown> = {};
const dateNowVero = Date.now;

beforeEach(() => {
  socket = [];
  intervalli = new Map();
  orologio = 1_700_000_000_000;

  for (const k of ['WebSocket', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'window', 'document']) {
    salvati[k] = g[k];
  }

  // Si innesta su una finestra che un altro file del suite potrebbe aver gia'
  // installato, invece di sostituirla: in questo repo la finestra finta e' di
  // processo, e sovrascriverne una che un altro modulo ha gia' catturato e' il
  // modo in cui un sottoinsieme della suite diventa rosso da solo.
  const w = (g.window as Record<string, unknown> | undefined) ?? {};
  w.location ??= { protocol: 'http:', host: '127.0.0.1:3333' };
  w.addEventListener ??= () => {};
  w.removeEventListener ??= () => {};
  g.window = w;
  const d = (g.document as Record<string, unknown> | undefined) ?? {};
  d.hidden ??= false;
  d.addEventListener ??= () => {};
  d.removeEventListener ??= () => {};
  g.document = d;

  g.WebSocket = SocketFinta;
  let seq = 0;
  g.setInterval = (fn: () => void) => { intervalli.set(++seq, fn); return seq; };
  g.clearInterval = (id: number) => { intervalli.delete(id); };
  // I `setTimeout` dell'hook (la grazia sullo stato, il timer di offline, il
  // backoff di riconnessione) si catturano e non si eseguono: nessuno di loro
  // riguarda il polso, e lasciarli veri lascerebbe timer vivi dopo il test.
  g.setTimeout = () => 0;
  g.clearTimeout = () => {};
  Date.now = () => orologio;
});

afterEach(() => {
  for (const [k, v] of Object.entries(salvati)) {
    if (v === undefined) delete g[k]; else g[k] = v;
  }
  Date.now = dateNowVero;
});

/** Fa scattare ogni intervallo armato, una volta. */
function battiIlTimer(): void {
  for (const fn of [...intervalli.values()]) fn();
}

function guida(): { api: () => ReturnType<typeof useWebSocket>; smonta: () => void } {
  const scatola: { current: ReturnType<typeof useWebSocket> | null } = { current: null };
  function Sonda(): null {
    const live = useWebSocket();
    React.useEffect(() => { scatola.current = live; });
    return null;
  }
  const h = mount(React.createElement(Sonda));
  return {
    api: () => {
      if (!scatola.current) throw new Error('useWebSocket non e\' montato');
      return scatola.current;
    },
    smonta: () => h.unmount(),
  };
}

describe('il polso della connessione WS', () => {
  test('senza risposta al ping la socket viene CHIUSA, e la riconnessione riparte', () => {
    // Il guasto vero: `readyState` resta OPEN per sempre, quindi solo una
    // chiusura decisa da noi puo' rimettere in moto il backoff.
    const { smonta } = guida();
    const ws = socket[0]!;
    ws.apri();

    orologio += 40_000;
    battiIlTimer();
    expect(ws.chiusure).toBe(0);           // 40s di silenzio non bastano
    expect(ws.tipiInviati()).toContain('ping');

    orologio += 40_000;                    // 80s dall'ultimo segno di vita
    battiIlTimer();
    expect(ws.chiusure).toBe(1);
    smonta();
  });

  test('un `pong` fa ripartire il conto: una connessione viva non viene chiusa', () => {
    const { smonta } = guida();
    const ws = socket[0]!;
    ws.apri();

    orologio += 60_000;
    ws.consegna({ type: 'pong' });         // il server risponde: e' vivo
    orologio += 60_000;                    // 120s dall'apertura, 60 dal pong

    battiIlTimer();
    expect(ws.chiusure).toBe(0);
    // …e senza quel `pong` la stessa distanza dall'apertura avrebbe chiuso:
    // e' la prova che a contare e' la RISPOSTA, non il tempo dall'apertura.
    orologio += 80_000;
    battiIlTimer();
    expect(ws.chiusure).toBe(1);
    smonta();
  });

  test('il `pong` conta come segno di vita anche se lo schema lo scartasse', () => {
    // E' datato PRIMA della validazione, e non prosegue: un frame di keepalive
    // non ha niente da dire ai sottoscrittori, e non deve dipendere dal
    // registro degli schemi per tenere viva la connessione.
    const { api, smonta } = guida();
    const ws = socket[0]!;
    ws.apri();
    const visti: string[] = [];
    api().onMessage((m) => visti.push((m as { type: string }).type));

    ws.consegna({ type: 'pong' });
    ws.consegna({ type: 'topics:updated' });

    expect(visti).toEqual(['topics:updated']);
    smonta();
  });

  test('il timer scaduto si spegne: nessuna raffica di `close` sulla stessa socket', () => {
    // Fra la chiusura e l'`onclose` del browser passa del tempo. Se
    // l'intervallo restasse armato, ogni trenta secondi ripeterebbe la
    // chiusura di una socket che sta gia' morendo.
    const { smonta } = guida();
    const ws = socket[0]!;
    ws.apri();

    orologio += 80_000;
    battiIlTimer();
    expect(ws.chiusure).toBe(1);

    orologio += 80_000;
    battiIlTimer();
    expect(ws.chiusure).toBe(1);
    smonta();
  });

  test("una connessione NUOVA nasce col polso azzerato, non gia' scaduta", () => {
    // Il caso del Mac che dorme: al risveglio sono passate ore. Se il conto non
    // ripartisse dall'apertura, ogni socket nuova si chiuderebbe al primo giro
    // del timer, in un ciclo di riconnessioni che non finisce mai.
    const { api, smonta } = guida();
    socket[0]!.apri();

    orologio += 3 * 3_600_000;             // tre ore di sonno
    api().reconnect();
    const nuova = socket[1]!;
    expect(nuova).toBeDefined();
    nuova.apri();

    orologio += 10_000;
    battiIlTimer();
    expect(nuova.chiusure).toBe(0);
    expect(nuova.tipiInviati()).toContain('ping');
    smonta();
  });
});
