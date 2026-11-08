/**
 * UN GLIFO PER OGNI AZIONE, in un posto solo.
 *
 * ── Il difetto che questo file chiude ────────────────────────────────────────
 * Le scelte di una card erano parole nude: «Approva», «Landa su main»,
 * «Rimanda indietro», «Prendila in mano», tutte nella stessa scatola grigia,
 * tutte della stessa forma. Segnalato cosi': «ci sono una serie di tasti, forse
 * standard, che non capisco effettivamente [...] dovrebbe essere esposta con la
 * sua relativa icona». Con la sola parola, la differenza fra due uscite opposte
 * (chiudere e rimandare) sta in una lettura, non in un colpo d'occhio: e questa
 * riga e' esattamente il posto dove si decide di fretta.
 *
 * Le icone c'erano gia', ma per DUE voci sole (`stop`, `deliver-now`) e solo
 * nella forma a menu: la riga di bottoni, cioe' la superficie su cui si decide
 * davvero, non ne aveva nessuna.
 *
 * ── Perche' una tabella e non un'icona per componente ────────────────────────
 * Le stesse azioni sono disegnate in tre posti — la riga sulla card, il menu
 * `⋯`, i bottoni del drawer — e un glifo diverso per la stessa azione a seconda
 * di dove la si guarda e' peggio di nessun glifo: insegna che l'icona non vuol
 * dire niente. Qui c'e' la mappa, accanto alla tabella delle PAROLE
 * (`taskActionWords.ts`), e chi disegna la prende da qui.
 *
 * Sono COMPONENTI, non JSX: cosi' il modulo resta `.ts`, ogni superficie decide
 * la sua misura (`h-3 w-3` in riga, `h-3.5 w-3.5` a menu) e il file lo puo'
 * leggere anche una spec unitaria senza montare React.
 */

import {
  ArchiveRestore, Check, GitMerge, Hand, Link2Off, ListRestart, LockOpen, PackageCheck,
  RotateCcw, Square, Trash2, Undo2, type LucideIcon,
} from 'lucide-react';
import type { TaskActionId } from './taskActionWords';

/**
 * Il glifo di ogni azione. La scelta di ciascuno e' letterale, mai decorativa:
 * chi legge deve poter indovinare l'azione dall'icona senza la parola.
 *
 * · `land` — due rami che si fondono: e' un merge, ed e' l'unica voce che
 *   TOCCA main. Non una spunta: approvare e fondere sono due cose diverse, e
 *   darle lo stesso segno era il fraintendimento piu' caro della riga.
 * · `accept` — la spunta secca: chiude la card e basta, niente merge.
 * · `send-back` / `redo` — la freccia che torna indietro. `redo` la ha
 *   circolare perche' non e' «torna al mittente» ma «rifallo».
 * · `take-over` — la mano: da qui in poi ci mette mano una persona.
 * · `stop` — il quadrato del registratore, lo stesso del menu al tasto destro.
 * · `deliver-now` — il pacco chiuso: consegna quello che hai.
 * · `unblock` / `unlink` — il lucchetto che si apre e la catena spezzata: la
 *   prima fa ripartire il task, la seconda toglie solo il legame.
 * · `drop` / `restore` — cestino e ritorno dall'archivio.
 * · `requeue`: the list that starts again, a parked card going back in the queue.
 */
export const TASK_ACTION_ICON: Record<TaskActionId, LucideIcon> = {
  'land': GitMerge,
  'accept': Check,
  'send-back': Undo2,
  'redo': RotateCcw,
  'take-over': Hand,
  'stop': Square,
  'deliver-now': PackageCheck,
  'unblock': LockOpen,
  'unlink': Link2Off,
  'drop': Trash2,
  'restore': ArchiveRestore,
  'requeue': ListRestart,
};

/**
 * Il colore del glifo quando la voce e' su fondo neutro (menu, drawer).
 *
 * Sul bottone `primary` l'icona prende il colore del testo e basta: un verde
 * dentro un bottone verde non si vede. Qui invece il fondo e' grigio, e le due
 * azioni che INTERROMPONO qualcosa vanno distinte dalle altre a colpo d'occhio.
 */
export const TASK_ACTION_ICON_TONE: Partial<Record<TaskActionId, string>> = {
  'stop': 'fill-current text-rose-400',
  'drop': 'text-rose-400',
  'deliver-now': 'text-emerald-400',
  'land': 'text-emerald-400',
  'accept': 'text-emerald-400',
};
