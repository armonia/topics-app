/**
 * Il campo remoto, descritto in modo che ci stia su un filo.
 *
 * Nel pane browser la pagina remota non è scrivibile: le battute le prende un
 * campo di cattura NOSTRO, nascosto, e la tastiera che iOS apre è quella di
 * QUEL campo. Perché sia quella giusta, il campo di cattura va vestito come il
 * campo remoto prima di prendere il fuoco.
 *
 * Chi risponde alla domanda «che campo hai toccato» però non è sempre lo stesso:
 *  · sul co-browse DOM è il mirror rrweb, che è un DOM vero e si interroga qui;
 *  · sul ramo video non c'è nessun DOM da interrogare, e la risposta la dà il
 *    server: dopo il click, Playwright legge `document.activeElement` e ne
 *    manda gli attributi sul WS del pane.
 *
 * Le due strade portano lo stesso dato, quindi la DECISIONE (quale tastiera per
 * quali attributi) sta qui, in un modulo solo, senza React e senza DOM: due
 * copie della stessa tabella sarebbero divergite al primo `inputmode` nuovo.
 * Il ramo DOM ci arriva fotografando l'elemento (`client/src/lib/
 * browserKeyboardProfile.ts`), il server riempiendo lo stesso oggetto da
 * `document.activeElement`.
 *
 * Idioma `zod/mini` come il resto di `shared/`: questo schema finisce nel
 * bundle client (lo importa il protocollo WS del pane).
 */
import { z } from 'zod/mini';

/**
 * Gli attributi del campo remoto che decidono la tastiera. Solo stringhe e
 * booleani: è la forma che attraversa il WS, e lo stesso oggetto che il ramo
 * DOM costruisce dall'elemento del mirror.
 *
 * Tutti i campi sono opzionali sul filo perché un server più vecchio (o una
 * pagina che non dichiara nulla) manda meno di così, e la mancanza di un
 * attributo è già la risposta giusta: nessuna dichiarazione, nessun effetto.
 */
export const remoteFieldSchema = z.object({
  /** `input`, `textarea`, `select`, o il tag dell'elemento contenteditable. */
  tag: z.string(),
  /** L'attributo `type` di un <input>. Vuoto per tutto il resto. */
  type: z.optional(z.string()),
  inputMode: z.optional(z.string()),
  enterKeyHint: z.optional(z.string()),
  autoCapitalize: z.optional(z.string()),
  autoCorrect: z.optional(z.string()),
  spellCheck: z.optional(z.string()),
  /** Un campo disabilitato o in sola lettura non apre nessuna tastiera. */
  disabled: z.optional(z.boolean()),
  readOnly: z.optional(z.boolean()),
  /** Dentro un <form>: l'invio manda, ed è quello che il tasto deve dire. */
  inForm: z.optional(z.boolean()),
});

export type RemoteField = z.infer<typeof remoteFieldSchema>;

/** I `type` di input che chiedono una tastiera diversa. Tutto il resto → testo. */
const KEYBOARD_TYPES = new Set(['text', 'email', 'url', 'tel', 'number', 'search', 'password']);

/** `inputmode` validi per HTML: un valore fuori lista si ignora, non si inoltra. */
const INPUT_MODES = new Set(['none', 'text', 'decimal', 'numeric', 'tel', 'search', 'email', 'url']);

/** `enterkeyhint` validi: decidono la parola sul tasto invio (Vai, Cerca, Invia…). */
const ENTER_HINTS = new Set(['enter', 'done', 'go', 'next', 'previous', 'search', 'send']);

const CAPITALIZE = new Set(['off', 'none', 'on', 'sentences', 'words', 'characters']);

/**
 * Gli `type` che NON sono scrittura: toccarli non deve far salire nessuna
 * tastiera. Prima ne saliva una per ogni tocco, anche sul bottone «Cerca».
 */
const NON_TEXT_TYPES = new Set([
  'button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio', 'range',
  'color', 'hidden',
]);

/**
 * I `type` data/ora: su iOS aprono un rullo, non una tastiera. Non li possiamo
 * riprodurre su un campo di cattura, e fingere una tastiera numerica sarebbe
 * peggio del silenzio, quindi contano come non-scrittura.
 */
const PICKER_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);

export interface KeyboardProfile {
  /** `type` da mettere sul campo di cattura. */
  type: 'text' | 'email' | 'url' | 'tel' | 'number' | 'search' | 'password';
  /** `inputmode`, quando il campo remoto ne dichiara uno (vince sul `type`). */
  inputMode: string;
  /** Parola sul tasto invio. */
  enterKeyHint: string;
  autoCapitalize: string;
  autoCorrect: 'on' | 'off';
}

/** Il profilo di partenza: tastiera di testo, niente correzioni automatiche. */
export const DEFAULT_KEYBOARD_PROFILE: KeyboardProfile = {
  type: 'text',
  inputMode: '',
  enterKeyHint: '',
  autoCapitalize: 'off',
  autoCorrect: 'off',
};

/** Valore di attributo normalizzato: minuscolo, senza spazi, mai `undefined`. */
function norm(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

/**
 * Il profilo di tastiera del campo remoto, oppure `null` se su quel campo non
 * deve salire nessuna tastiera (un bottone, una checkbox, un rullo data, una
 * select, un campo disabilitato o in sola lettura).
 *
 * È l'unica funzione con una risposta giusta e una sbagliata di tutta la
 * faccenda, e si misura a tavolino: vedi `browserKeyboardProfile.test.ts`.
 */
export function keyboardProfileForField(field: RemoteField | null | undefined): KeyboardProfile | null {
  if (!field) return null;
  const tag = norm(field.tag);
  // Una <select> apre la sua lista, non una tastiera; e un campo che non accetta
  // scrittura non deve chiamarla. `readonly` conta: iOS la tastiera non la apre.
  if (tag === 'select') return null;
  if (field.disabled || field.readOnly) return null;

  const rawType = tag === 'input' ? (norm(field.type) || 'text') : 'text';
  if (NON_TEXT_TYPES.has(rawType) || PICKER_TYPES.has(rawType)) return null;

  const profile: KeyboardProfile = { ...DEFAULT_KEYBOARD_PROFILE };
  if (KEYBOARD_TYPES.has(rawType)) profile.type = rawType as KeyboardProfile['type'];

  // `inputmode` è la dichiarazione più precisa che un sito possa fare (è nata
  // apposta per la tastiera) e vince sul `type` quando c'è.
  const mode = norm(field.inputMode);
  if (INPUT_MODES.has(mode)) profile.inputMode = mode;

  const hint = norm(field.enterKeyHint);
  if (ENTER_HINTS.has(hint)) profile.enterKeyHint = hint;
  else if (tag !== 'textarea' && field.inForm) {
    // Un campo dentro un form: l'invio manda. È quello che il tasto deve dire.
    profile.enterKeyHint = profile.type === 'search' ? 'search' : 'go';
  }

  // Maiuscole e correttore: si seguono le dichiarazioni del sito, ma solo dove
  // hanno senso. Su email/url/password la correzione automatica storpia il
  // valore, e nessun sito la vuole davvero.
  const quiet = profile.type === 'email' || profile.type === 'url' || profile.type === 'password';
  const cap = norm(field.autoCapitalize);
  if (!quiet && CAPITALIZE.has(cap)) profile.autoCapitalize = cap === 'none' ? 'off' : cap;
  if (!quiet && norm(field.autoCorrect) === 'on') profile.autoCorrect = 'on';
  if (!quiet && norm(field.spellCheck) === 'true') profile.autoCorrect = 'on';

  return profile;
}
