/**
 * webm-duration.ts — quanto dura DAVVERO una clip, letto dal file.
 *
 * Il protocollo board dà un tetto alla clip di consegna (20s). Finora quel
 * tetto si rispettava a occhio: si registrava una clip lunga e la si tagliava
 * con `ffmpeg`, scegliendo l'istante di partenza a naso. Chi sbaglia il taglio
 * consegna un video che comincia dopo il click, e non se ne accorge nessuno.
 * Un numero letto dal contenitore rende quel controllo un cancello invece che
 * un'impressione.
 *
 * PERCHE' A MANO E NON `ffprobe`. Playwright si porta dietro il suo `ffmpeg`
 * (dentro i browser scaricati) ma NON `ffprobe`, e pretendere un binario di
 * sistema farebbe dipendere il verde dalla macchina che esegue. Del formato
 * serve pochissimo: Matroska/EBML è una sequenza di elementi
 * <id vint><dimensione vint><corpo>, e la durata sta in
 * `Segment › Info › Duration`, espressa in unità di `TimecodeScale`.
 *
 * La misura ha due fonti, in ordine:
 *  · `duration`  → l'header lo dichiara (il caso normale: il muxer torna
 *    indietro a scriverlo quando chiude il file).
 *  · `clusters`  → l'header non lo dichiara, allora si prende il timecode
 *    dell'ULTIMO cluster. È una stima per DIFETTO — manca l'ultimo pezzo di
 *    cluster — quindi come cancello è generosa, mai severa a sproposito, e chi
 *    legge la misura sa da dove viene.
 */
import { readFileSync } from "fs";

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMECODE = 0xe7;

/** Nanosecondi per tick quando `TimecodeScale` non c'è: 1 tick = 1 ms. */
const TIMECODE_SCALE_DEFAULT = 1_000_000;

export interface MisuraWebm {
  /** Durata della clip in millisecondi. */
  ms: number;
  /** Da dove esce il numero. `clusters` è una stima per difetto. */
  fonte: "duration" | "clusters";
}

/**
 * Quanti byte occupa un intero a lunghezza variabile, dal bit di marcatore del
 * primo byte: `1xxxxxxx` = 1 byte, `01xxxxxx` = 2, e così via. Zero = byte non
 * valido (nessun bit acceso), che per noi vuol dire "qui non c'è un elemento".
 */
function lengthVint(primo: number): number {
  for (let i = 0; i < 8; i++) if (primo & (0x80 >> i)) return i + 1;
  return 0;
}

/** L'ID di un elemento: i bit del marcatore FANNO PARTE del valore. */
function readId(buf: Buffer, pos: number): { id: number; dopo: number } | null {
  if (pos >= buf.length) return null;
  const len = lengthVint(buf[pos]);
  if (len === 0 || len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, dopo: pos + len };
}

/**
 * La dimensione del corpo: il marcatore si TOGLIE. Tutti i bit di valore a 1
 * significa "dimensione sconosciuta" (muxing in streaming): il corpo arriva
 * fino alla fine del genitore, e lo diciamo con `null`.
 */
function readSize(buf: Buffer, pos: number): { size: number | null; dopo: number } | null {
  if (pos >= buf.length) return null;
  const len = lengthVint(buf[pos]);
  if (len === 0 || pos + len > buf.length) return null;
  const primo = buf[pos] & (0xff >> len);
  let value = primo;
  let allOne = primo === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOne = false;
  }
  return { size: allOne ? null : value, dopo: pos + len };
}

interface Elemento {
  id: number;
  /** Primo byte del corpo. */
  corpo: number;
  /** Byte dopo l'ultimo del corpo. */
  fine: number;
}

/** Legge l'elemento che comincia a `pos`, senza uscire da `limite`. */
function readElement(buf: Buffer, pos: number, limite: number): Elemento | null {
  const testa = readId(buf, pos);
  if (!testa || testa.dopo > limite) return null;
  const dim = readSize(buf, testa.dopo);
  if (!dim) return null;
  const corpo = dim.dopo;
  if (corpo > limite) return null;
  const fine = dim.size === null ? limite : Math.min(corpo + dim.size, limite);
  return { id: testa.id, corpo, fine };
}

function wholeBE(buf: Buffer, da: number, a: number): number {
  let v = 0;
  for (let i = da; i < a; i++) v = v * 256 + buf[i];
  return v;
}

/** I float EBML sono 4 o 8 byte; 0 byte vale 0. Altro non esiste in Matroska. */
function floatBE(buf: Buffer, da: number, a: number): number | null {
  const n = a - da;
  if (n === 0) return 0;
  if (n === 4) return buf.readFloatBE(da);
  if (n === 8) return buf.readDoubleBE(da);
  return null;
}

/** Il primo figlio con quell'id, cercato solo al livello dato. */
function figlio(buf: Buffer, dentro: Elemento, id: number): Elemento | null {
  let pos = dentro.corpo;
  while (pos < dentro.fine) {
    const el = readElement(buf, pos, dentro.fine);
    if (!el) return null;
    if (el.id === id) return el;
    if (el.fine <= pos) return null; // elemento vuoto o malformato: non avanzeremmo mai
    pos = el.fine;
  }
  return null;
}

/**
 * Il timecode dell'ultimo cluster, in tick. Serve solo quando l'header non
 * dichiara la durata; `null` se nemmeno i cluster si leggono.
 *
 * Camminare la lista non basta sempre: un cluster può avere dimensione
 * sconosciuta, e da lì in poi il passo successivo non esiste. In quel caso si
 * ripiega su una scansione dei byte alla ricerca dell'id del cluster — non è
 * elegante, ma questo è un ramo di riserva e l'alternativa è nessuna misura.
 */
function ultimoTimecodeCluster(buf: Buffer, segment: Elemento): number | null {
  let ultimo: number | null = null;
  let pos = segment.corpo;
  let camminata = true;
  while (pos < segment.fine) {
    const el = readElement(buf, pos, segment.fine);
    if (!el || el.fine <= pos) {
      camminata = false;
      break;
    }
    if (el.id === ID_CLUSTER) {
      if (el.fine >= segment.fine) {
        // Dimensione sconosciuta: la lista finisce qui.
        camminata = false;
      }
      const tc = figlio(buf, el, ID_CLUSTER_TIMECODE);
      if (tc) ultimo = wholeBE(buf, tc.corpo, tc.fine);
      if (!camminata) break;
    }
    pos = el.fine;
  }
  if (camminata) return ultimo;

  // Riserva della riserva: cerco l'id del cluster byte per byte.
  const marcatore = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
  let idx = buf.indexOf(marcatore, segment.corpo);
  while (idx !== -1) {
    const el = readElement(buf, idx, buf.length);
    if (el) {
      const tc = figlio(buf, { ...el, fine: Math.min(el.fine, buf.length) }, ID_CLUSTER_TIMECODE);
      if (tc) ultimo = wholeBE(buf, tc.corpo, tc.fine);
    }
    idx = buf.indexOf(marcatore, idx + 4);
  }
  return ultimo;
}

/** La durata di un WebM già in memoria. Alza se il file non è un WebM leggibile. */
export function misuraWebm(buf: Buffer): MisuraWebm {
  let segment: Elemento | null = null;
  let pos = 0;
  while (pos < buf.length) {
    const el = readElement(buf, pos, buf.length);
    if (!el || el.fine <= pos) break;
    if (el.id === ID_SEGMENT) {
      segment = el;
      break;
    }
    pos = el.fine;
  }
  if (!segment) throw new Error("webm illeggibile: nessun elemento Segment");

  const info = figlio(buf, segment, ID_INFO);
  let scala = TIMECODE_SCALE_DEFAULT;
  if (info) {
    const ts = figlio(buf, info, ID_TIMECODE_SCALE);
    if (ts && ts.fine > ts.corpo) scala = wholeBE(buf, ts.corpo, ts.fine);
    const dur = figlio(buf, info, ID_DURATION);
    if (dur) {
      const tick = floatBE(buf, dur.corpo, dur.fine);
      if (tick !== null && tick > 0) return { ms: (tick * scala) / 1e6, fonte: "duration" };
    }
  }

  const tick = ultimoTimecodeCluster(buf, segment);
  if (tick === null) throw new Error("webm illeggibile: né Duration né un Cluster con Timecode");
  return { ms: (tick * scala) / 1e6, fonte: "clusters" };
}

/** Come `misuraWebm`, leggendo il file dal disco. */
export function misuraWebmFile(file: string): MisuraWebm {
  return misuraWebm(readFileSync(file));
}
