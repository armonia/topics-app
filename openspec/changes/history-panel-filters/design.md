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
del 25/10 alle 00:30 finirebbe in «Prima» invece che in «Ieri». `Bun` rispetta
`process.env.TZ` assegnato a runtime, quindi lo scenario si prova nel file di
test senza toccare l'ambiente della suite.

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
`inputRef.current?.focus()` (`inputRef`, `CommandPalette.tsx:167`) e l'effetto
che azzera la selezione (`CommandPalette.tsx:510-513`) guarda anche i due
filtri.

Perché `role="group"` + `aria-pressed` e non `radiogroup`: è la forma dei due
selettori che esistono già (`Project/FileSearch.tsx:262-280`,
`Sidebar/ProjectUsagePanel.tsx:66-80`), e uno screen reader li legge allo
stesso modo. Il Tab ci arriva da sé: `useModalDialog`
(`CommandPalette.tsx:530`) tiene il Tab dentro la palette.

## 5. ⇧⌘T: confronto per id, non per posizione

`closedTabs` è dal più recente (`useClosedTabs` rovescia la pila, commento in
`state/pane/adapters/closedTabRecord.ts:419`), e ⇧⌘T riapre `closedTabs[0]`
(`hooks/useKeyboardShortcuts.ts:372`). La riga col suggerimento è quella con
`row.record?.id === closedTabs[0]?.id`; il test `i === 0` sparisce.

## 6. Evidenziazione a parole

`highlightQuery` (`CommandPalette.tsx:923-932`) spezza la query sugli spazi,
fa l'escape di ogni parola e le unisce in un'unica alternanza
(`(a|b)`, `gi`). Vale in tutti gli scope: per una query di una parola, o per
una frase che c'è intera, segna gli stessi caratteri di oggi.

## 7. Telefono

`isMobile` arriva già alla palette (`CommandPalette.tsx:172`). `HistoryFilters`
con `isMobile` mette i gruppi in colonna (`flex-col gap-2`), ogni gruppo
largo quanto la riga e ogni bottone `flex-1 h-11`: 3 bottoni in 343 px sono
114 px l'uno, 4 bottoni 85 px, e le etichette più lunghe («Tab chiuse»,
«Sempre») ci stanno. Da desktop la classe dei bottoni è quella di
`FileSearch.tsx:252` (`px-1.5 py-0.5 text-mini`).
