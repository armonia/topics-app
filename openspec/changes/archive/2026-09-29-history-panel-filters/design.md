# Design: history-panel-filters

Solo le scelte tecniche; quelle che cambiano cosa vedi stanno nel blocco
«Da decidere» di `proposal.md`.

## 1. Il filtro sta in `buildHistoryRows`, non nella palette

`buildHistoryRows` (`client/src/lib/historyRows.ts:57`) è già la funzione pura
che unisce le due sorgenti, ed è l'unico posto dove vive la regola della
ricerca (HISTORY-01). Tipo e giorno vanno lì accanto, per tre motivi:

- si provano con `bun:test` senza montare React;
- l'ordine dei passi (tipo, giorno, ricerca, ordinamento, tetto) è scritto una
  volta sola, e il tetto non può finire prima del filtro;
- la palette smette di avere una sua regola: oggi ne ha una
  (`filterByQuery`, `CommandPalette.tsx:464-471`) che contraddice quella della
  funzione, ed è il difetto 2 del `proposal.md`.

`kind` si applica prima di costruire le righe (una sorgente saltata non si
mappa nemmeno); `range` e `query` dopo, sulle righe costruite.

## 2. Giorni di calendario, con `now` iniettato

`historyRangeOf(at, now)` calcola due mezzanotti locali:

```ts
const d = new Date(now);
const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const startYesterday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
```

Il costruttore col giorno `- 1` e non `startToday - 86_400_000`: misurato con
Bun e `TZ=Europe/Rome`, per `now` = 26/10/2026 00:30 il costruttore dà
l'inizio di ieri a `2026-10-24T22:00Z`, la sottrazione a `23:00Z`. Una pagina
del 25/10 alle 00:30 finirebbe in «Prima» invece che in «Ieri».

Lo scenario si prova nel file di test assegnando `process.env.TZ`, che Bun
rispetta a runtime. Ma il fuso è del processo, e `scripts/test-unit-serial.ts`
fa girare tutte le `SUITE_ROOTS` in un solo `bun test`: il ripristino decide il
fuso di ogni file che viene dopo. `bun test` parte con `TZ` non impostato (fuso
effettivo UTC), e il ripristino che viene naturale, `delete process.env.TZ`,
non ripristina niente: misurato con Bun 1.3.8, dopo il `delete` il fuso resta
congelato sull'ultimo valore e le assegnazioni successive vengono ignorate. Si
salva il fuso effettivo e si riassegna, mai `delete`:

```ts
describe("il giorno del cambio d'ora", () => {
  let zoneBefore = '';
  beforeAll(() => {
    zoneBefore = Intl.DateTimeFormat().resolvedOptions().timeZone; // 'UTC' sotto bun test
    process.env.TZ = 'Europe/Rome';
  });
  afterAll(() => { process.env.TZ = zoneBefore; });
  // ...
});
```

Misurato con tre file in fila: col `delete` il file dopo vede ancora
`new Date(2026, 9, 26, 0, 30)` a `2026-10-25T23:30Z`, cioè Europe/Rome; con la
riassegnazione torna a `00:30Z`. Alla fine `process.env.TZ` vale `'UTC'` e non
`undefined`: stesso fuso. Il `withTz` di `scripts/board-doctor.test.ts:118-126`
aveva il `delete` e congelava Europe/Rome per i file dopo di lui: corretto in
questo ramo con la stessa riassegnazione.

`at >= startToday` è `'today'`, anche quando `at > now`: nessun ramo per il
futuro, cade da sé nel primo confronto.

## 3. Una sola strada per le righe della cronologia nella palette

`recentItems` (`CommandPalette.tsx:306-346`) oggi costruisce 40 righe senza
query e le filtra dopo. Diventa:

```ts
buildHistoryRows({
  closedTabs: onReopenClosedTab ? closedTabs : [],
  pages: onOpenHistoryUrl ? pages : [],
  query,
  kind: scope === 'history' ? historyKind : undefined,
  range: scope === 'history' ? historyRange : 'all',
  limit: scope === 'history' ? undefined : 40,
})
```

e `recentFiltered` (`CommandPalette.tsx:474`) smette di passare da
`filterByQuery`. Il memo dipende ora dalla query: al massimo 250 righe
rifatte a ogni tasto, niente di misurabile.

In ⌘K la sezione «Cronologia» abbina con una regola diversa dalle sezioni
accanto (parole contro sottostringa). È voluto: è la regola che HISTORY-01 dà
alla cronologia, e allineare progetti e topic è un'altra change.

## 4. Stato dei filtri: in `CommandPalette`, azzerato all'apertura

Due `useState` (`historyKind`, `historyRange`) accanto a `query`. L'effetto di
apertura (`CommandPalette.tsx:518-525`) li riporta a `undefined` e `'all'`
insieme alla query. Con la scelta 3 al «no» diventano una lettura e una
scrittura in `localStorage` con `try/catch`, e l'effetto non li tocca.

`HistoryFilters` è controllato e non ha stato: riceve `kind`, `range`,
`isMobile` e `onChange`. Dopo ogni `onChange` la palette chiama
`inputRef.current?.focus()` (`inputRef`, `CommandPalette.tsx:167`), tranne
sotto i 768 px: sul telefono quel `focus()` dentro il tocco riapre la tastiera
di iOS sopra la lista. L'effetto che azzera la selezione
(`CommandPalette.tsx:510-513`) guarda anche i due filtri.

Perché `role="group"` + `aria-pressed` e non `radiogroup`: è la forma del
selettore di modo di `Project/FileSearch.tsx:260-281`, l'unico precedente con
`role="group"`. Il selettore del periodo di `Sidebar/ProjectUsagePanel.tsx:65-80`
ha soltanto `aria-pressed`, su un `div` senza ruolo. Il Tab ci arriva da sé:
`useModalDialog` (`CommandPalette.tsx:530`) tiene il Tab dentro la palette.

## 5. ⇧⌘T: confronto per id, non per posizione

`closedTabs` è dal più recente (`useClosedTabs` rovescia la pila, commento in
`state/pane/adapters/closedTabRecord.ts:419`), e ⇧⌘T riapre `closedTabs[0]`
(`hooks/useKeyboardShortcuts.ts:387`). La riga col suggerimento è quella con
`row.record?.id === closedTabs[0]?.id`; il test `i === 0` sparisce.

## 6. Evidenziazione a parole

`highlightQuery` (`CommandPalette.tsx:923-932`) spezza la query sugli spazi,
fa l'escape di ogni parola, le ordina dalla più lunga e le unisce in un'unica
alternanza (`(a|b)`, `gi`). L'ordine conta: l'alternanza prende il primo ramo
che combacia, quindi `(git|github)` su «github» segnerebbe solo «git». Il pezzo
da segnare è un gruppo catturato, cioè un indice dispari dello `split`, non più
il confronto con la query intera (`:928`), che con due parole non combacia mai.

Vale in tutti gli scope. Con una parola segna gli stessi caratteri di oggi; con
una frase che c'è intera, gli stessi tranne gli spazi fra le parole, che oggi
stanno dentro l'unico segno e domani no.

## 7. Telefono

`isMobile` arriva già alla palette (`CommandPalette.tsx:172`). `HistoryFilters`
con `isMobile` mette i gruppi in colonna (`flex-col gap-2`), ogni gruppo
largo quanto la riga e ogni bottone `flex-1 h-11`: 3 bottoni in 343 px sono
114 px l'uno, 4 bottoni 85 px, e le etichette più lunghe («Tab chiuse»,
«Sempre») ci stanno. Da desktop la classe dei bottoni è quella di
`FileSearch.tsx:252` (`px-1.5 py-0.5 text-mini`).
