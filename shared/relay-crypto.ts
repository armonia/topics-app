/**
 * Il contenuto delle buste del relay: cifrato fra la macchina e il browser
 * dell'ospite, opaco a tutto quello che c'è in mezzo.
 *
 * ── DOVE STA LA CHIAVE, E PERCHÉ LÌ ─────────────────────────────────────────
 * Nel FRAMMENTO dell'URL — la parte dopo `#`. È l'unico posto di un link che il
 * browser **non manda mai al server**: non finisce nella riga di richiesta, non
 * finisce nei log di accesso, non finisce nel `Referer`. Quindi chi ospita il
 * relay può instradare la busta e non può aprirla, e questo è vero per
 * costruzione invece che per policy.
 *
 * La conseguenza va detta e non nascosta: **il link È la credenziale**. Chi ce
 * l'ha entra. Per questo un link scade, si revoca, e chi lo crea deve leggerlo
 * scritto accanto al pulsante — non scoprirlo dopo.
 *
 * ── LE SCELTE, E COSA SUCCEDE SE SI SBAGLIANO ───────────────────────────────
 * AES-256-GCM: cifra e AUTENTICA. Senza autenticazione un relay ostile potrebbe
 * modificare i byte che inoltra senza saper leggere — cioè non leggerebbe, ma
 * scriverebbe. Con GCM una busta manomessa non si apre, punto.
 *
 * Un IV CASUALE da 96 bit per ogni busta, mai riusato con la stessa chiave.
 * Riusare un IV in GCM non indebolisce la cifratura: la ROMPE, e rivela anche
 * la chiave di autenticazione. È il modo più comune di sbagliare con questo
 * algoritmo, per questo qui l'IV non è un parametro: lo genera questa funzione
 * e nessun chiamante può passarne uno.
 *
 * `base64url` ovunque: la chiave deve stare in un frammento di URL senza essere
 * codificata di nuovo, e una `+` o una `/` lì sarebbero da riscrivere.
 */

/** Versione del formato della busta. Un byte davanti, così cambiare algoritmo
 *  un domani non significa indovinare cosa si sta leggendo. */
export const BUSTA_V = 1;

const IV_BYTE = 12; // 96 bit: la dimensione raccomandata per GCM.
const KEY_BIT = 256;

// ── base64url, senza padding ───────────────────────────────────────────────

export function aB64u(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function daB64u(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  // `ArrayBuffer` esplicito: senza, il tipo è `ArrayBufferLike`, che include
  // `SharedArrayBuffer` — e le API di WebCrypto non lo accettano.
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Una chiave nuova, da mettere nel frammento del link.
 *
 * La genera la MACCHINA, non il relay: se la generasse il relay avrebbe avuto
 * la chiave in mano almeno una volta, e «non possiamo leggere» smetterebbe di
 * essere vero nel momento esatto in cui serve di più.
 */
export function nuovaChiave(): string {
  const b = new Uint8Array(new ArrayBuffer(KEY_BIT / 8));
  crypto.getRandomValues(b);
  return aB64u(b);
}

async function importa(chiave: string, uso: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", daB64u(chiave), { name: "AES-GCM" }, false, uso);
}

/**
 * Chiude un contenuto in una busta. Il risultato è una stringa sola, adatta al
 * campo `payload` del protocollo.
 *
 * L'IV viaggia in chiaro davanti al testo cifrato, ed è corretto: in GCM l'IV
 * non è un segreto, deve solo essere unico.
 */
export async function sigilla(chiave: string, testo: string): Promise<string> {
  const k = await importa(chiave, ["encrypt"]);
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTE));
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(testo)),
  );
  return `${BUSTA_V}.${aB64u(iv)}.${aB64u(ct)}`;
}

/**
 * Apre una busta, o restituisce `null`.
 *
 * `null` e non un'eccezione, e per ogni motivo lo stesso `null`: chiave
 * sbagliata, busta manomessa, formato irriconoscibile. Distinguerli nel valore
 * di ritorno vorrebbe dire raccontare a chi prova quale dei tre gli è capitato,
 * e da lì si costruisce un oracolo.
 */
export async function apri(chiave: string, busta: string): Promise<string | null> {
  try {
    const parti = busta.split(".");
    if (parti.length !== 3) return null;
    if (Number(parti[0]) !== BUSTA_V) return null;
    const iv = daB64u(parti[1]);
    if (iv.length !== IV_BYTE) return null;
    const k = await importa(chiave, ["decrypt"]);
    const chiaro = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, daB64u(parti[2]));
    return new TextDecoder().decode(chiaro);
  } catch {
    return null;
  }
}

/**
 * Il link da consegnare, e la sua lettura.
 *
 * Costruirlo e leggerlo stanno nello stesso posto perché il punto delicato è
 * uno solo — la chiave dopo `#` — e due funzioni scritte lontane sono due
 * occasioni di metterla prima.
 */
export function componiLink(base: string, relayId: string, shareRef: string, chiave: string): string {
  const u = new URL(base);
  // DUE segmenti, entrambi pubblici: quale PUNTO D'INCONTRO (serve al relay per
  // instradare) e quale condivisione (serve alla macchina per trovare la
  // chiave). Nessuno dei due apre niente da solo.
  //
  // Il primo è `relayId` e non `installationId`, e la differenza è tutta qui:
  // questo segmento va in mano a chiunque riceva il link. Quando i due erano lo
  // stesso valore, consegnarlo consegnava anche la credenziale con cui ci si
  // dichiara la macchina su `/agent/:id` (`shared/relay-identita.ts`).
  u.pathname = `${u.pathname.replace(/\/$/, "")}/g/${encodeURIComponent(relayId)}/${encodeURIComponent(shareRef)}`;
  // La chiave NON è un parametro di query: lì il browser la manderebbe al
  // server, e sarebbe finita nei log del relay prima ancora di essere usata.
  u.hash = chiave;
  u.search = "";
  return u.toString();
}

export function leggiLink(href: string): { relayId: string; shareRef: string; chiave: string } | null {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/g\/([^/]+)\/([^/]+)\/?$/);
    const chiave = u.hash.replace(/^#/, "");
    if (!m || !chiave) return null;
    return {
      relayId: decodeURIComponent(m[1]),
      shareRef: decodeURIComponent(m[2]),
      chiave,
    };
  } catch {
    return null;
  }
}
