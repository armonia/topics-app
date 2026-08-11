/**
 * Le etichette dei task — poche, chiuse, e con una CONSEGUENZA.
 *
 * Il motivo per cui esistono non è la tassonomia: è che l'11/08/2026 la coda di
 * review della board contava 29 card, e 10 di quelle non toccavano una riga che
 * un umano potesse VEDERE (server, script, test, doc). Restavano lì solo perché
 * mancava la regola che dicesse chi le chiude — smistate a mano, card per card,
 * guardando il diff. Questa è quella regola, scritta una volta sola.
 *
 * Due famiglie, e fanno cose diverse:
 *
 *  · `visibile` / `invisibile` — **decidono CHI CHIUDE la card**. È l'unica
 *    coppia che sposta lavoro, ed è per questo che non la dichiara chi lavora:
 *    si DERIVA dal diff (`deriveVisibility`). Un'etichetta che l'agente potesse
 *    scriversi da sé sarebbe l'autorizzazione a chiudersi le proprie card.
 *  · `bugfix` `feature` `chore` `misura` — servono a FILTRARE e a leggere la
 *    board. Non decidono niente, quindi le scrive chi vuole.
 *
 * Aree e componenti NON stanno qui apposta: un'etichetta che nessuno filtra è
 * rumore, e si aggiunge quando qualcuno la filtra davvero.
 */

/**
 * Chi chiude la card. Derivate dal diff, mai dichiarate dall'agente
 * (`isAgentWritableLabel`).
 */
export const VISIBILITY_LABELS = ['visibile', 'invisibile'] as const;

/** Che genere di lavoro è. Servono a filtrare, non a decidere. */
export const KIND_LABELS = ['bugfix', 'feature', 'chore', 'misura'] as const;

/** L'insieme CHIUSO. Un'etichetta fuori da qui non si scrive (il layer route la rifiuta). */
export const TASK_LABELS = [...VISIBILITY_LABELS, ...KIND_LABELS] as const;

export type VisibilityLabel = (typeof VISIBILITY_LABELS)[number];
export type TaskLabel = (typeof TASK_LABELS)[number];

const LABEL_SET: ReadonlySet<string> = new Set<string>(TASK_LABELS);
const VISIBILITY_SET: ReadonlySet<string> = new Set<string>(VISIBILITY_LABELS);

export function isTaskLabel(value: unknown): value is TaskLabel {
  return typeof value === 'string' && LABEL_SET.has(value);
}

export function isVisibilityLabel(value: unknown): value is VisibilityLabel {
  return typeof value === 'string' && VISIBILITY_SET.has(value);
}

/**
 * Chi ha messo l'etichetta, e quindi chi può toglierla.
 *
 *  · `derived` — l'ha calcolata la macchina dal diff alla consegna. Un giro
 *    successivo la può riscrivere: è una misura, non un'opinione.
 *  · `human`   — l'ha corretta Attilio. La derivazione NON la tocca più, o la
 *    correzione a mano durerebbe fino alla prossima consegna.
 *  · `agent`   — l'ha chiesta l'agente. Vale solo per ciò che un agente può
 *    scrivere (vedi `isAgentWritableLabel`): alzare la mano, mai abbassarla.
 */
export const LABEL_SOURCES = ['derived', 'human', 'agent'] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

export interface TaskLabelRow {
  label: TaskLabel;
  source: LabelSource;
}

/**
 * Che cosa può scriversi da solo un agente.
 *
 * Le etichette di genere sì: nessuna di loro cambia chi chiude la card. La
 * visibilità no, con UNA asimmetria voluta — `visibile` è alzare la mano
 * («guardala tu»), e alzare la mano è sempre permesso; `invisibile` è togliersi
 * la revisione umana di dosso, e non è una cosa che si concede a chi ha scritto
 * il codice. Quella la scrive solo la derivazione, o Attilio a mano.
 */
export function isAgentWritableLabel(label: string): boolean {
  return label === 'visibile' || (isTaskLabel(label) && !isVisibilityLabel(label));
}

/**
 * Un file che un umano può VEDERE aprendo l'app: sorgente del client, escluso
 * ciò che gira solo nei test.
 *
 * `client/src/**` e non `client/**`: la config di Vite, `index.html` e i lock
 * non hanno una superficie: cambiarli non dà a nessuno niente da guardare.
 * I `*.test.*` / `*.spec.*` sotto `client/src` sono codice di prova — vivono
 * accanto al componente, ma nessuno li vede girare.
 */
export function isUserVisibleFile(path: string): boolean {
  const p = path.replace(/^\.\//, '');
  if (!p.startsWith('client/src/')) return false;
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/**
 * La regola, ed è misurabile: **tocca `client/src/**` fuori dai test ⇒
 * `visibile`; altrimenti `invisibile`**.
 *
 * L'eccezione che vale quanto la regola: **una lista VUOTA è `visibile`.** Una
 * card senza codice — un piano, una decisione, una ricerca, un acquisto — non è
 * invisibile: è la più umana di tutte, e trattarla come invisibile per assenza
 * di file toccati sarebbe il modo più veloce per far chiudere alla macchina
 * proprio le card che solo un umano può giudicare. L'assenza di diff non è una
 * prova di irrilevanza: è assenza di prova.
 *
 * `files` sono i file dei commit PROPRI del task (`server/services/own-commits.ts`),
 * non tutto ciò che sta fra `main` e la punta del ramo: un ramo nato dall'HEAD di
 * un checkout condiviso eredita il lavoro di chi ci stava sopra, e su quei file
 * ereditati la regola risponderebbe alla domanda sbagliata.
 */
export function deriveVisibility(files: readonly string[]): VisibilityLabel {
  if (!files.length) return 'visibile';
  return files.some(isUserVisibleFile) ? 'visibile' : 'invisibile';
}

/**
 * Chi chiude la card, in una funzione — la conseguenza operativa che le
 * etichette esistono per produrre (`docs/board-protocol.md` §8).
 *
 * `conductor` SOLO quando entrambe le cose sono vere: l'etichetta dice
 * `invisibile` E la barra è verde per intero. `checksState` diverso da `'pass'`
 * — compreso `null`, cioè «i comandi non sono mai girati» — non è un verde e
 * non autorizza nessuno: torna all'umano, che è il default di questa funzione.
 */
export function whoCloses(
  labels: readonly string[],
  checksState: 'running' | 'pass' | 'fail' | null,
): 'human' | 'conductor' {
  return labels.includes('invisibile') && checksState === 'pass' ? 'conductor' : 'human';
}

/**
 * Normalizza una lista di etichette scritte da fuori: scarta ciò che non è nel
 * vocabolario, deduplica, e tiene UNA sola etichetta di visibilità (l'ultima
 * vince) — `visibile` e `invisibile` insieme non sono una card, sono una
 * domanda senza risposta.
 */
export function normalizeLabels(raw: readonly unknown[]): TaskLabel[] {
  const out: TaskLabel[] = [];
  for (const item of raw) {
    if (!isTaskLabel(item)) continue;
    if (isVisibilityLabel(item)) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (isVisibilityLabel(out[i]!)) out.splice(i, 1);
      }
    } else if (out.includes(item)) continue;
    out.push(item);
  }
  return out;
}
