import type { PaneState } from './types';
import { DEFAULT_SPACE_ID } from './types';

/**
 * Uno stato delle pane VUOTO ma COMPLETO — l'unico punto in cui i test lo
 * costruiscono da zero.
 *
 * Prima ogni spec si scriveva il suo `blankState()` a mano, e sei copie su sei
 * erano ferme a una forma di `PaneState` che il sistema vero non produce più:
 * mancavano `tombstones`, `spaces` e `activeSpaceId` (una anche `lastServerSeq`).
 * Nessuna barra se ne accorgeva perché i file di test non erano typecheckati da
 * nessun progetto TypeScript; a runtime il buco veniva tappato dai `if
 * (!state.tombstones) state.tombstones = {}` sparsi nel reducer, cioè da codice
 * di produzione difensivo che esiste per colpa di queste fixture.
 *
 * I tombstone, in questo store, sono il meccanismo che impedisce a una pane
 * chiusa di resuscitare al prossimo hydrate: un test che parte SENZA la mappa
 * sta esercitando un ramo che nel prodotto non esiste.
 *
 * Deve restare allineato a `initialState` in `store.ts` — è la stessa forma, e
 * il typecheck dei test (`bun run typecheck:tests:client`) è ciò che ora lo
 * tiene onesto.
 */
export const blankPaneState = (): PaneState => ({
  panes: {},
  groups: {},
  closedStack: [],
  tombstones: {},
  focusedPaneId: null,
  groupOrder: [],
  spaces: {},
  activeSpaceId: DEFAULT_SPACE_ID,
  lastSeq: 0,
  localSeq: 0,
  lastServerSeq: 0,
});

/**
 * Uno snapshot COM'E' QUANDO RIENTRA — cioè dopo essere passato per il filo.
 *
 * `HYDRATE_FROM_SNAPSHOT` non riceve mai l'oggetto che il selettore ha appena
 * costruito: riceve quello che è stato serializzato in localStorage o spedito
 * sul WebSocket e poi riletto (`persistLocal.ts` fa esattamente
 * `JSON.parse(raw)` e lo spreme nel payload; il reducer lo tratta da non
 * fidato e lo passa a `sanitizeSnapshot(raw: unknown)`).
 *
 * Le spec dicevano «serialize the local snapshot» nel commento e poi passavano
 * l'oggetto VIVO. Non è una pedanteria: la serializzazione è dove esiste il
 * FORMATO DEL FILO, e per i tombstone i due formati sono diversi sul serio —
 * `buildSnapshot` li emette come mappa di NUMERI (retrocompatibilità: il
 * sanitizer vecchio scarta gli oggetti e riaprirebbe tutte le pane chiuse)
 * mentre `PaneState.tombstones` sono `{at, seq}`. Passare l'oggetto vivo
 * saltava proprio quel pezzo, e in più nascondeva i valori non-JSON
 * (`undefined`, `Map`, `NaN`) che sul filo non sopravvivono.
 */
export function overTheWire(snapshot: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(snapshot));
}
