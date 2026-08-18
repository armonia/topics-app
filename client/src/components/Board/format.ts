import { pointerWithin, closestCorners, type CollisionDetection } from '@dnd-kit/core';
import { TASK_STATUSES, attemptHasWork, type TaskAttempt, type TaskStatus } from '../../lib/board';

/** La firma di `useT()`, per le funzioni che formattano fuori da un componente. */
type Translate = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Il diffstat accanto a un tentativo del fan-out: `3 file · +120 −8`,
 * `in corso…`, `nessuna modifica`.
 *
 * Esiste già in `shared/task-attempt.ts` (`formatAttemptStat`) e questa NON è
 * una copia per distrazione: quella versione la usa il SERVER per scrivere il
 * confronto nel thread del task, e `shared/` non può vedere il dizionario del
 * client. Sono due superfici diverse — un commento scritto una volta e una UI
 * che cambia lingua sotto l'utente — e l'unico modo di unificarle sarebbe
 * portare il dizionario in `shared/`, cioè spostare la i18n del client dentro
 * codice che gira anche sul server. La forma resta la stessa (il test di parità
 * in `shared/task-attempt.test.ts` sorveglia quella copia).
 */
export function attemptStat(a: TaskAttempt, tr: Translate): string {
  if (a.state === 'running') return tr('board.task.attempt.stat.running');
  if (!attemptHasWork(a)) {
    return a.error
      ? tr('board.task.attempt.stat.noChangesError', { error: a.error })
      : tr('board.task.attempt.stat.noChanges');
  }
  const n = a.filesChanged ?? 0;
  // «file» è invariante in italiano (1 file, 3 file), non in inglese: il ramo
  // singolare/plurale esiste per l'inglese e in italiano rende lo stesso testo.
  return tr(n === 1 ? 'board.task.attempt.stat.files.one' : 'board.task.attempt.stat.files.many', {
    n, ins: a.insertions ?? 0, del: a.deletions ?? 0,
  });
}

/**
 * "claude-opus-4-8" → "Opus 4.8" — strip the `claude-` prefix, capitalize the
 * family name, join the remaining numeric segments with dots as the version.
 * Generic on purpose: a new model id needs no update here.
 *
 * The `[1m]` suffix is the CLI's long-context variant and becomes a readable
 * badge ("Opus 5 · 1M"): it is the difference between a 200k and a 1M window,
 * so it has to be legible in the picker, not glued onto the version number.
 */
export function friendlyModelLabel(modelId: string): string {
  const long = /\[1m\]$/i.test(modelId);
  const parts = modelId.replace(/^claude-/, '').replace(/\[1m\]$/i, '').split('-');
  const name = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : modelId;
  const version = parts.slice(1).join('.');
  const base = version ? `${name} ${version}` : name;
  return long ? `${base} · 1M` : base;
}

/**
 * Size a textarea to its content (and keep it sized while typing) so the
 * click-to-edit swap <p> ↔ <textarea> never shifts the layout: same font,
 * same padding, same height as the text it replaces.
 */
export const autoGrow = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
};

/**
 * Two-stage collision for a board that mixes BIG droppables (columns) with
 * SMALL ones (sortable cards). Bare closestCorners compares corner distances,
 * so an EMPTY column loses against a nearby card in the adjacent column — a
 * drop aimed at Todo kept resolving onto the In Progress card ("me lo fa
 * mettere solo in progress"). Pointer-first fixes it: whatever the pointer is
 * INSIDE wins (a card beats its own column for precise insertion; an empty
 * column area is the column); corner distance only breaks ties when the
 * pointer is outside every droppable (fast flicks).
 */
export const boardCollision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length) {
    const card = within.find((c) => !TASK_STATUSES.includes(String(c.id) as TaskStatus));
    return card ? [card] : within;
  }
  return closestCorners(args);
};

/** Compact chat timestamp: HH:MM today, dd/MM HH:MM otherwise. */
export function commentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

/**
 * "Ultimo aggiornamento" for a card/drawer title: relative while fresh, a clock
 * (same day) or date (older) once it ages — short enough to trail a title.
 * ora · 5m fa · 3h fa · HH:MM · dd/MM HH:MM.
 */
export function fmtUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ms = Date.now() - d.getTime();
  if (ms < 45_000) return 'ora';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m fa`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const h = Math.floor(m / 60);
  if (sameDay && h < 12) return `${h}h fa`;
  return commentTime(iso);
}

/**
 * DA QUANTO ASPETTA, con la precisione che serve a decidere.
 *
 * Non e' `fmtUpdatedAt`: quello scivola sull'orario assoluto dopo mezza
 * giornata («14:32»), che risponde a «quando» e non a «da quanto» - e in una
 * colonna di revisione la domanda e' la seconda. Una card ferma da tre giorni
 * deve dire TRE GIORNI, non l'ora di martedi'.
 *
 * Sotto l'ora resta muto: una richiesta appena arrivata non sta aspettando, sta
 * succedendo. Un chip su ogni card nuova sarebbe rumore, e il rumore su una
 * colonna che si legge di fretta si impara a saltare.
 */
export function fmtAttesa(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.floor((now - t) / 60_000);
  if (min < 60) return null;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const g = Math.floor(h / 24);
  return `${g}g`;
}

/** Compact duration: 42s · 7m · 1h12m. */
export const fmtMs = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
};

/** Live duration — seconds ALWAYS visible so the ticker is seen moving on
 *  in-progress cards (45s · 12m 05s · 1h 20m). fmtMs stays for static totals. */
export const fmtLive = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
};

/** Compact token count: 850 · 12.3k · 1.2M. */
export const fmtTok = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Model id → compact tier label for the card chip (auto when unresolved). */
export const fmtModel = (m: string | null | undefined): string => {
  if (!m) return 'auto';
  const s = m.toLowerCase();
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  if (s.includes('fable')) return 'fable';
  return m.replace(/^claude-/, '').split('-')[0];
};

/**
 * Un conteggio con i separatori delle migliaia SEMPRE, anche a quattro cifre.
 *
 * `toLocaleString` da solo non basta: in italiano (e in spagnolo, e in polacco)
 * ICU applica `minimumGroupingDigits = 2`, quindi 2578 esce «2578» e 12578 esce
 * «12.578». Qui il numero non è una quantità qualsiasi, è la MISURA che dice
 * «sotto c'è un piano, non due righe»: deve leggersi a colpo d'occhio, e due
 * formati diversi a seconda dell'ordine di grandezza sono il contrario.
 */
export const fmtCount = (n: number, locale: string): string =>
  n.toLocaleString(locale === 'en' ? 'en-US' : 'it-IT', { useGrouping: 'always' } as Intl.NumberFormatOptions);

/**
 * L'accenno che si vede quando la descrizione è CHIUSA: la prima riga di prosa,
 * ripulita dal markdown, tagliata corta.
 *
 * Serve perché il difetto non era l'accordion, era che **chiuso non si
 * distingueva da vuoto**: la scelta di chiudere è ricordata in `localStorage`
 * per tutte le card, quindi una descrizione da 2.578 caratteri si leggeva come
 * «non c'è una descrizione utile». Il chevron da solo non è evidenza di
 * contenuto; una riga del contenuto sì.
 *
 * Le intestazioni (`## …`), le liste e il grassetto perdono i marcatori: qui il
 * markdown non si rende, e `**Cosa** verificare` letto crudo sembra un errore
 * di battitura. Le righe di sola decorazione (`---`, un fence ```) non sono
 * l'accenno di niente e si saltano.
 */
export function descSummary(desc: string | null | undefined, max = 120): string {
  const line = (desc ?? '')
    .split('\n')
    .map((l) => l
      .replace(/^\s*[#>]+\s*/, '')          // intestazioni e citazioni
      .replace(/^\s*[-*+]\s+/, '')           // punti elenco
      .replace(/^\s*\d+[.)]\s+/, '')         // elenchi numerati
      .replace(/[*_`]/g, '')                 // enfasi e codice inline
      .trim())
    .find((l) => l.length > 0 && !/^[-=–—■□•]+$/.test(l)) ?? ''; // allow-emdash: i trattini QUI sono il dato, sono le righe di decorazione da saltare
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Il TESTO del task per gli appunti: titolo, riga vuota, descrizione.
 *
 * Serve al bottone «Copia task» del drawer, che esiste per un gesto solo:
 * prendere quello che c'è scritto sulla card e incollarlo altrove (una chat,
 * un'altra board, un agent). Il vicino «Copia link» copia un URL — utile a
 * ritrovare il task, inutile a chi il task deve LEGGERLO senza aprire Topics.
 *
 * Niente id, niente stato, niente metadati: è il contenuto, non un dump. La
 * descrizione vuota (o `null`, che il server usa quando non c'è) non lascia
 * dietro righe vuote — si copia il titolo e basta.
 */
export const taskCopyText = (task: { text: string; description?: string | null }): string => {
  const title = task.text.trim();
  const desc = (task.description ?? '').trim();
  return desc ? `${title}\n\n${desc}` : title;
};
