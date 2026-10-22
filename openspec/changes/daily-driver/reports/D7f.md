# D7f · Prova a due dispositivi del pane-store

**Barra prima:** Bun 1.4.2; `bun run typecheck:e2e` exit 0; `bun run typecheck` exit 0; `bun run lint` exit 0, 4 warning preesistenti e 0 errori.

**Barra dopo:** typecheck, typecheck:e2e e lint exit 0; cancelli statici verdi; `syncServer.test.ts` 16/16. Clip 38708887333: P.1-P.4 verdi, un video per dispositivo (`openTwoDevices` ora filma i contesti aperti a mano quando la run chiede il video). Mutante di P.3 (il merge non ritira mai il marcatore superato): run 38707359180, rosso alla riga 201.

## Fatto

- `tests/e2e/pane-store-two-devices.spec.ts`, P.1–P.4, nel notturno (`NIGHTLY_ONLY_SPECS`). Topic creati per test, `hermetic(test)`, seed con `resetPaneStore`, chiusura con la × (`closeTabViaX`), due contesti.
- **P.1** la chiusura arriva dal vivo all'altro dispositivo, regge al reload e a un contesto nuovo.
- **P.2** uno snapshot addormentato non resuscita né rimanda la chat chiusa. Il seme porta l'`openedAt` di X 15 minuti avanti, così vince solo la regola causale. Mutante (la regola degli orologi in `panes.ts`, le due condizioni del merge): rosso alla riga «l'idratazione deve sostituire lo snapshot locale stantio».
- **P.3** una riapertura fatta DOPO la chiusura vince: B riapre la chat dalla sidebar (la riga archiviata, che la toglie dall'archivio), A ricarica e la ritrova. Non ⇧⌘T, la cui pila lo stadio 3 fa per dispositivo. B riapre solo quando sul server c'è lo snapshot di A con la sua chiusura (il record in `closedStack`, che porta solo quello) e B l'ha applicato (il suo `server_seq`): solo allora il `lastSeq` di B supera il seq della chiusura, e la riapertura viene dopo anche per il merge. Aspettare che il server «mostri» la chiusura non basta: la chiamata di archivio di A la purga subito dal server, mentre lo snapshot di A aspetta ancora il debounce di 500 ms. Run diagnostica 38705807427: archivio di A a 35,631 s, B riapre a 36,056 s, lo snapshot di A arriva a 36,132 s e la cascata riarchivia. È la corsa qui sotto.
- **P.4** una chiusura fatta col server irraggiungibile arriva quando torna.
  - La prima versione (server ucciso) era vuota: il socket se ne accorgeva tardi, con la PUT in volo, e la strada del 'close' la rimandava da sola. Verde anche senza la correzione.
  - **Difetto vero, corretto** in `client/src/state/pane/middleware/syncServer.ts`: una PUT che esaurisce i tentativi lascia `pendingAfterClose = true`, e il gestore del 'close' lo mette in OR; una PUT riuscita lo azzera; `timer = null` allo scatto del debounce (prima ogni riconnessione rimandava uno snapshot inutile). Tre test unitari, ciascuno rosso solo sul suo mutante.
  - Ora toglie la rete al solo A. Ogni tentativo di riconnessione fallito emette un altro 'close', che annulla la PUT in attesa e la segna dovuta per l'altra strada (run diagnostica 38700936604: 3 tentativi, poi più niente). Quindi A chiude nel buco dopo il terzo tentativo fallito (Chromium lo scrive in console), quando il prossimo è a 8 s: la PUT fa i suoi 4 tentativi e si arrende, nessun socket si chiude nel mezzo, la rete torna e il server ha la chiusura.
  - Run 38702196929: P.4 verde. Mutante senza `pendingAfterClose = true` alla resa (run 38702200242): rosso, il server non riceve mai la chiusura.

## Trovato e non fatto

- **Riapertura concorrente con una chiusura in ritardo.** Run 38702196929, log del server: A archivia a 28,704 s, B toglie dall'archivio a 29,115 s, la PUT di A con la tombstone (partita dopo il debounce) arriva a 29,206 s e la cascata del server la ritira di nuovo: `[retirement] tab chiuse: 1 → 1 chat archiviate` (`server/services/pane-retirement-cascade.ts`, applicata in `server.ts`). La pane di B resta sul server, la chat resta archiviata. La riapertura lato server ritira solo la tombstone e non lascia un segno che si ordini contro la chiusura di A. Succede se B riapre nei 500 ms del debounce di A, quando su B la chiusura si vede già (la purga dell'archivio è immediata), oppure con A offline dopo la chiusura: la correzione di P.4 rende proprio quel rinvio sicuro. Direzione: la riapertura scrive in `pane-store-v2` un segno con un seq sopra quello del record, che il merge del client e la cascata ordinano contro le tombstone. È materia degli stadi successivi di `pane-store-server-authoritative`.
- Una chat chiusa a server giù non viene archiviata dal client: `archiveTopic` fa una `apiFetch` sola e al fallimento torna indietro (`useTopics.ts`). Probabilmente la archivia la cascata quando arriva la PUT rimandata; non verificato.

## Rifiutato

- Contare in P.3 la riapertura fatta mentre la chiusura di A è ancora nel debounce: sono due gesti concorrenti, non una riapertura «dopo» la chiusura. È il difetto sopra, non la promessa di P.3.
