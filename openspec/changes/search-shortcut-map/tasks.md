# Tasks — search-shortcut-map

- [x] 1.1 `focusedProjectPath` riconosce le pane interne a un progetto aperto
- [x] 2.1 ⌘⇧P → palette scope 'projects'
- [x] 2.2 ⌘P → ricerca per NOME
- [x] 2.3 ⌘F → ricerca nel CONTENUTO, e non si tira più indietro quando il campo
      a fuoco è quello della ricerca stessa (era il suo, non uno da cui difendersi)
- [x] 2.4 ⌘⇧F ritirato; registro `shared/shortcuts.ts` aggiornato e
      `shortcuts_generated.rs` rigenerato (nessuna deriva: i due chord condividono
      il char `p`, come già ⌘N/⌘⇧N)
- [x] 3.1 `FileSearch` multi-progetto, raggruppato per file e per progetto
- [x] 3.2 `allSettled`: un progetto irraggiungibile non azzera gli altri
- [x] 3.3 Errore di rete distinto da «nessun risultato», e `truncated` del server reso
- [x] 4.1 `mode` controllato dal chiamante (era stato iniziale: la prop cambiava
      e non si vedeva niente)
- [x] 5.1 `lib/fuzzyScore` estratto da `FileMentionMenu`, con DUE tarature corrette:
      il bonus di confine valeva più della consecutività e si sommava a ogni
      carattere, quindi `s-t-o-r-e.ts` batteva `store.ts`. Trovato dal test.
- [x] 5.2 ⌘K ordina prima di tagliare; il `fuzzyMatch` locale senza punteggio è rimosso
- [x] 6.1 `tests/e2e/search-shortcuts.spec.ts` — 5 test: 5/5
- [x] 6.2 `client/src/lib/fuzzyScore.test.ts` — 10 test: 10/10
- [x] 6.3 Regressione: command-palette, add-menu, panels, project-tabs, sidebar,
      layout-navigation — 57/57 · unit 1928 client, 2403 server · typecheck pulito
