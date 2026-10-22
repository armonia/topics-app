# live-terminals: ogni terminale acceso sul Mac, pilotabile da un agente e dalla tendina di Topics

## Perché

Topics pilotava solo le sue PTY. Il 15/10 sul Mac giravano sei `claude` aperti a mano: quattro in
Terminal.app e due in tmux. Nessuno compariva nella UI, nessun agente poteva leggerli o rispondergli,
e dal telefono non si raggiungevano. Il proprietario vuole che ogni terminale avviato resti
gestibile da un'AI e visibile da remoto, in una tendina in fondo alle tab, accesa di serie e
spegnibile dalle opzioni.

## Cosa cambia

- **Server.** `lib/live-terminals.ts` unisce tre sorgenti in una forma sola: le PTY di Topics, i pane
  tmux (`list-panes`, `capture-pane`, `send-keys -l`), le tab di Terminal.app (AppleScript:
  `contents`, `do script … in tab`). Rotte `GET /api/live-terminals`, `GET …/:id/screen`,
  `POST …/:id/send`, dietro il cancello globale come `POST /api/terminal/sessions`.
- **Agenti.** Gli strumenti `session_list`, `session_read`, `session_send` del server MCP
  `topics-board` (figlio del gateway condiviso) leggono da quelle rotte: vedono e scrivono anche nei
  terminali di fuori, con la stessa guardia sul menu a scelte.
- **UI.** Un ramo «Terminali vivi ›» in fondo al menu «+» di ogni barra di tab e nel menu «Topics»
  (un tocco dal telefono): un livello per origine, una sessione di Topics si apre nella sua tab, un
  terminale di fuori apre a lato lo schermo e un campo per scriverci. Opzione nel menu Vista, accesa
  di serie. Da chiuso non interroga niente.

## Barra

`specs/acceptance.md`.

## Fuori

- Warp (nessuna interfaccia per leggere o scrivere una tab), iTerm e Ghostty (non installati).
- Uno specchio in diretta del terminale di fuori come pane xterm: lo schermo si rilegge ogni 1,5 s
  solo mentre il livello è aperto.
- Raggiungere i terminali da ChatGPT sul web: serve un endpoint MCP pubblico, è un'altra change.
- Tasti di controllo (Ctrl-C, frecce) verso Terminal.app: `do script` sa solo scrivere e premere Invio.

## Deciso da me

- Ramo nel «+» e non un bottone suo in ogni barra: il primo giro della CI l'ha misurato, un bottone
  in più per barra stringeva le tab in quadratini a 600 px e metteva un terzo comando nella riga in
  alto del telefono, dove per scelta stanno solo titolo e campanella.

- Tre sorgenti e non di più, perché sono quelle in uso sul Mac del proprietario.
- Nessuna interrogazione a tendina chiusa (barra D1 del piano daily-driver).
- Il server di test usa un socket tmux suo e spegne Terminal.app: le tab vere non sono del test.
- Le rotte stanno dietro il cancello globale e non dietro il token agente: la UI deve poterle
  usare, e lanciare un terminale (`POST /api/terminal/sessions`) ha già lo stesso cancello.
