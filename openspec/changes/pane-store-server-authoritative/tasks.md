# Tasks: pane-store-server-authoritative

L'ordine degli stadi **non è negoziabile**: lo stadio 0 è un prerequisito trovato
dalla verifica avversariale, lo stadio 1 chiude da solo il guasto misurato con un
raggio piccolo, lo stadio 2 sostituisce il modello. **Ogni stadio è approvabile e
landabile per conto suo**: se il 2 si ferma, il guasto resta chiuso.

## Stadio 0 — identità deterministica (PANE-AUTH-04)

- [ ] 0.1 `adapters/paneConfig.ts:102`: le pane-vista singleton di progetto (git,
  files, dashboard, activity, browser…) smettono di nascere con
  `${type}:${generateUUID()}` e derivano l'id da `(projectPath, type)`.
  **Verifica:** unit — lo stesso progetto e lo stesso tipo danno lo stesso id su due
  «dispositivi» simulati.
- [ ] 0.2 `hooks/useProjectChatSync.ts:326-336`: il dedup per TIPO
  (`localSingletonTypes`) diventa superfluo e va rimosso, non lasciato come doppia
  difesa. **Verifica:** aprire la stessa vista su due client non produce duplicati,
  e il test che oggi copre il dedup per tipo viene riscritto sull'id.
- [ ] 0.3 **Migrazione degli id vivi**: le pane-vista già aperte hanno id casuali.
  Rimapparle al boot con `PANE_ID_REMAP`, preservando `stableKey`
  (`reducers/panes.ts:729-730`). **Verifica:** una WKWebView aperta **non rimonta**
  durante la rimappatura — misurato col conteggio dei processi WebContent, non a
  occhio (`residency/policy.ts` indicizza per `stableKey ?? id`).
- [ ] 0.4 Presidio: un test che fallisce se una pane-vista di progetto torna a
  nascere con un uuid casuale. **Verifica:** rosso se si ripristina `generateUUID()`.

## Stadio 1 — la causalità sostituisce gli orologi (PANE-AUTH-02) — **FATTO 2026-08-06**

Realizzato interamente lato client, senza toccare il server: la grandezza causale
esisteva già ed è `lastSeq`, che `middleware/syncWS.ts` tiene al passo col
`server_seq` (`lastSeq: Math.max(currentSeq, server_seq)`). Il marcatore è
diventato `{at, seq}` e le pane portano `openedSeq`. Nessuna rotta nuova, nessuna
migration: i 381 marcatori sul server sono numeri nudi, si normalizzano a `seq: 0`
e con `seq: 0` decide il marcatore — la direzione sicura.

Corretto su **entrambe** le metà dello strip (la metà che lascia cadere una pane
locale chiusa altrove, e quella che strippa una pane elencata in arrivo): farlo su
una sola avrebbe fatto rientrare il guasto dall'altro lato.

Due difetti emersi dai test durante il porting, entrambi introdotti da me:
l'innesto che preserva `openedAt` attraverso l'applicazione integrale non
preservava `openedSeq` — e perderlo non degrada la precisione, **spegne** la
regola — e la promozione bozza→chat non lo portava attraverso il remap.

**Il formato del filo resta retrocompatibile**, e non era opzionale: guardando il
server vivo il marcatore Japan era già `{at, seq}`, ma il bundle servito è ancora
il precedente e il suo sanitizer scarta gli oggetti. `tombstones` esce quindi come
mappa di numeri e il `seq` viaggia in `tombstoneSeqs`, chiave che un client vecchio
ignora.

Verificato: 422 test del pane store, 1910 client, 2394 server, typecheck e lint
puliti. Il caso Japan è riprodotto in quattro test, incluso quello che verifica che
una riapertura LEGITTIMA sopravviva — ucciderla insieme al guasto sarebbe stato un
regresso.

> **Il piano prevedeva lavoro sul server; non è servito.** La grandezza causale
> esisteva già lato client — `lastSeq`, che `syncWS` allinea al `server_seq`. Le
> voci sotto sono riscritte su ciò che è stato fatto davvero, non sul piano:
> spuntare 1.1 e 1.2 nella loro forma originale (`closed_rev` sul server, `baseRev`
> sull'intento) sarebbe stato falso.

- [x] 1.1 Il marcatore porta la grandezza causale: `tombstones` passa da
  `Record<string, number>` a `Record<string, TombstoneMark>` con `{at, seq}`, dove
  `seq` è il `lastSeq` dello store alla chiusura. **Verifica:** unit — due chiusure
  consecutive ottengono seq crescenti; `capTombstones` ordina su `at`.
- [x] 1.2 Le pane portano `openedSeq`, il `lastSeq` all'apertura, con le stesse
  regole di `openedAt` (inserimento fresco timbra, ri-OPEN conserva, payload
  esplicito vince). Whitelistato in `sanitizeSnapshot`, innestato attraverso
  l'applicazione integrale e portato dal `PANE_ID_REMAP`. **Verifica:** unit su
  tutti e quattro i percorsi — gli ultimi due erano difetti trovati dai test.
- [x] 1.3 **Cancellato** il confronto `openedAt > tombstones[id]` su **entrambe** le
  metà dello strip. Al suo posto `openedSeq > mark.seq`, con «manca un seq ⇒ vince
  il marcatore». **Verifica:** il caso Japan riprodotto — `openedAt` più recente ma
  `openedSeq` indietro: la pane cade **e il marcatore NON viene ritratto**, quindi
  la resurrezione non si propaga.
- [x] 1.4 La **riapertura legittima** sopravvive: un client che ha visto la chiusura
  (`openedSeq > mark.seq`) riapre davvero. **Verifica:** unit dedicato — NON il test
  a due dispositivi di `design.md §10`, che resta da scrivere (vedi P.1-P.5).
- [x] 1.5 `staleTombstoneRetraction.test.ts` riscritto sulla causalità (14 casi
  portati, 7 nuovi fra caso Japan e formato del filo); `multiClientResurrection` e
  `panes.test.ts` adeguati alla forma del marcatore. **Verifica:** ogni caso portato
  asserisce sul seq; nessuno asserisce più su un confronto di orologi.
- [x] 1.6 **Retrocompatibilità del filo** (non era nel piano, e senza di essa lo
  stadio 1 è una regressione): `tombstones` esce come mappa di numeri — la forma che
  il sanitizer precedente sa leggere — e il `seq` viaggia in `tombstoneSeqs`.
  **Verifica:** tre unit, incluso il giro completo uscita → sanitize → idratazione,
  e il caso «peer vecchio senza `tombstoneSeqs` ⇒ seq 0 ⇒ vince il marcatore».

## Stadio 2 — intenti e sostituzione (PANE-AUTH-01, PANE-AUTH-03)

### 2a. La coda (condizione non negoziabile #1)

- [ ] 2a.1 Coda di intenti persistente: `localStorage`, chiave **per origine** (il
  guscio Tauri e la web app LAN sono due origini e non devono condividerla), un solo
  leader che spedisce (riuso di `syncCrossTab`), TTL 24h, `iid` per idempotenza.
  **Verifica:** unit — due schede, un solo mittente; un intento sopravvive a un
  reload.
- [ ] 2a.2 La coda si svuota **solo** su `acked` esplicito. Un `rejected` NON svuota
  in silenzio: emerge come stato visibile. **Verifica:** unit sui tre esiti.
- [ ] 2a.3 Riapplicare i pendenti **dopo** ogni sostituzione, mai prima.
  **Verifica:** unit — `render = f(serverBase) ⊕ pendenti ⊕ locali`, in
  quest'ordine, con un caso in cui l'ordine inverso darebbe l'esito sbagliato.
- [ ] 2a.4 Il caso `pagehide`: la chiusura differita committata al teardown entra
  nella coda **prima** che i listener del server girino, o l'ordine di registrazione
  va invertito (`syncServer.ts:357-370` vs `App.tsx:242-245`). **Verifica:** chiudere
  una tab e chiudere subito la pagina — al boot successivo la tab è chiusa.
- [ ] 2a.5 `syncServer.ts:331-341`: alla chiusura del WS l'inflight viene abortito e
  il debounce azzerato **senza riarmarlo**. Con la coda questo smette di perdere
  dati, ma il riarmo va comunque messo. **Verifica:** una modifica fatta durante un
  reload del server (2 s) arriva alla riconnessione.

### 2b. Gli intenti

- [ ] 2b.1 Rotta `POST /api/panes/intents`: accetta un batch, risponde
  `{rev, acked[], rejected[{iid,reason,hint}], state}`. Il campo `state` è la stessa
  struttura del broadcast: la risposta **è** già la sostituzione.
  **Verifica:** integrazione sui tre esiti.
- [ ] 2b.2 Frame WS `pane:state` con `sourceClientId`; il riduttore lo applica come
  **sostituzione**. Cancellare il ramo di unione di `HYDRATE_FROM_SNAPSHOT`.
  **Verifica:** unit — nessun percorso residuo unisce.
- [ ] 2b.3 Portare il vocabolario: `pane.open/close/reopen/update/remap/move`,
  `group.reorder/split/resize`, `space.upsert/delete`, `closed.forget/clear`.
  `REORDER_PANES` si porta **così com'è** (già puro e commutativo). **Verifica:**
  ogni `PaneAction` di `types.ts:244-318` è mappata o dichiarata device-local.
- [ ] 2b.4 `FOCUS_PANE` e `SET_ACTIVE_SPACE` **non** producono traffico. Oggi lo
  fanno: `store.ts:94-95` incrementa `lastSeq` per ogni azione e
  `syncServer.ts:288-317` è sottoscritto a `lastSeq`. **Verifica:** cambiare fuoco
  cento volte → zero richieste di rete.
- [ ] 2b.5 I rifiuti sostituiscono le regole applicate su dati parziali:
  `topic_is_project_bound` (`usePanelLifecycle.ts:626-727`), `session_dead`
  (`:729-736`, il `200 []` che produce «Sessione scaduta» su terminali vivi),
  `id_taken` (`:1988-1991`), `singleton_exists`, `already_closed`. **Verifica:** per
  ognuno, l'effetto client corrispondente è **rimosso** e il comportamento è
  preservato dal rifiuto.

### 2c. L'ottimistica (condizione non negoziabile #2)

- [ ] 2c.1 Ogni intento si applica **localmente e in modo sincrono** prima di
  partire. `dispatch` resta sincrono. **Verifica:** i sei call-site di
  `design.md §5` continuano a leggere lo stato alla riga dopo, con un test per
  ciascuno — in particolare `promoteDraft`, che oggi fallirebbe in silenzio.
- [ ] 2c.2 Riconciliazione quando la sostituzione atterra: un intento confermato
  esce dalla coda senza sfarfallio; uno rifiutato viene **disfatto** visibilmente.
  **Verifica:** video del rifiuto — è comportamento, non stato.

### 2d. Il confine device-local (condizione non negoziabile #3)

- [ ] 2d.1 Dopo ogni sostituzione, **ri-risolvere** i puntatori device-local: se il
  fuoco punta a una pane che il server non ha più, si sposta; idem per lo Spazio
  attivo (questa ri-risoluzione **oggi non esiste** neanche adesso). **Verifica:**
  chiudere da un altro dispositivo la pane focussata qui → il fuoco si sposta, non
  resta dangling.
- [ ] 2d.2 **Assenza di record ≠ insieme vuoto.** La geometria
  (`topics-panel-grid-layout`) non esiste sul server e viene potata contro l'insieme
  delle pane (`usePanelGridPersistence.ts:86-110`); la sostituzione moltiplica i
  momenti in cui quell'insieme è transitoriamente vuoto, e qui non c'è copia da cui
  recuperare. La guardia di boot a `PanelGrid.tsx:343` va estesa a ogni
  sostituzione. **Verifica:** una sostituzione con insieme vuoto **non** distrugge
  il layout salvato.
- [ ] 2d.3 Le bozze (`draft:`) non vengono mai sostituite. Oggi sopravvivono grazie
  alla cattura/re-iniezione (`panes.ts:360-370`, `:584-607`), che **ricrea anche il
  gruppo** (`:594-603`) — senza, la bozza «sparisce da ogni tab bar mentre l'utente
  sta scrivendo». **Verifica:** una sostituzione durante la scrittura di una bozza la
  lascia intatta, gruppo compreso.

### 2e. Pulizia

- [ ] 2e.1 Cancellare `adapters/tombstoneSync.ts` (301 righe), la mappa
  `tombstones`, `retractStaleMarker`, e le sezioni di `sanitizeSnapshot.ts` che
  difendono le bozze **in entrata** (quelle in uscita restano).
- [ ] 2e.2 Correggere il commento a `selectors.ts:76-78`: dice «would evict hidden
  panes», falso dal commit `d8089483`. Il danno vero è la corruzione dell'ordine
  persistito. Una motivazione sbagliata su un invariante è peggio di nessuna.
- [ ] 2e.3 `server/services/ui-state-orphan-cleanup.ts`: le sue regole diventano
  rifiuti. **Verifica:** il servizio non cancella più nulla di sua iniziativa — è il
  precedente esploso citato in `design.md §9`, e non deve tornare.

## Stadio 3 — migrazione

- [ ] 3.1 381 tombstone → assenza di riga; per gli id ancora aperti, `closed_rev` =
  rev iniziale. **Verifica:** test della migration contro un DB sintetico, come
  `tests/integration/migration-071-*`.
- [ ] 3.2 `closedStack` (50) → catalogo del `pane.reopen` lato server, col **cursore**
  device-local. Oggi la pila è condivisa, ed è per questo che ⇧⌘T su un dispositivo
  consuma il record di un altro. **Verifica:** ⇧⌘T su A non consuma il record di B.
- [ ] 3.3 Compatibilità: il PUT su `pane-store-v2` resta accettato per una release,
  tradotto in intenti lato server. **Verifica:** un client alla versione precedente
  continua a funzionare e non corrompe lo stato.

## Prova di consegna

Il guasto vive **fra due dispositivi**; i test attuali coprono i reducer in
isolamento e non lo toccano. Il presidio è un test a due dispositivi
(`openTwoDevices` esiste già):

- [ ] P.1 A apre, B vede. A chiude, B **a freddo dopo riavvio** non vede.
- [ ] P.2 B con snapshot **antecedente** alla chiusura non resuscita — è il caso
  Japan, riprodotto come test.
- [ ] P.3 B riapre esplicitamente: A rivede. La riapertura legittima è viva.
- [ ] P.4 Chiusura durante una disconnessione del WS: applicata alla riconnessione.
- [ ] P.5 Video del rifiuto e della riconciliazione — è comportamento, non stato.

## Fuori scope → backlog

1. **Il commutatore di Spazio sul telefono: da stabilire, non è un fatto.**
   Rettifica di un'affermazione sbagliata scritta qui il 06/08 («a 393px il tap
   atterra su un altro elemento»): quella misura è stata presa con la sidebar
   COLLASSATA, e l'elemento che intercettava era una card della board, non un
   contenitore della sidebar. Non prova nessun difetto di hit-test.
   Ciò che è accertato: sotto i 768px la sidebar parte forzatamente collassata
   (`useSidebarAndLayout.ts:168-169`, che scavalca anche l'impostazione salvata),
   quindi «Gruppo 2» è `0×0` all'avvio; e l'apertura passa da un gesto di swipe
   dal bordo (`App.tsx:961`, `handleEdgeTouchStart`), che non si riproduce con
   eventi touch sintetici — due tentativi falliti, quindi **non so** se un dito
   vero apra la sidebar e raggiunga il commutatore. Va provato su un dispositivo
   prima di aprire un task di fix: il rischio è inseguire un difetto inesistente.
2. `task-browser-layout:<id>` e `sidebar-state`: stesso trasporto, stessa domanda,
   lavoro separato.
3. Un dispositivo nuovo atterra sullo Spazio di default e nessun pixel glielo dice —
   sul telefono la sidebar parte forzatamente collassata
   (`useSidebarAndLayout.ts:168-169`).
