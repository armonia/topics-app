/**
 * spaceHelpers — the non-component surface of the Spazi feature, split out of
 * SpaceSwitcher.tsx so that file only exports components (react-refresh
 * fast-refresh hygiene: a module mixing component + function exports forces a
 * full reload on every edit). Pure/imperative helpers shared by the switcher
 * chips and the "Sposta nello Spazio →" tab menu live here.
 */
import { usePaneStore } from '../../state/pane/store';
import { selectVisiblePaneIds } from '../../state/pane/selectors';
import { resolvePaneSpace, isLiveSpaceId } from '../../state/pane/reducers/spaces';
import { DEFAULT_SPACE_ID, type SpaceMeta, type Pane } from '../../state/pane/types';
import { spaceWindowsNow } from '../../state/windowPresence';
import { spaceWindowId } from '../../lib/windowRole';
import { clearPanelGridStorage } from './usePanelGridPersistence';
import { generateUUID } from '../../utils/uuid';

/** Label for the implicit default space (never stored in the registry). */
export const DEFAULT_SPACE_LABEL = 'Principale';

/** Live (non-deleted) spaces, ordered — the switcher's chip list after the
 *  default chip. */
export function liveSpacesOrdered(spaces: Record<string, SpaceMeta>): SpaceMeta[] {
  return Object.values(spaces)
    .filter((s) => !s.deleted)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/**
 * Quante tab tiene ciascun gruppo, contate sulle pane a livello app.
 *
 * È IL NUMERO CHE DECIDE SE UN GRUPPO SI DISEGNA. Un gruppo esiste finché
 * tiene qualcosa: la sua ragione d'essere è raccogliere tab, e a zero non
 * raccoglie niente — resta una scatola vuota che occupa la colonna e chiede di
 * essere sciolta a mano. La regola vale in due posti che devono dire la stessa
 * cosa (la card in `useSpaceCards` e il cancello `groupChromeActive` qui
 * sotto), e per questo il conteggio è UNO solo, qui.
 *
 * `paneIds` è la fila delle tab a livello app (`group:default`), la stessa che
 * legge `selectVisiblePaneIds`: una pane che non è nella fila non è una tab.
 */
export function tabsPerSpace(
  paneIds: readonly string[],
  panes: Record<string, Pane>,
  spaces: Record<string, SpaceMeta> | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of paneIds) {
    const spaceId = resolvePaneSpace(panes[id], spaces);
    counts.set(spaceId, (counts.get(spaceId) ?? 0) + 1);
  }
  return counts;
}

/**
 * C'è il gruppo, a schermo? Vero quando almeno un gruppo creato dall'utente
 * TIENE una tab, o quando la finestra È un gruppo staccato (`?space=`).
 *
 * Una risposta sola per due domande che devono coincidere: se SpaceGroups
 * disegna l'intestazione, l'albero deve dividersi in "tab di questo gruppo" e
 * "fuori dai gruppi"; se non la disegna, la sidebar resta la lista unica di
 * sempre. Rispondere due volte, in due file, è il modo per farle divergere —
 * un filo senza intestazione, o un'intestazione attorno a tutto.
 *
 * ESISTERE NON BASTA, e prima bastava: `liveSpacesOrdered(spaces).length > 0`
 * teneva accesa tutta l'impalcatura dei gruppi per un record nella registry,
 * anche dopo che l'ultima tab se n'era andata. Il risultato era una sidebar
 * fatta di scatole vuote — «Nessuna tab» dentro una card, e sopra il gruppo
 * principale incorniciato per niente — cioè esattamente ciò che rende
 * illeggibile una lista che senza gruppi si leggeva bene. Con zero gruppi
 * PIENI si torna alla lista di sempre, senza una scatola in più.
 *
 * `elsewhere` sono i gruppi che vivono in un'altra finestra: quelli contano
 * anche a zero tab, altrimenti la finestra resterebbe aperta e il gruppo che
 * ci abita sparirebbe da qui — l'unico posto da cui lo si richiama.
 */
export function groupChromeActive(
  spaces: Record<string, SpaceMeta>,
  pinnedSpaceId: string | null,
  tabsBySpace: ReadonlyMap<string, number>,
  elsewhere?: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): boolean {
  if (pinnedSpaceId) return true;
  return liveSpacesOrdered(spaces).some(
    (s) => (tabsBySpace.get(s.id) ?? 0) > 0 || !!elsewhere?.has(s.id),
  );
}

/**
 * Il primo gruppo DIVERSO da `exclude` a cui una finestra può passare, o null
 * se non ce n'è.
 *
 * Serve quando un gruppo se ne va in una finestra sua: chi resta deve mollarlo,
 * altrimenti due finestre disegnano la stessa griglia — ed è esattamente
 * quello che si vedeva ("ho fatto il detach ma la finestra è duplicata").
 * L'ordine è quello della sidebar: prima il principale, poi i gruppi in ordine.
 */
export function firstOtherLiveSpace(
  spaces: Record<string, SpaceMeta>,
  exclude: string,
  /** Gruppi che vivono in ALTRE finestre: non sono posti dove andare, ci si
   *  finirebbe solo per farsi rispedire indietro. */
  elsewhere?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): string | null {
  const taken = (id: string) =>
    elsewhere ? ('has' in elsewhere ? elsewhere.has(id) : false) : false;
  const ordered = [DEFAULT_SPACE_ID, ...liveSpacesOrdered(spaces).map((s) => s.id)];
  return ordered.find((id) => id !== exclude && !taken(id)) ?? null;
}

/** Mint a fresh space id (`space:` prefix per the coherence ruling). */
export function createSpaceId(): string {
  return `space:${generateUUID()}`;
}

/** Default name for the Nth user group ("Gruppo 2", …). Nel codice restano
 *  "space"/"Spazio" (id, azioni, chiavi); a schermo si dice GRUPPO, che è la
 *  parola che l'utente usa e quella che il modello merita: il gruppo è
 *  l'unità, e una finestra è un gruppo staccato. */
export function nextSpaceName(spaces: Record<string, SpaceMeta>): string {
  return `Gruppo ${liveSpacesOrdered(spaces).length + 2}`;
}

/** Detached pop-out windows (`?topics=`) skip every pane-store bridge — the
 *  switcher (and the "Sposta nello Spazio" menu) must not render there
 *  (coherence ruling 3.8).
 *
 *  Ri-esportato da `lib/windowRole`, che è ora l'unica risposta: questa copia
 *  guardava solo `?topic=` (singolare) e quindi dichiarava NON staccata ogni
 *  pop-out moderna `?topics=<id,…>` — cioè quasi tutte. Chi importa da qui non
 *  cambia riga; chi sta in `lib/` importa la fonte. */
export { isDetachedWindow } from '../../lib/windowRole';

/**
 * Move an app-level pane to another Spazio ("Sposta nello Spazio →"). The
 * membership write is a plain UPDATE_PANE (spaceId is a synced Pane field);
 * the default space is encoded as ABSENT. If the moved pane was the focused
 * one it just left the visible set — hand focus to the first pane still
 * visible (or null) BEFORE the focus-follow effect could yank the window to
 * the target space. No auto-switch: Arc semantics, the tab travels quietly.
 */
/**
 * «Porta questa cosa in questo gruppo», qualunque sia il suo stato.
 *
 * `movePaneToSpace` sposta una pane ESISTENTE e su una pane assente esce in
 * silenzio (`if (!pane) return`). Va benissimo per una tab che stai
 * trascinando — c'è per definizione — ma non per una TESSERA FISSATA: da
 * quando una tab fissata si può chiudere, il fissato che non è aperto adesso è
 * il caso normale, non l'eccezione. Il drop diceva «portala qui» e non faceva
 * niente, senza un errore da nessuna parte.
 *
 * Quindi: se la pane c'è, la si sposta; se non c'è, la si APRE lì. Una pane
 * nuova eredita `activeSpaceId` (vedi il reducer di `OPEN_PANE`), perciò prima
 * si porta davanti il gruppo di destinazione e poi si apre — che è anche quello
 * che uno si aspetta guardando: hai lasciato cadere una cosa dentro un gruppo,
 * quel gruppo viene in primo piano con la cosa dentro.
 */
export function bringPaneIntoSpace(paneId: string, targetSpaceId: string): void {
  const s = usePaneStore.getState();
  if (s.panes[paneId]) {
    movePaneToSpace(paneId, targetSpaceId);
    return;
  }
  if (s.activeSpaceId !== targetSpaceId) {
    s.dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: targetSpaceId } });
  }
  // Lo stesso imbuto d'apertura che usa il drop sulla griglia: passa da
  // `openPanel`, quindi disarchivia e rispetta il modello a due stati.
  window.dispatchEvent(
    new CustomEvent('topics:open-topic', { detail: { topicId: paneId, mode: 'permanent' } }),
  );
}

export function movePaneToSpace(paneId: string, targetSpaceId: string): void {
  const s = usePaneStore.getState();
  const pane = s.panes[paneId];
  if (!pane) return;
  const from = resolvePaneSpace(pane, s.spaces);
  if (from === targetSpaceId) return; // already there
  s.dispatch({
    type: 'UPDATE_PANE',
    payload: {
      id: paneId,
      updates: { spaceId: targetSpaceId === DEFAULT_SPACE_ID ? undefined : targetSpaceId },
    },
  });
  const after = usePaneStore.getState();
  if (after.focusedPaneId === paneId) {
    const visible = selectVisiblePaneIds(after);
    after.dispatch({ type: 'FOCUS_PANE', payload: { id: visible[0] ?? null } });
  }
  dissolveIfEmptied(from);
}

/**
 * Il gruppo da cui è appena uscita l'ultima tab si scioglie da sé.
 *
 * NON è una cancellazione di lavoro: un gruppo non contiene niente di suo, è
 * l'insieme delle tab che ci hai messo. Svuotato, ciò che resta è un nome in
 * una registry — e un nome che continua a comparire nel menu «Sposta nel
 * gruppo» accanto a gruppi veri è un posto dove mandare una tab che nella
 * sidebar non si vede: la stessa scatola vuota, spostata in un menu.
 *
 * Si scioglie SOLO come conseguenza di un gesto esplicito che sposta una tab
 * fuori, mai come controllo periodico dell'invariante: la cancellazione è una
 * lapide ASSORBENTE (vedi `mergeSpaces`), quindi un giro di reaper che partisse
 * prima che le pane siano idratate ucciderebbe un gruppo pieno, e per sempre.
 * Per la stessa ragione la CHIUSURA dell'ultima tab non scioglie niente: la tab
 * è nel closedStack e ⌘Z la riporta indietro, nel suo gruppo — che nel
 * frattempo la sidebar ha smesso di disegnare (`groupChromeActive`), che è
 * quanto serve a non vedere scatole vuote.
 *
 * Due deroghe, ed è la stessa: il gruppo che vive in una finestra sua non si
 * tocca, né visto da qui (`spaceWindowsNow`) né visto da lì (`spaceWindowId`) —
 * scioglierlo lascerebbe aperta una finestra senza più il gruppo che disegna.
 */
function dissolveIfEmptied(spaceId: string): void {
  if (spaceId === DEFAULT_SPACE_ID) return;
  if (spaceWindowId() === spaceId) return;
  const s = usePaneStore.getState();
  if (!isLiveSpaceId(spaceId, s.spaces)) return;
  const order = s.groups['group:default']?.paneIds ?? [];
  if ((tabsPerSpace(order, s.panes, s.spaces).get(spaceId) ?? 0) > 0) return;
  if (spaceWindowsNow().has(spaceId)) return;
  s.dispatch({ type: 'SPACE_DELETE', payload: { id: spaceId } });
  // La griglia di quel gruppo vive su una chiave localStorage suffissata: il
  // reducer è puro e non può toccarla (stessa pulizia di «Sciogli nel
  // principale», in SpaceGroups).
  clearPanelGridStorage(spaceId);
  const after = usePaneStore.getState();
  if (after.activeSpaceId !== spaceId) return;
  const next = firstOtherLiveSpace(after.spaces, spaceId, spaceWindowsNow());
  if (next) after.dispatch({ type: 'SET_ACTIVE_SPACE', payload: { id: next } });
}
