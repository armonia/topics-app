# Change: pane-store-server-authoritative

## Why

**Una tab chiusa il 23 luglio è ancora aperta su un telefono.** Misurato il
2026-08-06: la pane `project:/Users/utente/Pictures/Japan` ha un tombstone sul
server con `closedAt = 2026-07-23 20:22`, non è fra le pane aperte, non è in
`group:default`. Il desktop non la mostra — correttamente. Il telefono sì.

La regola che la tiene viva, `client/src/state/pane/reducers/panes.ts:561`:

```js
const openedAt = pane.openedAt;
if (typeof openedAt === 'number' && openedAt > state.tombstones[id]) {
  retractStaleMarker(state, id);   // ← il tombstone viene CANCELLATO
  tombstonedIds.delete(id);
  continue;                        // ← e la pane sopravvive
}
```

All'idratazione, una pane tombstonata sopravvive se il suo `openedAt` locale è più
recente del tombstone. La regola esiste per un caso vero — chiudi e riapri su un
altro client, e la ritrattazione non ti arriva mai — ma **confronta due orologi a
muro timbrati su macchine diverse**: `openedAt` viene stampato da chi apre
(`panes.ts:107`), `closedAt` da chi chiude, e il confronto avviene su una terza
macchina. Un dispositivo con uno snapshot vecchio di due settimane vince sempre
quel confronto.

E non è un difetto locale: `retractStaleMarker` **cancella il marker**. Quando quel
dispositivo rimanda su il suo stato, il tombstone sparisce dal server e la pane
torna anche sulle macchine che l'avevano chiusa. Non è «un dispositivo vede una
cosa in più»: è una resurrezione che si propaga all'indietro.

**Non è un incidente isolato, è il costo di un modello.** Da maggio: 82 commit
sulla sincronizzazione del pane-store, e **5 degli 11 file di test dei reducer
esistono solo per questa classe di guasto** — `multiClientResurrection`,
`pinnedChatResurrection`, `tombstoneResurrection`, `staleTombstoneRetraction`,
`spacesTombstone`. Più un adattatore intero, `adapters/tombstoneSync.ts`, 301
righe dedicate alle lapidi. Quando metà della superficie di test di un modulo
difende un meccanismo di fusione, il problema non sono i bug: è il modello.

**Perché la fusione c'era.** Comprava tre cose: avvio a caldo (dipingere prima che
il server risponda), modifiche offline, e scritture concorrenti da più client senza
lock. La seconda non esiste in questa app — senza server non ci sono chat,
terminali, agenti né board, quindi non c'è un offline da preservare. La terza il
server può serializzarla meglio di un merge cieco. Resta la prima, che è reale — ma
**non richiede autorità**. Il difetto non è la cache: è la cache che vota.

## What changes

Il server possiede **cosa esiste**; i client mandano **intenti**; idratare vuol dire
**sostituire**. Spariscono l'unione, la mappa dei tombstone, la ritrattazione e ogni
confronto fra orologi a muro. L'ordinamento diventa uno solo: un `rev` per scope,
allocato dal server.

**Il confine, che oggi è già tracciato bene e va preservato:**

| | Chi possiede | Cosa |
|---|---|---|
| **Cosa esiste** | **server, autorevole** | pane, gruppi, spazi, tab di progetto |
| **Dove stai guardando** | **dispositivo, mai sincronizzato** | pane focussata, Spazio attivo, scroll, geometria della griglia, cursore dell'undo |

Sincronizzare il secondo significherebbe che il telefono ti sposta la finestra sul
Mac. Resta device-local, come è oggi.

**Il lavoro è in tre stadi**, e l'ordine non è negoziabile: lo stadio 0 è un
prerequisito che l'indagine ha trovato, lo stadio 1 chiude il guasto misurato con
un raggio piccolo, lo stadio 2 è la sostituzione del modello.

### Stadio 0 — identità deterministica per le pane-vista di progetto

`client/src/components/Layout/hooks/useProjectChatSync.ts:326-335` lo dichiara:

> «Per-project singleton VIEW panes (git, files, dashboard, activity, browser, …)
> are created with `createPaneId(type)` and **NO key, i.e. a RANDOM uuid, so the
> same logical pane has a different id on each device**».

Confermato in `adapters/paneConfig.ts:102` (`${type}:${generateUUID()}`). Oggi la
difesa è un dedup **per tipo**, non per id. **Un server che possiede l'identità non
può possedere queste pane**: o impone l'id del peer — e allora la pane rimonta a
ogni tocco altrui — o si duplicano. Vanno rese deterministiche **prima**, non dopo.

### Stadio 1 — la causalità sostituisce gli orologi

Ogni pane chiusa porta il `rev` del server al momento della chiusura; ogni riapertura
porta il `rev` su cui è stata formulata. Il confronto `openedAt > closedAt` sparisce
e con lui la ritrattazione. **Questo stadio da solo chiude la classe di guasto
misurata**, con un raggio molto più piccolo dello stadio 2 — ed è la ragione per cui
è separato: se lo stadio 2 dovesse fermarsi, il guasto resta chiuso.

### Stadio 2 — intenti, e la fusione va via

Il vocabolario degli intenti esiste già: è `PaneAction` (`state/pane/types.ts:244-318`).
Quattordici membri sono già intenti puri. `pane.open`, `pane.close`, `pane.reopen`,
`pane.update`, `pane.remap`, `pane.move`, `group.reorder`, `group.split`,
`group.resize`, `space.upsert`, `space.delete`. `FOCUS_PANE` e `SET_ACTIVE_SPACE`
**non** sono intenti e non escono dal dispositivo — oggi armano comunque un PUT da
53 KB, perché `store.ts:94-95` incrementa `lastSeq` per ogni azione e
`syncServer.ts:288-317` è sottoscritto a `lastSeq`. Con gli intenti, cambiare fuoco
smette di produrre traffico.

Il server acquisisce la facoltà di **rifiutare**, che oggi non ha. Ogni rifiuto
sostituisce una regola che un client applica su dati parziali:

| `reason` | Sostituisce | Oggi |
|---|---|---|
| `topic_is_project_bound` | un client decide che una pane non deve esistere leggendo la sua mappa `topics` parziale | `usePanelLifecycle.ts:626-727` |
| `session_dead` | `pruneStaleTerminalPanes` su un roster incompleto — il `200 []` che produce «Sessione scaduta» su terminali vivi | `usePanelLifecycle.ts:729-736` |
| `already_closed` | il confronto `openedAt > tombstone` | `panes.ts:421-422`, `:561` |
| `id_taken` | il ramo collisione di `promoteDraft` | `usePanelLifecycle.ts:1988-1991` |
| `singleton_exists` | il dedup per tipo delle pane-vista | `useProjectChatSync.ts:326-336` |

## Le tre condizioni non negoziabili

Una verifica avversariale ha provato ad affondare il modello. **Non affonda, ma
queste tre cose lo affondano se non vengono progettate esplicitamente.** Sono
requisiti, non note.

**1. Lo snapshot locale non è una cache: è un buffer di riparazione.** Catena
verificata: al `pagehide` i listener del server (`syncServer.ts:357-370`, registrati
in `bootstrapPaneStore` prima di `createRoot`) girano **prima** del listener che
committa la chiusura differita (`App.tsx:242-245`, registrato al mount). Il server
riceve lo stato **pre-chiusura**; la rimozione esiste solo su disco locale. Oggi
guarisce al boot perché `hydrateFromLocalSnapshot` risemina `lastServerSeq` e il
frame del server con lo stesso seq viene scartato (`panes.ts:353`), poi il PUT
successivo ripara il server. **Con «sostituisci» quella strada muore e la tab chiusa
riappare al boot — lo stesso bug del 23 luglio, col segno invertito.** Serve una
**coda di intenti persistente**, riapplicata *dopo* ogni sostituzione e svuotata solo
su conferma. E non è un caso raro: `syncServer.ts:331-341` alla chiusura del WS
aborta l'inflight e azzera il debounce **senza riarmarlo**, quindi ogni modifica
fatta nei 500 ms di un reload del server non parte proprio — e `start-prod.sh`
produce 173 reload in un solo log.

**2. L'applicazione locale deve restare sincrona.** Sei call-site rileggono lo store
alla riga dopo il dispatch. Il peggiore è `promoteDraft`
(`usePanelLifecycle.ts:1974-1991`): la guardia di collisione rilegge subito dopo il
remap, e con un round-trip esce **sempre** — l'utente manda il primo messaggio e la
chat non si promuove mai, in silenzio. Gli altri: l'URL della tab browser che si
perde (`usePaneOrdering.ts:470`), browser **duplicati** (`:112-118`), tab che
appaiono e spariscono (`ensurePaneRegistered`), lo Spazio che si tira dietro la
finestra (`spaceHelpers.ts:99-111`), e ⇧⌘T che riapre due volte la stessa tab
(`useClosedTabs.ts:68-75`). «Intento puro senza scrittura locale» rompe il prodotto.

**3. Assenza di record ≠ insieme vuoto.** La geometria della griglia
(`topics-panel-grid-layout`) **non esiste sul server** — solo in localStorage — e
viene potata contro l'insieme delle pane (`usePanelGridPersistence.ts:86-110`), con
una guardia di boot messa lì proprio perché potare con l'insieme vuoto distrugge il
layout salvato. La sostituzione moltiplica i momenti in cui quell'insieme è
transitoriamente vuoto, e qui non c'è copia sul server da cui recuperare.

**Il precedente che rende tutto questo non teorico**:
`server/services/ui-state-orphan-cleanup.ts:48-58` è la stessa idea, già provata e
già esplosa — l'autorità del server sull'esistenza **cancellava a ogni boot le chat
aperte di ogni progetto**, e sotto watch a ogni salvataggio. La cura fu escludere
quelle chiavi dall'autorità del server. Questo lavoro ci rientra dentro, e deve
entrarci sapendolo.

## Impact

- **Specs (delta)**: `layout/` — AGGIUNTA `PANE-AUTH-01` (il server possiede cosa
  esiste; idratare sostituisce), `PANE-AUTH-02` (causalità per rev, mai per orologio),
  `PANE-AUTH-03` (coda di intenti persistente + applicazione ottimistica sincrona),
  `PANE-AUTH-04` (identità deterministica delle pane-vista di progetto).
  MODIFICATA `LAYOUT-01` per la persistenza.
- **Client**: `state/pane/reducers/panes.ts`, `sanitizeSnapshot.ts`,
  `adapters/tombstoneSync.ts` (cancellato), `middleware/syncServer.ts`,
  `middleware/syncWS.ts`, `middleware/persistLocal.ts`,
  `adapters/projectLayoutSync.ts`, `hooks/useProjectChatSync.ts`,
  `adapters/paneConfig.ts`.
- **Server**: nuova rotta intenti + `rev` per scope; `routes/ui-state.ts`;
  `services/ui-state-orphan-cleanup.ts` (le sue regole diventano rifiuti).
- **Test**: cancellati i 5 file della classe resurrezione; nuovi sulla coda degli
  intenti, sui rifiuti e sull'ordinamento per rev.
- **Migration**: sì — i 381 tombstone e il `closedStack` esistenti vanno tradotti.

## Out of scope

- **Il confine device-local.** Fuoco, Spazio attivo, scroll e geometria restano dove
  sono. Questa change non li tocca se non per ri-risolverli dopo una sostituzione.
- **`task-browser-layout:<id>` e `sidebar-state`**: stesso trasporto, lavoro separato.
- **Il commutatore di Spazio irraggiungibile sul telefono** (a 393px il tap sulla
  riga «Gruppo 2» atterra su un altro elemento): difetto reale, misurato lo stesso
  giorno, ma è di hit-test e non di sincronizzazione. Task a parte.

## Risks

1. **Non è una semplificazione netta, ed è disonesto venderla così.** Si cancella la
   macchina di fusione e si costruisce una coda di intenti persistente con
   applicazione ottimistica. La complessità si **sposta** dove è corretta; non
   sparisce. Quello che sparisce è una **classe di guasto**: la resurrezione
   silenziosa fra dispositivi.
2. **È il codice più caldo del client.** 11.160 righe in `state/pane`, e i sei
   call-site read-your-write sono nel flusso principale del prodotto.
3. **Lo stadio 0 può rivelarsi più grande del previsto**: rendere deterministici gli
   id delle pane-vista tocca la residenza (`residency/policy.ts:34` indicizza per
   `stableKey ?? id`) e le chiavi React di tre componenti. Un id che cambia = una
   WKWebView rimontata, cioè un processo da 155-637 MB buttato e ricreato.
4. **Nessuna rete di sicurezza automatica sul comportamento cross-device.** I test
   attuali coprono i reducer in isolamento; il guasto misurato vive fra due
   dispositivi. Serve un test a due dispositivi (`openTwoDevices` esiste già) che
   chiuda una pane su A e verifichi che non riappaia su B dopo un boot a freddo.
