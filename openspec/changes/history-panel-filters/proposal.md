## Da decidere

Filtri della cronologia completa: 3 scelte prima del codice.
1. Tipo: «Tutto · Tab chiuse · Pagine», le due sorgenti che la lista già unisce; il tipo di pane lo dice l'icona della riga (o: un bottone per tipo di pane, Chat · Terminale · Browser · File · Pagine)
2. Data: «Sempre · Oggi · Ieri · Prima», giorni separati: la lista va già dal più recente, quindi «Ieri» toglie le righe sopra, cioè lo scroll che risparmi (o: Oggi · 7 giorni · 30 giorni come il pannello consumi, che tagliano solo la coda)
3. I filtri ripartono da Tutto e Sempre a ogni apertura, come la ricerca: un filtro dimenticato acceso sembra cronologia persa (o: ricorda l'ultima scelta sul dispositivo)
Compreso, senza scelta: il pannello mostra tutto (fino a 50 tab e 200 pagine), non le 40 più recenti; la ricerca vuole tutte le parole, anche nell'indirizzo; ⇧⌘T resta sulla tab chiusa più recente; lista vuota con «Mostra tutto»; su telefono due righe da 44 px.
Col sì: anche la Cronologia di ⌘K cerca con quella regola su tutta la lista, non più sulle 40 più recenti. Costo: in ⌘K cercare «Chiusa» per isolare le tab smette di funzionare, e lì non c'è un filtro che lo sostituisca; nel pannello completo lo fa il filtro Tab chiuse.
«ok» = tutte le consigliate · «ok ma 2 no» = cambio la 2.

| # | Dove cambiarla |
|---|----------------|
| 1 | `HISTORY-02` (valori di `kind`) e `HISTORY-03` (bottoni del tipo) |
| 2 | `HISTORY-02` (`HistoryRange`, confini dei giorni) e `HISTORY-03` (bottoni del giorno); design §2 |
| 3 | `HISTORY-03` (azzeramento all'apertura); design §4 |

---

# Cronologia completa: filtri per tipo e per giorno

Card `2e015c9b`, staccata dalla card `d1643cc8` (menu utente), dove i filtri
erano un «eventualmente» del brief.

## Why

«Vedi tutta la cronologia» (`client/src/components/Sidebar/TopicsMenuItems.tsx:239-247`)
apre la palette nello scope `history` (`client/src/App.tsx:1933` e `:2227`,
montata a `App.tsx:2342-2344`). Lì c'è un campo di ricerca e una lista: nessun
modo di tenere solo le pagine, o solo ciò che hai chiuso ieri. E il pannello ha
tre difetti che un filtro renderebbe più visibili, non meno:

1. **Non è «tutta».** `buildHistoryRows` è chiamata con `limit: 40`
   (`client/src/components/Shared/CommandPalette.tsx:307-311`), mentre le
   sorgenti tengono fino a 50 tab chiuse (`CLOSED_STACK_MAX`,
   `client/src/state/pane/types.ts:425`) e 200 pagine (`MAX_PAGES`,
   `client/src/state/browserSiteHistory.ts:72`). Dalla riga 41 in giù la
   cronologia non si vede e non si trova nemmeno cercando.
2. **La ricerca non è quella di HISTORY-01.** La palette filtra le 40 righe con
   `filterByQuery` (`CommandPalette.tsx:464-474`): sottostringa contigua su
   etichetta e descrizione, e la descrizione contiene «Chiusa 5m fa». Quindi
   «fa» trova tutto, «github pull» non trova la pagina «Pull request» su
   github.com, e una tab browser chiusa non si trova dal suo indirizzo (il suo
   dettaglio è il progetto). Il commento di `client/src/lib/historyRows.ts:53-55`
   dice che la sua regola è «quella che la palette già segue»: non è vero.
3. **Il suggerimento ⇧⌘T sta sulla prima riga se è una tab**
   (`CommandPalette.tsx:334-337`). Con un filtro la prima tab visibile può non
   essere quella che ⇧⌘T riapre (`closedTabs[0]`, CMD-03); e già oggi, se la
   riga più recente è una pagina, il suggerimento non compare da nessuna parte.

## What changes

- **Funzione pura.** `buildHistoryRows` accetta `kind`, `range` e `now`, e
  filtra prima di ordinare e tagliare. Nuova `historyRangeOf(at, now)` per i
  giorni di calendario locali.
- **Barra dei filtri** (`client/src/components/Shared/HistoryFilters.tsx`,
  nuovo) sotto il campo di ricerca, solo nello scope `history`: due gruppi di
  bottoni con `aria-pressed`, nella forma del selettore di modo di
  `Project/FileSearch.tsx:260-281`.
- **Una sola strada per le righe.** In entrambi gli scope la palette passa la
  query a `buildHistoryRows`; nello scope `history` senza tetto, in ⌘K col tetto
  di 40 applicato dopo la ricerca.
- **Contorno.** Fuoco che torna al campo dopo un filtro, selezione che riparte
  dalla prima riga, vuoto con «Mostra tutto», ⇧⌘T sulla tab giusta,
  evidenziazione parola per parola, chiavi i18n it/en.

## Non-goals

- L'anteprima nel menu utente (6 righe, `TopicsMenuItems.tsx:105-112`) resta
  senza filtri: è un colpo d'occhio, la porta per filtrare è «Vedi tutta».
- Niente intestazioni per giorno nella lista, niente filtro per progetto,
  niente «Svuota cronologia», niente scorciatoie da tastiera per i filtri.
- Nessun cambio ai magazzini: tetti (50 e 200), persistenza e dedup restano.
- Nessun componente «segmented» condiviso: `FileSearch.tsx` e
  `Sidebar/ProjectUsagePanel.tsx:63-80` restano come sono.
- Niente virtualizzazione: 250 righe al massimo.

## Impact

`client/src/lib/historyRows.ts`, `client/src/components/Shared/CommandPalette.tsx`,
`client/src/components/Shared/HistoryFilters.tsx` (nuovo), i18n
(`client/src/lib/i18n-it.ts`, `client/src/lib/i18n-en.ts`). Test:
`client/src/lib/historyRows.test.ts` (esteso) e
`tests/e2e/history-filters.spec.ts` (nuovo), vedi `tasks.md`.
