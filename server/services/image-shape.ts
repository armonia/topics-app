/**
 * Larghezza e altezza di un'immagine, lette dall'INTESTAZIONE.
 *
 * Serve al gate di forma dell'anteprima (`promoteReviewPreview`): la card della
 * board disegna l'anteprima in un riquadro `object-cover` alto al massimo
 * `PREVIEW_CARD_MAX_RATIO` volte la propria larghezza, quindi un'immagine molto
 * più alta che larga non viene rimpicciolita — viene tagliata,
 * e il reviewer si ritrova la fascia alta di un documento invece della consegna.
 * Per deciderlo servono due numeri, non un giudizio.
 *
 * Zero dipendenze e zero decodifica: si aprono i primi 64 kB del file e si
 * leggono i campi dell'header. Un decoder vero (sharp, image-size) sarebbe un
 * pacchetto nativo dentro un percorso che deve restare *best-effort*.
 *
 * **Regola d'oro: in caso di dubbio si RESTITUISCE null.** Chi chiama promuove
 * comunque quando la forma è ignota: questo modulo può far perdere un rifiuto,
 * non può far perdere un'anteprima.
 */
import { closeSync, openSync, readSync } from "node:fs";

export interface ImageShape {
  width: number;
  height: number;
  /** height / width — il numero che il gate confronta con la soglia. */
  ratio: number;
}

/** Quanto basta per l'header di tutti i formati qui sotto (SVG incluso). */
const HEAD_BYTES = 64 * 1024;

function readHead(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return n > 0 ? buf.subarray(0, n) : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

function png(b: Buffer): [number, number] | null {
  // \x89PNG\r\n\x1a\n + un chunk IHDR che per specifica è SEMPRE il primo.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function gif(b: Buffer): [number, number] | null {
  if (b.length < 10) return null;
  const magic = b.toString("latin1", 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return null;
  return [b.readUInt16LE(6), b.readUInt16LE(8)];
}

function jpeg(b: Buffer): [number, number] | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }          // riallineamento su byte di riempimento
    const marker = b[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    // SOF0-SOF15 portano le dimensioni; DHT/DAC/RST/SOS no. C4/C8/CC NON sono SOF.
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; // [w, h]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // senza payload
    if (marker === 0xda) return null;              // inizio dei dati: le dimensioni non ci sono più
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): [number, number] | null {
  if (b.length < 30) return null;
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = b.toString("latin1", 12, 16);
  if (chunk === "VP8X") {
    // canvas width-1 / height-1, 24 bit little-endian ciascuno.
    const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
    const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
    return [w + 1, h + 1];
  }
  if (chunk === "VP8 ") {
    // keyframe: sync 0x9d 0x01 0x2a, poi due u16LE con 14 bit utili.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return null;
}

function svg(b: Buffer): [number, number] | null {
  const text = b.toString("utf8");
  const open = /<svg\b[^>]*>/i.exec(text);
  if (!open) return null;
  const tag = open[0];
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, "i").exec(tag);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = attr("width");
  const h = attr("height");
  if (w && h) return [w, h];
  // Senza width/height espliciti (o in %) la forma la dà il viewBox: è il caso
  // NORMALE per un diagramma esportato, non un caso limite.
  const vb = /\bviewBox\s*=\s*["']\s*[-0-9.]+[,\s]+[-0-9.]+[,\s]+([0-9.]+)[,\s]+([0-9.]+)\s*["']/i.exec(tag);
  if (vb) {
    const vw = Number(vb[1]);
    const vh = Number(vb[2]);
    if (Number.isFinite(vw) && Number.isFinite(vh) && vw > 0 && vh > 0) return [vw, vh];
  }
  return null;
}

/**
 * Le dimensioni di un'immagine PNG/JPEG/GIF/WebP/SVG, oppure `null` per
 * qualunque altra cosa (video compresi) e per ogni file che non si lascia
 * leggere. Il formato si riconosce dai BYTE, non dall'estensione: un `.png`
 * che in realtà è un JPEG resta misurabile.
 */
export function imageShape(path: string): ImageShape | null {
  const b = readHead(path);
  if (!b) return null;
  const dims = png(b) ?? gif(b) ?? webp(b) ?? jpeg(b) ?? svg(b);
  if (!dims) return null;
  const [width, height] = dims;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height, ratio: height / width };
}
