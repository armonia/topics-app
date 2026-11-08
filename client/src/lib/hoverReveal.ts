/**
 * hoverReveal — UNA regola per i comandi nascosti dietro il passaggio del mouse.
 *
 * Il difetto che questo modulo chiude era in nove file, scritto nove volte a
 * mano: `opacity-0 group-hover:opacity-100`. Due cose insieme, ed entrambe
 * sbagliate su un dito:
 *
 *  1. `.group-hover\:opacity-100` di Tailwind vive dentro `@media (hover: hover)`.
 *     Su un device senza puntatore quella classe NON si accende mai: il comando
 *     non è «meno visibile», è IRRAGGIUNGIBILE.
 *  2. `opacity: 0` non toglie l'hit-test. Il bottone invisibile resta cliccabile
 *     ALLA CIECA — sulla lista dei branch il bersaglio fantasma era «cancella
 *     branch», 14×14px incollato al bordo di una riga il cui tocco fa checkout.
 *
 * Il ramo touch deve quindi decidere DUE cose, non una, e non c'è una risposta
 * buona per tutti: dipende se il comando ha un altro modo per esistere.
 *
 *  · `touch: 'hidden'` — il comando resta nascosto, e va con
 *    `pointer-events-none` così non c'è più niente da colpire alla cieca.
 *    **Si usa SOLO se quel comando è raggiungibile in un altro modo col dito**
 *    (tipicamente il menu di riga: `useLongPress` + `openContextMenuAt`, che
 *    sintetizza il `contextmenu` che gli handler del tasto destro già ascoltano
 *    — quindi è LO STESSO menu, non un secondo da tenere allineato).
 *  · `touch: 'shown'` — niente hover, niente da nascondere: il comando si vede.
 *    È la scelta giusta per i comandi di INTESTAZIONE (uno per pannello, non
 *    uno per riga) e per i pochi che non hanno un menu dove rifugiarsi.
 *
 * `pointer-events-none` va nello STESSO ramo del ternario, non fuori: anche
 * `group-hover:pointer-events-auto` sta dentro `@media (hover: hover)`, quindi
 * scritto fuori non si riaccenderebbe mai e il comando resterebbe morto anche
 * col mouse.
 *
 * La domanda è `hasHover`, MAI `isTouch`: sono ortogonali (vedi il blocco in
 * `hooks/useMobile.ts`). Un portatile con schermo touch è `isTouch` e ha anche
 * il puntatore — gatare su `isTouch` gli spegne l'hover che invece ha.
 *
 * NB — niente `.tap-expand-y` come scorciatoia su queste righe: su righe
 * contigue da 24-30px proietterebbe aree da 44px sovrapposte e vincerebbe
 * l'ultima nel DOM (`index.css`, sezione sui bersagli proiettati).
 */

/**
 * I nomi di gruppo, scritti per ESTESO uno per uno.
 *
 * Tailwind legge le classi nel sorgente: una composta a runtime
 * (`group-hover/${nome}`) non verrebbe mai generata e la regola morirebbe in
 * silenzio. Aggiungere un gruppo qui è l'unico modo di aggiungerlo.
 */
const REVEAL_BY_GROUP = {
  /** `group` senza nome — il caso di default. */
  self: 'group-hover:opacity-100',
  node: 'group-hover/node:opacity-100',
  files: 'group-hover/files:opacity-100',
  hdr: 'group-hover/hdr:opacity-100',
  git: 'group-hover/git:opacity-100',
  hunk: 'group-hover/hunk:opacity-100 focus-within:opacity-100',
  remote: 'group-hover/remote:opacity-100',
  row: 'group-hover/row:opacity-100 focus:opacity-100',
  prev: 'group-hover/prev:opacity-100',
  preview: 'group-hover/preview:opacity-100',
  tool: 'group-hover/tool:opacity-100 group-focus-within/tool:opacity-100',
  toolgroup: 'group-hover/toolgroup:opacity-100 group-focus-within/toolgroup:opacity-100',
} as const;

export type HoverRevealGroup = keyof typeof REVEAL_BY_GROUP;

export interface HoverRevealOptions {
  /**
   * Che ne è del comando quando NON c'è un puntatore.
   *
   *  · `'hidden'` (default) — sparisce davvero, hit-test compreso. Legittimo
   *    solo se esiste un altro percorso col dito (menu di riga, long-press).
   *  · `'shown'` — resta visibile e cliccabile: è il suo unico percorso.
   */
  touch?: 'hidden' | 'shown';
}

/** Nascosto DAVVERO: niente da colpire alla cieca. */
export const HOVER_REVEAL_HIDDEN = 'opacity-0 pointer-events-none';

/**
 * Le classi di un comando che si scopre al passaggio del mouse.
 *
 *     const reveal = hoverRevealClass(hasHover, 'node');
 *     <div className={`… ${reveal}`}>
 *
 * Dentro un componente si preferisce `useHoverReveal`, che legge `hasHover` da
 * sé e resta reattivo quando il puntatore cambia (una Magic Keyboard tolta da
 * un iPad non manda nessun `resize`).
 */
export function hoverRevealClass(
  hasHover: boolean,
  group: HoverRevealGroup = 'self',
  { touch = 'hidden' }: HoverRevealOptions = {},
): string {
  if (hasHover) return `opacity-0 transition-opacity ${REVEAL_BY_GROUP[group]}`;
  return touch === 'shown' ? '' : HOVER_REVEAL_HIDDEN;
}
