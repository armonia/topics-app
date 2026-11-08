/**
 * Coniare un gettone di licenza. Il pezzo che sta SOLO dal lato di chi vende.
 *
 * ── PERCHÉ È UN MODULO E NON UNA FUNZIONE DENTRO LO SCRIPT ──────────────────
 * Il conio ha due chiamanti: `scripts/licenza.ts conia` (a mano, per il cliente
 * che paga con bonifico) e `scripts/conio-licenze.ts` (il servizio che ascolta
 * Stripe). Due copie della stessa firma sono due copie che col tempo si
 * allontanano — e la copia che si allontana è sempre quella che nessuno prova,
 * quindi il gettone rotto arriva al cliente e non al banco di prova.
 *
 * ── QUESTO CODICE NON CONCEDE NIENTE ────────────────────────────────────────
 * Firmare non è autorizzare. Il gettone che esce di qui viene RIVERIFICATO
 * dall'installazione con la chiave pubblica (`server/lib/licenza.ts`), che resta
 * l'unica porta di ciò che è concesso. Se questo modulo sbaglia — carico storto,
 * installazione sbagliata, scadenza nel passato — il cliente finisce sul piano
 * gratuito con un motivo leggibile, non su un piano che non ha pagato.
 *
 * ── LA PRIVATA NON VIVE QUI ─────────────────────────────────────────────────
 * Entra come argomento, sempre. Non c'è un percorso di default, non si legge una
 * variabile d'ambiente da dentro: chi conia decide dove tiene il segreto e lo
 * passa. Un modulo che va a cercarsi la chiave da solo è un modulo che un giorno
 * la trova in un posto che nessuno voleva. Dove vive davvero:
 * `docs/licenze-rilascio.md`.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/** Il prefisso PKCS#8 di Ed25519. I 32 byte del seed, da soli, `node:crypto`
 *  non li accetta: vuole la struttura DER intorno. */
const PREFISSO_PKCS8 = "302e020100300506032b657004220420";

/** Il `kid` di default. Non decide niente in verifica (si provano comunque
 *  tutte le chiavi integrate) ma dice QUALE chiave ha firmato quando un giorno
 *  ce ne sarà più di una — cioè il giorno della rotazione, che è esattamente
 *  quello in cui non si vuole indovinare. */
export const KID_DEFAULT = "armonia-1";

export const POSTI_MIN = 1;
export const POSTI_MAX = 10_000;

export type OutcomeKey =
  | { ok: true; chiave: KeyObject }
  | { ok: false; motivo: "assente" | "lunghezza" | "illeggibile" };

/**
 * Dai 32 byte in base64url a una chiave privata usabile.
 *
 * **Non solleva.** Chi la chiama è o uno script (che deve stampare una frase
 * comprensibile) o un servizio HTTP (che non deve rispondere `500` a Stripe
 * perché a noi manca una variabile): entrambi vogliono un esito, non
 * un'eccezione che risale.
 */
export function caricaPrivata(grezza: string | undefined | null): OutcomeKey {
  const s = (grezza ?? "").trim();
  if (!s) return { ok: false, motivo: "assente" };
  let seed: Buffer;
  try {
    seed = Buffer.from(s, "base64url");
  } catch {
    return { ok: false, motivo: "illeggibile" };
  }
  if (seed.length !== 32) return { ok: false, motivo: "lunghezza" };
  try {
    const chiave = createPrivateKey({
      key: Buffer.concat([Buffer.from(PREFISSO_PKCS8, "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    return { ok: true, chiave };
  } catch {
    return { ok: false, motivo: "illeggibile" };
  }
}

export interface OpzioniConio {
  /** L'installazione del cliente. Il gettone vale SOLO per questa: copiato
   *  altrove dà `other_installation`. */
  installationId: string;
  posti: number;
  /** ms epoch. Obbligatoria nel formato, e non per formalità: un gettone senza
   *  scadenza sopravvive alla fine dell'abbonamento e a chi l'ha emesso. */
  scadenza: number;
  adesso: number;
  chiave: KeyObject;
  kid?: string;
}

/**
 * Il gettone: `<carico base64url>.<firma base64url>`.
 *
 * Si firma il SEGMENTO in ascii, non i byte del JSON: è ciò che
 * `verificaGettone` ricostruisce con `Buffer.from(pCarico, "ascii")`. Firmare
 * l'altra cosa dà un gettone che non verifica, e il sintomo — `bad_signature` —
 * sarebbe indistinguibile da una chiave sbagliata.
 */
export function coniaGettone(o: OpzioniConio): string {
  const iid = o.installationId.trim();
  if (!iid) throw new Error("conio: installationId vuoto");
  if (!Number.isInteger(o.posti) || o.posti < POSTI_MIN || o.posti > POSTI_MAX) {
    throw new Error(`conio: posti fuori intervallo (${o.posti})`);
  }
  if (!Number.isFinite(o.scadenza) || o.scadenza <= o.adesso) {
    throw new Error("conio: la scadenza deve essere nel futuro");
  }

  const carico = {
    v: 1 as const,
    iid,
    plan: "team" as const,
    seats: o.posti,
    exp: Math.round(o.scadenza),
    iat: Math.round(o.adesso),
    kid: o.kid ?? KID_DEFAULT,
  };
  const pCarico = Buffer.from(JSON.stringify(carico), "utf8").toString("base64url");
  const firma = sign(null, Buffer.from(pCarico, "ascii"), o.chiave);
  return `${pCarico}.${firma.toString("base64url")}`;
}

export interface ReadLoad {
  iid: string;
  seats: number;
  exp: number;
  kid?: string;
}

/**
 * Legge il carico di un gettone SENZA verificarne la firma.
 *
 * Serve a una domanda sola e onesta: «cosa ho già mandato a quel cliente?».
 * Il servizio di conio la usa per non riconiare un gettone che c'è già — una
 * decisione che, se sbagliata, produce un gettone in più, non un permesso in
 * più. Per «è valido?» esiste `verificaGettone`, e non è questa funzione.
 */
export function leggiCaricoNonVerificato(gettone: string): ReadLoad | null {
  const pezzi = (gettone ?? "").trim().split(".");
  if (pezzi.length !== 2 || !pezzi[0]) return null;
  try {
    const o = JSON.parse(Buffer.from(pezzi[0], "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof o.iid !== "string" || !o.iid) return null;
    if (typeof o.seats !== "number" || !Number.isFinite(o.seats)) return null;
    if (typeof o.exp !== "number" || !Number.isFinite(o.exp)) return null;
    return {
      iid: o.iid,
      seats: o.seats,
      exp: o.exp,
      kid: typeof o.kid === "string" ? o.kid : undefined,
    };
  } catch {
    return null;
  }
}
