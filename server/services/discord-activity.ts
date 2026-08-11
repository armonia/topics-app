/**
 * COSA vedono gli altri: dallo stato vero di Topics alle due righe del profilo.
 *
 * ── È UNA FUNZIONE PURA, E NON PER ELEGANZA ─────────────────────────────────
 * La card Discord in Impostazioni mostra un'ANTEPRIMA di ciò che finisce sul
 * profilo. Se quell'anteprima la disegnasse il client con la sua idea delle
 * stringhe, sarebbe una promessa scritta due volte — e la copia sbagliata
 * sarebbe proprio quella che l'utente guarda per decidere se accendere. Qui c'è
 * una funzione sola: la usa il servizio per pubblicare e la usa la rotta per
 * far vedere l'anteprima, quindi ciò che si vede in Impostazioni È ciò che
 * viene pubblicato, non una sua imitazione.
 *
 * ── I NUMERI SONO ESATTI, E QUESTO È IL PUNTO DEL TASK ──────────────────────
 * Il daemon che questo file sostituisce contava i processi `claude` con `ps` e
 * misurava il delta di CPU per indovinare quali stessero lavorando. Sbagliava
 * da entrambi i lati: contava processi che non erano sessioni di lavoro e non
 * vedeva le chat via API, che non lanciano nessun processo. Topics non deve
 * indovinare: sa quali turni sta trasmettendo adesso e quali task ha in mano.
 *
 * ── OGNI GRADINO DI PRIVACY È UNA FRASE DIVERSA, NON LA STESSA TRONCATA ─────
 * `minimal` non è `detailed` con meno campi: è un'altra frase. Un livello che
 * si ottiene svuotando campi lascia sempre l'ultimo dimenticato — ed è il campo
 * dimenticato che pubblica il nome di un cliente.
 */

import type { DiscordActivity, DiscordDetailLevel, OutputLanguage } from "../../shared/types";
// La forma dell'attività sta in `shared/`: la card in Impostazioni ne disegna
// l'anteprima, quindi i due lati devono leggere la STESSA dichiarazione.
export type { DiscordActivity };

/** Lo stato vero, misurato da chi lo conosce. Tutti i numeri sono conteggi
 *  ESATTI del server, non stime su processi. */
export interface PresenceSnapshot {
  /** Le sessioni aperte: i topic non archiviati di questa installazione. */
  openSessions: number;
  /** Quelle che stanno lavorando ADESSO: turni in streaming + agenti della
   *  board con un task in mano. È la somma di due fatti che il server osserva,
   *  non una soglia su una percentuale di CPU. */
  workingSessions: number;
  /** I task che la board sta eseguendo in questo momento. */
  activeTasks: number;
  /** Il progetto su cui c'è lavoro adesso. Esce di qui SOLO a `detailed`. */
  focusProject: string | null;
  /** Da quando questa installazione è in piedi (ms epoch): diventa il
   *  cronometro che Discord mostra sotto la card. */
  since: number;
}

/** Discord tronca a 128 caratteri; troncare qui significa che l'anteprima
 *  mostra il troncamento invece di prometterne uno che non ci sarà. */
const MAX = 128;

function cut(s: string): string {
  return s.length <= MAX ? s : `${s.slice(0, MAX - 1)}…`;
}

const IT = {
  idle: (n: number) => (n === 1 ? "1 sessione aperta" : `${n} sessioni aperte`),
  working: (w: number, n: number) =>
    `${w} al lavoro · ${n} apert${n === 1 ? "a" : "e"}`,
  tasks: (n: number) => (n === 1 ? "1 task in corso" : `${n} task in corso`),
  onProject: (p: string) => `su ${p}`,
  app: "Topics",
  quiet: "Nessun agente al lavoro",
};

const EN = {
  idle: (n: number) => (n === 1 ? "1 session open" : `${n} sessions open`),
  working: (w: number, n: number) => `${w} working · ${n} open`,
  tasks: (n: number) => (n === 1 ? "1 task running" : `${n} tasks running`),
  onProject: (p: string) => `on ${p}`,
  app: "Topics",
  quiet: "No agent working",
};

/**
 * La lingua delle due righe.
 *
 * `auto` non è una lingua (shared/types.ts): per l'interfaccia significa
 * «segui il browser», ma qui il pubblico non è il browser di nessuno — è
 * chiunque nei tuoi server Discord. In assenza di una scelta si parla inglese,
 * e chi vuole l'italiano lo dice nel selettore della lingua, che governa già
 * l'interfaccia e le risposte del modello.
 */
function dict(lang: OutputLanguage) {
  return lang === "it" ? IT : EN;
}

/**
 * Snapshot + livello → l'attività da pubblicare.
 *
 * `null` significa PULISCI la presence, e succede in un caso solo: nessuna
 * sessione aperta. Uno stato che resta appeso quando hai chiuso tutto non è
 * «l'ultimo stato noto», è una cosa falsa che continua a essere pubblicata.
 */
export function buildActivity(
  snapshot: PresenceSnapshot,
  level: DiscordDetailLevel,
  lang: OutputLanguage = "auto",
  image?: string | null,
): DiscordActivity | null {
  const d = dict(lang);

  if (level !== "minimal" && snapshot.openSessions <= 0 && snapshot.activeTasks <= 0) {
    return null;
  }

  const assets = image
    ? { assets: { large_image: image, large_text: d.app } }
    : {};
  const timestamps = { timestamps: { start: Math.floor(snapshot.since / 1000) } };

  // ── minimal: che Topics è aperto. Niente numeri, niente nomi — e nemmeno
  // il ramo «zero sessioni», perché a questo livello non si dichiara nulla di
  // ciò che sta succedendo, quindi non c'è nulla da nascondere quando è fermo.
  if (level === "minimal") {
    return { details: d.app, ...timestamps, ...assets };
  }

  // ── activity: i conteggi. Numeri, che non nominano nessun cliente.
  const working = snapshot.workingSessions;
  const details = working > 0
    ? d.working(working, snapshot.openSessions)
    : d.idle(snapshot.openSessions);

  const seconda = snapshot.activeTasks > 0
    ? d.tasks(snapshot.activeTasks)
    : working > 0
      ? d.app
      : d.quiet;

  if (level === "activity") {
    return { details: cut(details), state: cut(seconda), ...timestamps, ...assets };
  }

  // ── detailed: anche il nome del progetto. È l'unico gradino che può far
  // uscire di qui una parola che non hai scelto per quel pubblico — quindi il
  // nome sta nella SECONDA riga, dove sostituisce il generico, e se non c'è un
  // progetto in primo piano il livello degrada su `activity` invece di
  // pubblicare «su null».
  const state = snapshot.focusProject
    ? d.onProject(snapshot.focusProject)
    : seconda;

  return { details: cut(details), state: cut(state), ...timestamps, ...assets };
}
