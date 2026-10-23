# D4f — B11, sfratto delle pane native sotto pressione

**Barra prima.** `bun test client/src/state/pane/residency/policy.test.ts`: 23 pass, 0 fail. Il frame memoria e i casi B11 non esistevano. La misura con l'app vera era fuori dall'esecuzione di questa traccia.

**Barra dopo.** Test mirati: 136 pass, 0 fail su 4 file. `bun run typecheck`: exit 0 (gate finale); `bun run typecheck:e2e`: exit 0; `bun run lint`: exit 0 (gate finale); `./scripts/qa-gate.sh --veloce`: exit 0, 23 check verdi, 0 rossi. `check:spec-coverage`: 0 requisiti scoperti.

## Fatto

- La policy espelle solo una pane `native` nascosta, non trattenuta, inattiva da almeno 600.000 ms, con `memory:pressure` attivo e impostazione accesa. I casi a 9 e 10 minuti, pressione assente, visibile, trattenuta e impostazione spenta sono coperti da `policy.test.ts`; il registro prova anche la scadenza del timer mentre la pressione resta attiva.
- Il server emette il frame al cambio di verdetto e lo invia a ogni connessione con il verdetto ripristinato. `memory-pressure.test.ts` prova transizioni, assenza di duplicati e snapshot di riconnessione; `ws-outbound-schema.test.ts` valida il contratto.
- L'interruttore persistente è acceso di default. Il marker della pane sfrattata sopravvive al remount; la riga si chiude alla navigazione o alla chiusura della pane.
- Nuovo scenario `LEAK-01` in `openspec/specs/performance/spec.md`, coperto dai test; coverage finale 0 scoperti.
- Prova rossa su `main` in copia scratch: 24 pass, 1 fail, il caso dei 10 minuti. Mutazione in copia che anticipa la soglia a 9 minuti: 24 pass, 1 fail, il caso dei 9 minuti. Entrambe le prove hanno exit 1; nessun mutante nel working tree.

## Trovato e non fatto

- Misura reale: non eseguita, come richiesto. Per rifarla: nell'app Topics su Mac attiva l'impostazione; apri 8 pane browser native e lascia 2 visibili; aspetta che il log server mostri `swap=sustained`; lascia le altre 6 nascoste per 10 minuti. Poi individua i processi `WebKit.WebContent` delle pane Topics tramite il roster Tauri (`browserpane-<id>`, eventuale prefisso generazione), leggi il footprint di ciascun PID con `/usr/bin/footprint --pid <PID> --format bytes --noCategories` e somma i valori. Barra: totale sotto 600 MB; riaprendo una delle sei, deve tornare all'URL salvato con l'avviso e l'avviso deve sparire navigando o chiudendo la pane.

## Rifiutato

- Non servivano nuovi campi URL/titolo: `useTauriBrowser` li aggiorna già e il pane store salva l'URL per il remount. `browser_close` è già il percorso che libera la WKWebView; non sono stati cambiati guscio o budget `heavy`/`light`.

## Revisione (15/10)

- `memoryPressureSignal` nasceva dopo il primo `await` dell'avvio, quando la porta accetta già
  connessioni: un client che si ricollegava in quel momento finiva in un ReferenceError nel gestore
  di apertura. Ora nasce accanto a `memSignal`, prima dell'ascolto.
- L'interruttore era una riga con una casella in cima a ogni pane browser. Ora sta nel pannello della
  macchina (`PerfSection`), accanto ai megabyte su cui agisce, e dice se la memoria scarseggia adesso.
- Il registro ricopiava la condizione della politica per decidere l'avviso. Ora `computeResident`
  dice quali pane ha liberato per la memoria (`memoryEvicted`) e il registro usa quello.
- L'avviso si perdeva per le pane browser dei task, la cui chiave è il `contextId` senza `browser:`
  (`taskBrowserLayout.ts`): ora vale per entrambe le forme, con un test.
- Commenti nuovi in inglese, come vuole il progetto.
