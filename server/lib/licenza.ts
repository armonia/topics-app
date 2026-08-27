/**
 * COSA È CONCESSO su questa installazione, e chi lo decide.
 *
 * ── IL SOGGETTO È L'INSTALLAZIONE, NON L'ACCOUNT ────────────────────────────
 * La licenza sta sull'INSTALLAZIONE e porta un numero di POSTI. Il soggetto è
 * `installationId` (`server/services/relay-config.ts`): un file su disco, che
 * sopravvive a un ripristino del database da un backup. Non è la persona, non è
 * l'organizzazione, non è il dispositivo — perché tutti e tre cambiano, si
 * revocano e si sincronizzano da fuori, mentre la macchina che hai davanti è
 * l'unica cosa che resta la stessa.
 *
 * ── SI VERIFICA OFFLINE, E QUESTO NON È UN DETTAGLIO ────────────────────────
 * Il gettone è FIRMATO (Ed25519) e si controlla con la sola chiave pubblica:
 * nessuna chiamata, nessun servizio da raggiungere, nessun momento in cui il
 * fatto che un server sia giù cambia ciò che la tua macchina ti lascia fare. È
 * la condizione che rende VERA la frase «il locale non degrada mai»: se la
 * verifica richiedesse una risposta da fuori, ogni disservizio diventerebbe un
 * declassamento, e il declassamento arriverebbe da un canale che il
 * proprietario non controlla (ORG-08, ORG-02).
 *
 * ── IL CANCELLO CADE SEMPRE VERSO IL LOCALE ─────────────────────────────────
 * Gettone assente, illeggibile, firmato male, per un'altra installazione o
 * scaduto: la risposta è **piano gratuito pieno**, mai una macchina bloccata.
 * Non esiste un ramo di questo file che produca «non puoi usare il tuo
 * computer»: `uso_locale` e `accesso_rete_locale` rispondono `ok` su QUALUNQUE
 * entitlement, compreso quello nato da un gettone marcio — ed è fissato da un
 * test, perché è esattamente il genere di invariante che si perde aggiungendo
 * una riga in buona fede.
 *
 * Per lo stesso motivo i POSTI governano UN gesto solo: aggiungere qualcuno al
 * gruppo. Non esiste, e non deve esistere, una funzione che a posti esauriti
 * dica «togli questo membro» o «questo non entra più»: un conteggio che può
 * espellere è un conteggio che un giorno espelle il proprietario dalla propria
 * macchina, e lo fa mentre il servizio di fatturazione ha un problema.
 *
 * ── COSA SI PAGA ────────────────────────────────────────────────────────────
 * Gratis: tutto il locale, per sempre, senza account — compresa la rete di
 * casa. A pagamento: la raggiungibilità da FUORI rete (il relay) e N persone
 * nel gruppo. Il confine è quello di ORG-08: si paga ciò che ha bisogno di
 * un'autorità fuori dalla macchina, e nient'altro.
 *
 * ── I VALORI SONO IL PROTOCOLLO ─────────────────────────────────────────────
 * Le stringhe di `motivo` e `codice` sono in inglese perché sono ciò che esce
 * dalla rotta: un vocabolario solo, dal modulo al filo all'interfaccia, invece
 * di una tabella di traduzione che è il posto dove due risposte alla stessa
 * domanda cominciano a divergere.
 */
import { createPublicKey, verify as verificaFirmaEd25519, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Il vocabolario
// ─────────────────────────────────────────────────────────────────────────────

export type Piano = "free" | "team";

/**
 * PERCHÉ si è sul piano che si è. Sette esiti e non «valido / non valido»,
 * perché «non ho una chiave con cui controllare» e «la firma è falsa» sono due
 * cose diversissime da dire a chi ha appena pagato, e distinguerle è ciò che
 * evita che un problema di distribuzione somigli a una truffa.
 *
 * La dichiarazione vive in `shared/`: la legge anche il client, che a ognuno di
 * questi sette appende la frase che una persona leggerà. Era scritta due volte,
 * una per lato, e due elenchi di sette voci sono due elenchi che un giorno ne
 * hanno otto e sette.
 */
export type { MotivoLicenza } from "../../shared/licenza-motivi";
import type { MotivoLicenza } from "../../shared/licenza-motivi";

export interface Entitlement {
  piano: Piano;
  /** Quante persone possono stare nel gruppo, TE compreso. Gratis = 1. */
  posti: number;
  /** Raggiungibilità da FUORI rete. Il locale e la LAN non passano di qui. */
  accessoRemoto: boolean;
  /** ms epoch. `null` sul piano gratuito: quello non scade mai, per definizione. */
  scadeIl: number | null;
  motivo: MotivoLicenza;
  /** L'installazione a cui QUESTA risposta si riferisce. */
  installationId: string;
}

/** Un posto solo: sei tu. Non zero — zero posti vorrebbe dire una macchina
 *  senza nessuno dentro, e quello non è un piano, è un guasto. */
export const POSTI_GRATUITI = 1;

/** Tetto di sanità sui posti dichiarati da un gettone. Un numero fuori scala
 *  non è una licenza generosa: è un carico che non abbiamo emesso noi. */
export const POSTI_MAX = 10_000;

/**
 * Il piano gratuito, che è anche il RIPIEGO di ogni singolo ramo di errore.
 * Costruirlo qui e non a mano nei punti di uscita è ciò che garantisce che
 * «cade verso il locale» sia una proprietà del codice e non una promessa: c'è
 * un solo modo di fallire, e produce una macchina pienamente usabile.
 */
export function pianoGratuito(installationId: string, motivo: MotivoLicenza): Entitlement {
  return {
    piano: "free",
    posti: POSTI_GRATUITI,
    accessoRemoto: false,
    scadeIl: null,
    motivo,
    installationId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LA PORTA UNICA: «questo gesto è concesso?»
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I gesti su cui la licenza ha voce. L'elenco è chiuso di proposito: chi ne
 * aggiunge uno lo aggiunge QUI, e il compilatore gli chiede cosa risponde —
 * invece di scrivere `if (piano === "free")` in una rotta, che è il modo in cui
 * due punti del programma cominciano a rispondere diversamente alla stessa
 * domanda.
 */
export type Richiesta =
  /** Usare l'applicazione sulla macchina. Non è negoziabile e non lo diventerà. */
  | { tipo: "uso_locale" }
  /** Il telefono sulla stessa rete di casa. Gratis per sempre (ORG-08). */
  | { tipo: "accesso_rete_locale" }
  /** Essere trovati da un'ALTRA rete: il relay. Questo si paga. */
  | { tipo: "accesso_remoto" }
  /** Far entrare una persona in più nel gruppo. È qui che i posti contano. */
  | { tipo: "aggiungi_persona_al_gruppo"; membriVivi: number };

export type Esito =
  | { ok: true }
  | { ok: false; codice: "plan_required" }
  | { ok: false; codice: "no_seats_left"; posti: number; membri: number };

/**
 * L'unica funzione che risponde «è concesso?».
 *
 * Nessun messaggio in prosa nell'esito: solo un codice. Il testo che l'utente
 * legge lo scrive l'interfaccia, nella sua lingua — un modulo di server che
 * spedisce frasi finisce per essere l'unico posto dove quelle frasi esistono, e
 * poi non si traducono più.
 */
export function consentito(e: Entitlement, r: Richiesta): Esito {
  switch (r.tipo) {
    // ── I DUE RAMI CHE NON POSSONO DIRE DI NO ────────────────────────────────
    // Valgono su QUALUNQUE entitlement, compreso quello nato da un gettone
    // scaduto o illeggibile. Se un giorno qui comparisse una condizione, la
    // macchina di qualcuno smetterebbe di essere sua per via di una riga in un
    // pannello altrui.
    case "uso_locale":
    case "accesso_rete_locale":
      return { ok: true };

    case "accesso_remoto":
      return e.accessoRemoto ? { ok: true } : { ok: false, codice: "plan_required" };

    case "aggiungi_persona_al_gruppo": {
      // Il conteggio governa l'INGRESSO e nient'altro. Non esiste un esito che
      // faccia uscire qualcuno già dentro: un gruppo che ha sforato (licenza
      // scaduta con cinque persone già presenti) resta un gruppo di cinque
      // persone, e nessuna di loro perde la propria macchina.
      const membri = Math.max(0, Math.floor(r.membriVivi));
      if (membri >= e.posti) return { ok: false, codice: "no_seats_left", posti: e.posti, membri };
      return { ok: true };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le chiavi con cui si controlla la firma
// ─────────────────────────────────────────────────────────────────────────────

export interface PublicKey {
  /** Identificativo della chiave: permette di ruotarla senza invalidare i
   *  gettoni già emessi con la precedente. */
  kid: string;
  chiave: KeyObject;
}

/** Il prefisso SPKI di una chiave pubblica Ed25519. I 32 byte grezzi da soli
 *  non sono un formato che `node:crypto` accetti; anteporre questo li rende
 *  una chiave DER valida, e ci risparmia di far girare PEM nelle variabili
 *  d'ambiente. */
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Le chiavi INTEGRATE nel binario.
 *
 * Una chiave pubblica in chiaro nel sorgente è ciò che deve essere: pubblica.
 * La privata corrispondente non tocca questo repository, in nessuna forma, mai
 * — vive fuori, e dove vive lo dice `docs/licenze-rilascio.md`.
 *
 * **Questa lista vuota è un'app che non vende.** Senza chiavi `verificaGettone`
 * risponde `no_verification_key` prima ancora di guardare la firma, e ogni
 * installazione spedita resta sul piano gratuito qualunque gettone le si dia.
 * Sbagliare in quel verso è giusto — non si crede a ciò che non si può
 * controllare — ma è un verso in cui non si spedisce.
 *
 * Il `kid` davanti ai due punti nomina la chiave. Serve a ruotarla senza
 * invalidare i gettoni già emessi: si AGGIUNGE la nuova in coda e si toglie la
 * vecchia quando l'ultimo gettone che ha firmato è scaduto. Chi verifica prova
 * comunque tutte le chiavi, quindi il nome non decide niente — dice solo quale
 * ha firmato.
 */
export const CHIAVI_INTEGRATE: readonly string[] = [
  "armonia-1:XWT2wKbBJFU4oscPKowJuH_sRq6DbTpGh4pCW3c8D-M",
];

/**
 * Legge le chiavi da una variabile d'ambiente, formato `kid:base64` separati da
 * virgola (il `kid:` si può omettere e allora è la chiave senza nome). Serve
 * alle prove e agli ambienti di collaudo, che hanno una chiave diversa da
 * quella di produzione.
 *
 * Ciò che non si riesce a interpretare si SALTA in silenzio invece di far
 * fallire tutto: una riga storta in una variabile d'ambiente non deve poter
 * spegnere la verifica delle chiavi buone che le stanno accanto.
 */
export function caricaChiavi(
  env: Record<string, string | undefined>,
  integrate: readonly string[] = CHIAVI_INTEGRATE,
): PublicKey[] {
  const grezze = [...integrate, ...(env.TOPICS_LICENSE_PUBKEYS ?? "").split(",")];
  const out: PublicKey[] = [];
  for (const riga of grezze) {
    const v = riga.trim();
    if (!v) continue;
    const i = v.indexOf(":");
    const kid = i >= 0 ? v.slice(0, i).trim() : "";
    const b64 = (i >= 0 ? v.slice(i + 1) : v).trim();
    const chiave = buildKey(b64);
    if (chiave) out.push({ kid, chiave });
  }
  return out;
}

function buildKey(b64: string): KeyObject | null {
  try {
    const raw = Buffer.from(b64, "base64");
    if (raw.length !== 32) return null;
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Il gettone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il carico utile, per come lo emette il servizio.
 *
 * `iid` lega il gettone a UNA macchina: copiarlo su un'altra non la abilita, e
 * il motivo che ne esce (`other_installation`) lo dice invece di limitarsi a
 * rifiutare.
 */
export interface CaricoGettone {
  v: 1;
  iid: string;
  plan: "team";
  seats: number;
  /** ms epoch. Obbligatorio: un gettone senza scadenza è un gettone che
   *  sopravvive alla fine dell'abbonamento e a chi l'ha emesso. */
  exp: number;
  iat?: number;
  kid?: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeSegment(s: string): Buffer | null {
  // `Buffer.from` è indulgente e accetta anche caratteri fuori alfabeto
  // ignorandoli: senza questo controllo due gettoni diversi si decodificano
  // uguali, ed è la strada per cui una firma vale su un carico che non è
  // quello firmato.
  if (!B64URL.test(s)) return null;
  try {
    return Buffer.from(s, "base64url");
  } catch {
    return null;
  }
}

/** Un carico è valido solo se ogni campo obbligatorio c'è ED è del tipo giusto.
 *  Un `seats` stringa o un `exp` mancante non si «interpretano»: si rifiutano. */
function leggiCarico(b: Buffer): CaricoGettone | null {
  let o: unknown;
  try {
    o = JSON.parse(b.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.iid !== "string" || !r.iid) return null;
  if (r.plan !== "team") return null;
  if (typeof r.seats !== "number" || !Number.isFinite(r.seats)) return null;
  if (typeof r.exp !== "number" || !Number.isFinite(r.exp)) return null;
  return {
    v: 1,
    iid: r.iid,
    plan: "team",
    seats: r.seats,
    exp: r.exp,
    iat: typeof r.iat === "number" ? r.iat : undefined,
    kid: typeof r.kid === "string" ? r.kid : undefined,
  };
}

export interface OptionsVerify {
  chiavi: PublicKey[];
  installationId: string;
  ora: number;
}

/**
 * Il passo che dipende SOLO dalla crittografia e dall'identità della macchina,
 * separato da quello che dipende dall'ora. È la separazione che permette al
 * servizio di firmare una volta e rivalutare la scadenza a ogni richiesta senza
 * ripagare la verifica — e che tiene una sola copia delle regole, invece di due
 * che col tempo si allontanano.
 */
function verifyLoad(
  gettone: string,
  o: { chiavi: PublicKey[]; installationId: string },
): { carico: CaricoGettone } | { motivo: MotivoLicenza } {
  const g = gettone.trim();
  if (!g) return { motivo: "no_token" };

  const pezzi = g.split(".");
  if (pezzi.length !== 2) return { motivo: "malformed" };
  const [pCarico, pFirma] = pezzi as [string, string];

  const bytesLoad = decodeSegment(pCarico);
  const firma = decodeSegment(pFirma);
  if (!bytesLoad || !firma || firma.length !== 64) return { motivo: "malformed" };
  const carico = leggiCarico(bytesLoad);
  if (!carico) return { motivo: "malformed" };

  // Senza chiavi non si crede a niente — e lo si DICE, invece di far passare
  // per falso un gettone che semplicemente non abbiamo modo di controllare.
  if (o.chiavi.length === 0) return { motivo: "no_verification_key" };

  const firmato = Buffer.from(pCarico, "ascii");
  // Il `kid` restringe, non decide: se non corrisponde a nessuna chiave nota si
  // provano comunque tutte, così un gettone emesso con un nome di chiave
  // diverso da quello atteso non viene rifiutato per un'etichetta.
  const candidate = carico.kid
    ? [...o.chiavi.filter((k) => k.kid === carico.kid), ...o.chiavi.filter((k) => k.kid !== carico.kid)]
    : o.chiavi;
  let buona = false;
  for (const k of candidate) {
    try {
      if (verificaFirmaEd25519(null, firmato, k.chiave, firma)) { buona = true; break; }
    } catch { /* una chiave storta non deve invalidare le altre */ }
  }
  if (!buona) return { motivo: "bad_signature" };

  // La firma è buona: da qui in poi il carico è AUTENTICO, e resta la domanda
  // su cui una firma non ha voce — è per QUESTA macchina?
  if (carico.iid !== o.installationId) return { motivo: "other_installation" };
  return { carico };
}

/** Dal carico autentico all'entitlement, valutando la scadenza contro l'ora. */
function fromLoad(carico: CaricoGettone, installationId: string, ora: number): Entitlement {
  if (carico.exp <= ora) return pianoGratuito(installationId, "expired");
  return {
    piano: "team",
    posti: Math.min(POSTI_MAX, Math.max(POSTI_GRATUITI, Math.floor(carico.seats))),
    accessoRemoto: true,
    scadeIl: carico.exp,
    motivo: "valid",
    installationId,
  };
}

/**
 * Da un gettone a un entitlement. **Non solleva mai**: ogni strada che non
 * arriva a una firma buona finisce sul piano gratuito con un motivo diverso.
 *
 * La firma copre i BYTE ASCII del segmento del carico, non l'oggetto
 * ri-serializzato: due JSON con le stesse chiavi in ordine diverso sono due
 * stringhe diverse, e firmare l'oggetto invece del testo è il modo classico di
 * ritrovarsi con una firma che vale su un carico che nessuno ha firmato.
 */
export function verificaGettone(gettone: string, o: OptionsVerify): Entitlement {
  const r = verifyLoad(gettone, o);
  if ("motivo" in r) return pianoGratuito(o.installationId, r.motivo);
  return fromLoad(r.carico, o.installationId, o.ora);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dove vive il gettone, e il servizio che lo tiene in mano
// ─────────────────────────────────────────────────────────────────────────────

/** Un file accanto a `installation-id`, e per lo stesso motivo: deve
 *  sopravvivere a un ripristino del database da un backup. */
export function percorsoGettone(stateDir: string): string {
  return join(stateDir, "license-token");
}

/** Il gettone grezzo: prima la variabile d'ambiente (collaudo, contenitori),
 *  poi il file. `null` se non c'è — che non è un errore, è il caso normale. */
export function leggiGettoneGrezzo(
  env: Record<string, string | undefined>,
  stateDir: string,
): string | null {
  const daEnv = (env.TOPICS_LICENSE_TOKEN ?? "").trim();
  if (daEnv) return daEnv;
  try {
    const f = percorsoGettone(stateDir);
    if (!existsSync(f)) return null;
    const v = readFileSync(f, "utf8").trim();
    return v || null;
  } catch {
    // Un file illeggibile è un gettone assente: il piano gratuito, non un
    // errore che risale fino a impedire l'avvio.
    return null;
  }
}

export interface ServizioLicenza {
  /** Cosa è concesso ADESSO. Rilegge il file solo se è cambiato sul disco. */
  stato(ora?: number): Entitlement;
  /** Installa un gettone, ma solo se è VALIDO su questa macchina. Torna
   *  l'entitlement che ne risulta — o quello di rifiuto, col motivo. */
  installa(gettone: string, ora?: number): Entitlement;
  /** Torna al piano gratuito cancellando il gettone dal disco. */
  rimuovi(): Entitlement;
}

export interface OpzioniServizio {
  stateDir: string;
  env: Record<string, string | undefined>;
  installationId: string;
  ora?: () => number;
}

/**
 * Il servizio, con una cache che non può mentire.
 *
 * La cache è sul CONTENUTO del gettone, non su un tempo: si ricontrolla la
 * firma solo quando il gettone cambia davvero, e il confronto è la stringa
 * stessa — un `mtime` mentirebbe due volte, sulla variabile d'ambiente (che non
 * ne ha uno) e su due scritture nello stesso millisecondo.
 *
 * La scadenza invece si rivaluta a ogni chiamata contro l'ora corrente: così un
 * gettone che scade mentre il server è su smette di valere senza che nessuno
 * debba riavviare niente, e senza pagare una verifica crittografica per ogni
 * richiesta HTTP.
 */
export function creaServizioLicenza(o: OpzioniServizio): ServizioLicenza {
  const orologio = o.ora ?? (() => Date.now());
  const chiavi = caricaChiavi(o.env);
  let rawCache: string | null = null;
  /** Il carico VERIFICATO, o `null` con il motivo del rifiuto. */
  let loadCache: CaricoGettone | null = null;
  let reasonCache: MotivoLicenza = "no_token";
  let primaVolta = true;
  /**
   * Il gettone VALIDO che non si è potuto scrivere sul disco, e che quindi vale
   * finché questo processo vive. Sta SOTTO al disco e sotto alla variabile
   * d'ambiente — un gettone che poi arriva davvero lo scavalca — ed esiste per
   * una ragione sola: senza, `stato()` rileggerebbe una cartella dove il file
   * non c'è e risponderebbe `no_token`, cioè negherebbe un acquisto già andato
   * a buon fine perché una directory non era scrivibile.
   */
  let soloInMemoria: string | null = null;

  function aggiorna(): void {
    const grezzo = leggiGettoneGrezzo(o.env, o.stateDir) ?? soloInMemoria;
    if (!primaVolta && grezzo === rawCache) return;
    primaVolta = false;
    rawCache = grezzo;
    if (!grezzo) { loadCache = null; reasonCache = "no_token"; return; }
    const r = verifyLoad(grezzo, { chiavi, installationId: o.installationId });
    if ("motivo" in r) { loadCache = null; reasonCache = r.motivo; return; }
    loadCache = r.carico;
    reasonCache = "valid";
  }

  function stato(ora = orologio()): Entitlement {
    aggiorna();
    if (!loadCache) return pianoGratuito(o.installationId, reasonCache);
    return fromLoad(loadCache, o.installationId, ora);
  }

  return {
    stato,
    installa(gettone, ora = orologio()) {
      const g = gettone.trim();
      // Si verifica una volta sola e si tiene il CARICO, non solo l'esito: è
      // ciò che permette, se il disco rifiuta, di rispondere con la licenza
      // appena verificata invece di andarla a ricercare dove non è stata
      // scritta.
      const r = verifyLoad(g, { chiavi, installationId: o.installationId });
      if ("motivo" in r) return pianoGratuito(o.installationId, r.motivo);
      const e = fromLoad(r.carico, o.installationId, ora);
      // Un gettone che non regge non si scrive sul disco: conservarlo darebbe
      // all'interfaccia una licenza «in attesa» che non diventerà mai valida, e
      // la macchina somiglierebbe a una che ha pagato e non funziona.
      if (e.motivo !== "valid") return e;
      const f = percorsoGettone(o.stateDir);
      try {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, g + "\n", { mode: 0o600 });
        // Il `mode` di `writeFileSync` vale solo alla CREAZIONE: su un file che
        // c'era già — il gettone precedente, o un file lasciato lì a 0644 — non
        // tocca i permessi. Senza questa riga «leggibile solo dal proprietario»
        // sarebbe vero al primo acquisto e falso a ogni rinnovo.
        chmodSync(f, 0o600);
      } catch {
        // Il disco non ha accettato la scrittura: la licenza vale per QUESTA
        // esecuzione e basta. Si SEMINA la cache col carico appena verificato
        // invece di rileggere il disco — rileggerlo direbbe `no_token`, cioè un
        // rifiuto su un acquisto già andato a buon fine, ed è esattamente il
        // verso in cui questo modulo non deve mai sbagliare.
        soloInMemoria = g;
        rawCache = g;
        loadCache = r.carico;
        reasonCache = "valid";
        primaVolta = false;
        return e;
      }
      soloInMemoria = null;
      primaVolta = true;
      return stato(ora);
    },
    rimuovi() {
      try {
        unlinkSync(percorsoGettone(o.stateDir));
      } catch { /* non c'era: l'esito voluto è già quello */ }
      // Anche la copia in memoria se ne va, o togliere la licenza da una
      // cartella non scrivibile non toglierebbe niente.
      soloInMemoria = null;
      primaVolta = true;
      rawCache = null;
      loadCache = null;
      return stato();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// L'interruttore: una cosa che si accende quando la licenza la concede
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L'indirizzo del relay COME LO VEDE il resto del programma.
 *
 * Senza licenza torna `null`, che non è uno stato nuovo: è esattamente
 * «relay non configurato», lo stato che l'app gestisce da sempre e in cui il
 * gesto «condividi fuori rete» semplicemente non si offre. Nessun errore,
 * nessuna schermata di blocco, nessun percorso in cui la macchina sembri rotta.
 *
 * Sta qui e non in una rotta perché i lettori sono due — `/api/auth/relay`, che
 * dice se il gesto esiste, e la POST che conia i link — e due copie di questo
 * `if` sono il modo in cui un interruttore finisce per nascondere un gesto
 * senza toglierlo: l'interfaccia lo spegne, la rotta continua a produrre link
 * validi, e nessuno se ne accorge finché uno di quei link non arriva a
 * qualcuno.
 */
export function baseUrlConcesso(baseUrl: string | null, e: Entitlement): string | null {
  return consentito(e, { tipo: "accesso_remoto" }).ok ? baseUrl : null;
}

export interface Interruttore {
  /** Allinea l'acceso/spento a ciò che la licenza concede ADESSO. */
  riconcilia(): void;
  acceso(): boolean;
}

/**
 * Accende e spegne UNA cosa (oggi: il relay) seguendo la licenza.
 *
 * Agisce sulle TRANSIZIONI e non sullo stato. Sembra un dettaglio ed è il bug:
 * `avvia()` sul client del relay apre una socket ogni volta che lo si chiama,
 * quindi un giro periodico che «si assicura» che sia acceso ne aprirebbe una al
 * minuto, per sempre, senza che niente sembri rotto.
 *
 * Il giro periodico serve alle due cose che accadono senza che nessuno chiami
 * niente: una licenza installata mentre il server è su, e una che scade.
 *
 * `disponibile: false` (il relay non è nemmeno configurato) tiene tutto spento
 * senza mai interrogare la licenza: una macchina che non ha scelto di uscire su
 * Internet non deve nemmeno avere un'opinione sul proprio piano.
 */
export function creaInterruttoreLicenza(o: {
  disponibile: () => boolean;
  stato: () => Entitlement;
  richiesta: Richiesta;
  avvia: () => void;
  ferma: () => void;
}): Interruttore {
  let acceso = false;
  return {
    acceso: () => acceso,
    riconcilia() {
      const vuole = o.disponibile() && consentito(o.stato(), o.richiesta).ok;
      if (vuole === acceso) return;
      acceso = vuole;
      if (vuole) o.avvia();
      else o.ferma();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// La forma sul filo
// ─────────────────────────────────────────────────────────────────────────────

export interface EntitlementSulFilo {
  plan: Piano;
  seats: number;
  remoteAccess: boolean;
  expiresAt: number | null;
  reason: MotivoLicenza;
  installationId: string;
}

/** UNA sola conversione, così le rotte che parlano di licenza non possono
 *  descrivere lo stesso entitlement in due modi diversi. */
export function sulFilo(e: Entitlement): EntitlementSulFilo {
  return {
    plan: e.piano,
    seats: e.posti,
    remoteAccess: e.accessoRemoto,
    expiresAt: e.scadeIl,
    reason: e.motivo,
    installationId: e.installationId,
  };
}
