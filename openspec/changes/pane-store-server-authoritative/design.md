# Design: pane-store-server-authoritative

## 1. Il modello

```
        ┌─────────── COSA ESISTE — SERVER, AUTOREVOLE ────────────┐
        │  panes · groups · spaces                                │
        │  scope = 'app' | 'project:<hash>'                       │
        │  rev   = contatore PER SCOPE, allocato dal server        │
        │  chiuso = riga con closed_rev  (NON un marker esterno)   │
        └────────▲────────────────────────────────┬────────────────┘
                 │                                │
   POST /api/panes/intents            WS  pane:state { scope, rev,
   { cid, intents:[{iid, verb,             panes, groups, spaces,
                    baseRev, …}] }         sourceClientId }
                 │                         ⇒ SOSTITUZIONE, non unione
   ┌─────────────┴────────────────────────────────▼────────────────┐
   │                        UN CLIENT                               │
   │  ① coda pendenti — localStorage, per ORIGINE, TTL 24h          │
   │       append SINCRONO, poi invio                               │
   │  ② PROIEZIONE = serverBase ⊕ pendenti ⊕ locali(`draft:`)       │
   │       sostituito     riapplicati DOPO   mai sostituiti         │
   │  ③ overlay DOVE STAI GUARDANDO — fuoco · Spazio · scroll ·     │
   │       griglia · cursore undo → ri-risolti dopo ogni sostituz.  │
   └────────────────────────────────────────────────────────────────┘
```

Tre regole, e il resto discende:

1. **Nessun client spedisce mai uno stato.** Sparisce lo snapshot pieno in uscita
   (`selectors.ts:112-114`). Non esistendo più, non esiste più il clobber
   multi-client — che è la ragione per cui l'unione fu introdotta.
2. **La sostituzione arriva sempre PRIMA della riapplicazione dei pendenti.**
   `render = f(serverBase) ⊕ pendenti ⊕ locali`. Nessuna eccezione nel riduttore.
3. **Mai un confronto fra due orologi.** L'unico ordinamento è il `rev` di scope.

## 2. Il confine, campo per campo

**Server (cosa esiste)** — `panes[]` con id, kind, groupId, indice, attrs (title,
url, titleSource, projectPath, spaceId), `groups[]` con paneIds/splitAxis/splitRatio,
`spaces[]` con nome e ordine.

**Dispositivo (dove stai guardando)** — `focusedPaneId`, `activeSpaceId`,
`Pane.scrollOffset`, `topics-panel-grid-layout[:space]`, il cursore dell'undo.
Nessuno di questi entra nella struttura sostituita, e ognuno va **ri-risolto** contro
la proiezione dopo ogni sostituzione: se il fuoco puntava a una pane che il server
non ha più, va spostato, non lasciato dangling. Oggi questa ri-risoluzione per lo
Spazio attivo **non esiste già adesso**, ed è parte del lavoro.

## 3. La causalità che sostituisce gli orologi

Il guasto: `openedAt` è timbrato con `Date.now()` da chi apre (`panes.ts:107`),
`closedAt` da chi chiude, e il confronto avviene su una terza macchina
(`panes.ts:421-422`, `:561`).

Sostituzione: ogni riga chiusa porta `closed_rev`; ogni intento porta il `baseRev`
dello scope su cui è stato formulato. Il server rifiuta un `pane.open`/`pane.reopen`
il cui `baseRev` è **anteriore** al `closed_rev` della stessa pane: significa che
chi lo ha formulato non aveva ancora visto la chiusura. Un dispositivo dormiente per
due settimane porta un `baseRev` vecchio e **perde**, che è l'esito giusto e
l'opposto di oggi.

Riaprire resta possibile: basta che l'intento sia formulato **dopo** aver visto la
chiusura — cioè esattamente il caso reale che la ritrattazione difendeva, ora
espresso in modo verificabile invece che indovinato.

## 4. La coda degli intenti — perché è obbligatoria

Catena verificata, e non è un caso limite:

| passo | file:riga | fatto |
|---|---|---|
| a | `main.tsx:58` | `bootstrapPaneStore()` gira **prima** di `createRoot` |
| b | `syncServer.ts:357-370` | i listener `pagehide` del **server** si registrano lì → girano **per primi** |
| c | `App.tsx:242-245` | il listener che committa la chiusura differita (3 s) si registra al **mount** → gira **dopo** |
| d | `App.tsx:243-244` | `flushPendingActions()` → `CLOSE_PANE`, poi flush **solo su localStorage** |

Al `pagehide` il server riceve lo stato **pre-chiusura**. Oggi guarisce perché al
boot `hydrateFromLocalSnapshot` risemina `lastServerSeq` e il frame del server con
lo stesso seq viene scartato (`panes.ts:353`); poi il PUT successivo ripara il
server. **Con «sostituisci» quella strada muore.** Senza coda persistente, la tab
chiusa riappare al boot: il bug del 23 luglio col segno invertito.

Aggravante: `syncServer.ts:331-341` alla chiusura del WS aborta l'inflight e azzera
il debounce **senza riarmarlo** — ogni modifica nei 500 ms di un reload del server
non parte. `start-prod.sh` produce 173 reload in un log.

**Forma della coda**: `localStorage`, chiave per **origine** (il guscio Tauri e la
web app sulla LAN sono due origini diverse e non devono condividerla), un solo
leader che spedisce (riuso di `syncCrossTab`), TTL 24h, `iid` per idempotenza.
Svuotata **solo** su `acked` esplicito. Un `rejected` non svuota in silenzio: emerge.

## 5. Read-your-write: l'ottimistica non è un'ottimizzazione

Sei call-site rileggono lo store alla riga dopo il dispatch. Con un round-trip
puro si rompono così:

| call-site | file:riga | rottura |
|---|---|---|
| `promoteDraft` | `usePanelLifecycle.ts:1974-1991` | la guardia rilegge subito dopo il remap ed esce **sempre**: la bozza non diventa mai chat. Silenzioso (solo `console.warn`) |
| `persistBrowserPaneUrl` | `usePaneOrdering.ts:470,496,539` | `if (!pane) return` → no-op muto → la tab riapre su `about:blank` |
| `findGlobalBrowserPaneId` | `usePaneOrdering.ts:112-118` | la pane appena aperta è invisibile → si conia un secondo UUID → **browser duplicati** |
| `ensurePaneRegistered` | `usePanelLifecycle.ts:157-179` | `REORDER_PANES` filtra gli id senza entità, Effect A annulla → tab che appare, sparisce, riappare 600 ms dopo |
| `movePaneToSpace` | `spaceHelpers.ts:99-111` | `after` ha ancora il vecchio `spaceId` → il fuoco resta su una pane invisibile → la finestra torna nello Spazio di partenza, rompendo il contratto «la tab viaggia in silenzio» |
| `popClosedTab` | `useClosedTabs.ts:68-75` | due ⇧⌘T ravvicinate consumano lo stesso record → doppia POST `/api/terminal/sessions` |

Quindi: **ogni intento si applica localmente in modo sincrono**, entra nella coda, e
viene riconciliato quando la sostituzione atterra. `dispatch` resta sincrono; cambia
solo chi ha l'ultima parola.

## 6. Prerequisito: identità deterministica (stadio 0)

`useProjectChatSync.ts:326-335`, testuale: le pane-vista singleton di progetto
nascono con un **uuid random per dispositivo**, e la difesa odierna è un dedup **per
tipo**. Un server che possiede l'identità non può possedere pane la cui identità è
casuale: imporre l'id del peer farebbe **rimontare** la pane a ogni tocco altrui.

E rimontare non è gratis: `residency/policy.ts:34` indicizza per `stableKey ?? id`, e
`StandaloneChatGroup.tsx:334`, `GroupLayout.tsx:166`, `PaneTabBar.tsx:953` lo usano
come chiave React. Per una chat è il compositore perso; per un browser è un processo
WebContent da 155-637 MB buttato e ricreato.

Quindi: id derivati da `(projectPath, type)` **prima** dello stadio 2.

## 7. Migrazione

- **381 tombstone** → per ogni id tombstonato che non è fra le pane aperte: nessuna
  riga (è già l'assenza). Per gli id ancora aperti: `closed_rev` = rev iniziale,
  così l'assenza è espressa nello stesso vocabolario del resto.
- **`closedStack` (50)** → diventa il catalogo del `pane.reopen`, lato server, con
  il **cursore** dell'undo device-local. Oggi la pila è condivisa, e questo è il
  motivo per cui ⇧⌘T su un dispositivo consuma il record di un altro.
- **Client vecchio contro server nuovo**: il PUT su `pane-store-v2` resta accettato
  per una release, tradotto in intenti lato server e ribattuto come `pane:state`. Un
  client vecchio continua a funzionare degradato (nessun rifiuto, nessuna coda) ma
  non corrompe lo stato, perché la sua unione locale viene comunque sovrascritta dal
  broadcast successivo.

## 8. Cosa si cancella

`adapters/tombstoneSync.ts` (301 righe) · la mappa `tombstones` e
`retractStaleMarker` in `reducers/panes.ts` · il ramo di unione di
`HYDRATE_FROM_SNAPSHOT` · le sezioni di `sanitizeSnapshot.ts` che difendono le
bozze in entrata (restano solo quelle in uscita) · i test
`multiClientResurrection`, `pinnedChatResurrection`, `tombstoneResurrection`,
`staleTombstoneRetraction`, `spacesTombstone`.

**Non si cancella** `REORDER_PANES` (`reducers/groups.ts:29-52`): è già un intento
puro e commutativo, si porta così com'è. Nota: l'invariante che lo protegge è
documentata con la motivazione **sbagliata** — `selectors.ts:76-78` dice «would
evict hidden panes», falso dal commit `d8089483`; il danno vero è la corruzione
dell'ordine persistito. Da correggere nel commento mentre si è lì.

## 9. Precedenti nel repo, a favore e contro

**A favore**: `projectLayoutSync.ts:92-116` è **già** «sostituisci» in produzione,
sullo stesso trasporto, con l'azzeramento del cancello alla riconnessione (`:171`)
che al pane-store manca. E il ruolo di sola lettura (`bootstrap.ts:118-131`,
incidente del 20/07) è già un caso di autorità centralizzata che regge.

**Contro, e va guardato in faccia**: `server/services/ui-state-orphan-cleanup.ts:48-58`
è la stessa idea già esplosa — l'autorità del server sull'esistenza cancellava a ogni
boot le chat aperte di ogni progetto. La cura fu **escludere quelle chiavi
dall'autorità del server**. Questo lavoro ci rientra dentro. La differenza che deve
reggere: lì il server decideva l'esistenza da una vista parziale e **senza che
nessuno glielo avesse chiesto**; qui decide solo in risposta a un intento esplicito,
e ogni decisione negativa è un `rejected` visibile, non una cancellazione muta.

## 10. Prova di consegna

Il guasto vive **fra due dispositivi**, e nessun test attuale lo tocca: coprono i
reducer in isolamento. Il presidio nuovo è un test a due dispositivi
(`openTwoDevices` esiste già, `project_e2e-two-device-harness`):

1. A apre una pane, B la vede.
2. A la chiude. B, **a freddo dopo un riavvio**, non la vede.
3. B con uno snapshot locale **antecedente** alla chiusura non la resuscita — è il
   caso Japan, riprodotto.
4. B riapre esplicitamente: A la rivede. La riapertura legittima non è stata uccisa
   insieme alla resurrezione.
5. Chiusura durante una disconnessione del WS: alla riconnessione la chiusura è
   applicata, non persa (la coda).
