/**
 * IL RIEPILOGO: una frase sola, due superfici.
 *
 * ── PERCHE' STA IN `shared/` E NON DENTRO IL PEZZO DISCORD ──────────────────
 * La stessa fotografia va detta in due posti: sul profilo Discord (che la
 * vedono gli altri) e nella barra di stato in fondo alla colonna (che la vedi
 * tu). Scriverla due volte significa che fra un mese diranno due cose diverse,
 * e quella sbagliata sara' quella che guardi tutto il giorno. Qui c'e' un
 * dizionario solo e una composizione sola: `buildActivity` la usa per
 * pubblicare, la barra la usa per mostrare.
 *
 * ── DOVE LE DUE SUPERFICI SI SEPARANO DAVVERO ───────────────────────────────
 * La privacy. Sul profilo il nome del progetto esce solo al gradino
 * `detailed`, perche' li' il pubblico e' chiunque condivida un server con te.
 * Nella barra il pubblico sei tu, seduto davanti alla macchina: non c'e' nulla
 * da nascondere e la riga porta tutto. E' una scelta di destinatario, non due
 * frasi diverse: le PAROLE restano queste.
 *
 * ── I NUMERI NON SI FORMATTANO QUI, SI RICEVONO ─────────────────────────────
 * Chi conta e' il server (`computePresenceCounts`), che sa quali turni sta
 * trasmettendo e quali task ha in mano la board. Questo file non stima niente:
 * riceve i conteggi e li dice.
 */

import type { OutputLanguage } from "./types";

/** Lo stato ADESSO, in numeri esatti. Lo produce il server. */
export interface PresenceCounts {
  /**
   * Le chat aperte: i topic non archiviati di questa installazione.
   *
   * Si chiamavano «sessioni» nella frase e «chat» in tutto il resto
   * dell'interfaccia — due parole per la stessa cosa, e quella sbagliata era
   * proprio in vetrina. Peggio: «sessione» e' anche il nome dei PROCESSI che
   * la status bar conta altrove, quindi lo stesso termine indicava sia i
   * contenitori sia chi ci lavora dentro.
   */
  openSessions: number;
  /** Quelle che stanno lavorando ADESSO. */
  workingSessions: number;
  /** I task che la board sta eseguendo in questo momento. */
  activeTasks: number;
  /** Il progetto su cui c'e' lavoro adesso. */
  focusProject: string | null;
  /**
   * Le sessioni Claude aperte FUORI da Topics: un terminale, un altro harness.
   * NON si sommano a `openSessions` — quello conta topic, cioe' contenitori, e
   * questo conta processi vivi. Un totale unico non sarebbe ne' l'uno ne'
   * l'altro, per questo la frase le nomina a parte.
   *
   * Opzionale: un chiamante che non le conosce non deve inventare uno zero
   * che sembra una misura.
   */
  externalSessions?: number;
}

/** Le due righe della card, nell'ordine in cui Discord le impagina. */
export interface PresenceLines {
  /** La riga in alto: chi lavora, su quante sessioni aperte. */
  details: string;
  /** La riga sotto: i task in corso, o il silenzio dichiarato. */
  state: string;
}

/** Il nome dell'applicazione, che e' anche cio' che si dice quando non si
 *  vuole dire altro (gradino `minimal`). */
export const PRESENCE_APP_NAME = "Topics";

const IT = {
  idle: (n: number) => (n === 1 ? "1 chat aperta" : `${n} chat aperte`),
  working: (w: number, n: number) => `${w} al lavoro · ${n} chat apert${n === 1 ? "a" : "e"}`,
  tasks: (n: number) => (n === 1 ? "1 task in corso" : `${n} task in corso`),
  onProject: (p: string) => `su ${p}`,
  external: (n: number) => (n === 1 ? "1 fuori da Topics" : `${n} fuori da Topics`),
  app: PRESENCE_APP_NAME,
  quiet: "Nessun agente al lavoro",
};

const EN = {
  idle: (n: number) => (n === 1 ? "1 chat open" : `${n} chats open`),
  working: (w: number, n: number) => `${w} working · ${n} chats open`,
  tasks: (n: number) => (n === 1 ? "1 task running" : `${n} tasks running`),
  onProject: (p: string) => `on ${p}`,
  external: (n: number) => (n === 1 ? "1 outside Topics" : `${n} outside Topics`),
  app: PRESENCE_APP_NAME,
  quiet: "No agent working",
};

/**
 * La lingua delle frasi.
 *
 * `auto` non e' una lingua (shared/types.ts): sul profilo il pubblico non e' il
 * browser di nessuno, quindi in assenza di una scelta si parla inglese. La
 * barra passa la lingua GIA' risolta dell'interfaccia, quindi questo ramo non
 * la riguarda.
 */
function dict(lang: OutputLanguage) {
  return lang === "it" ? IT : EN;
}

/** Il nome del progetto, detto. Fuori dalla composizione perche' il gradino
 *  `detailed` lo mette al posto della seconda riga, non in fondo. */
export function presenceProjectPhrase(project: string, lang: OutputLanguage = "auto"): string {
  return dict(lang).onProject(project);
}

/**
 * I conteggi, in due righe.
 *
 * La prima non dice mai «0 al lavoro»: a fermo la notizia e' quante sessioni
 * hai aperte. La seconda porta i task, e quando non ce ne sono dichiara il
 * silenzio invece di lasciare la riga vuota.
 */
export function presenceLines(counts: PresenceCounts, lang: OutputLanguage = "auto"): PresenceLines {
  const d = dict(lang);
  const working = counts.workingSessions;
  return {
    // Le sessioni fuori da Topics vanno DOPO, separate: sono un'altra unita' di
    // misura e sommarle darebbe un numero che non risponde a nessuna domanda.
    details: [
      working > 0 ? d.working(working, counts.openSessions) : d.idle(counts.openSessions),
      counts.externalSessions ? d.external(counts.externalSessions) : "",
    ].filter(Boolean).join(" · "),
    state:
      counts.activeTasks > 0
        ? d.tasks(counts.activeTasks)
        : working > 0
          ? d.app
          : d.quiet,
  };
}

/**
 * Lo stesso riepilogo su UNA riga, per la barra di stato.
 *
 * Non e' una terza frase: sono i pezzi di `presenceLines` piu' il progetto,
 * uniti dallo stesso separatore che gia' divide «al lavoro» da «aperte». Il
 * ramo `Topics` della seconda riga qui cade: sul profilo serve a non lasciare
 * la card mezza vuota, in una barra sarebbe una parola che non aggiunge niente
 * accanto al nome della finestra.
 *
 * `null` significa che non c'e' niente da dire, ed e' lo stesso caso in cui la
 * presence si PULISCE: nessuna sessione aperta e nessun task. Una riga che
 * annuncia «0 sessioni» sta occupando spazio per dire che non sta succedendo
 * niente.
 */
export function presenceSummary(counts: PresenceCounts, lang: OutputLanguage = "auto"): string | null {
  if (counts.openSessions <= 0 && counts.activeTasks <= 0) return null;
  const { details, state } = presenceLines(counts, lang);
  const pezzi = [details];
  if (state !== PRESENCE_APP_NAME) pezzi.push(state);
  if (counts.focusProject) pezzi.push(presenceProjectPhrase(counts.focusProject, lang));
  return pezzi.join(" · ");
}
