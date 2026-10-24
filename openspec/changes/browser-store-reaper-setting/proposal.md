# browser-store-reaper-setting — la pulizia dei browser chiusi è un'impostazione di Topics, a due livelli

## Perché

#425 aggiusta il 404 di `/api/browsers/data-store-keep-list`. Da quel momento il reaper
(`client/src/lib/browserDataStoreReaper.ts`) gira per la prima volta e cancella gli store WKWebView
orfani fermi da 60 giorni: cookie, login, dati locali dei siti. Non si annulla. Attilio, approvando
#425: «Ok ma dovrebbe essere una impostazione però di topics».

Poi ha cambiato il disegno: cookie e cronologia servono per i login, quindi togliere lo store intero non
può essere il comportamento di chi non ha toccato niente. Le sue parole: «forse allora semplicemente
disabilitato di default? al massimo ne facciamo uno solo cache in modo da conservare cose utili».
Misura che lo sostiene (2026-08-12, 45 store veri): NetworkCache 1,65 GB su 2,32 GB, cookie 44 KB in
tutto. Lo spazio sta nella cache; l'identità costa un chilobyte a store.

## Cosa cambia

Due livelli, tre colonne di `app_settings` (migration `20261024120001-browser-store-reap.sql`, non è
ancora su main, quindi è stata riscritta; nessun dato riscritto, la riga guadagna tre NULL):

| Livello | Etichetta | Campo | NULL | Cosa toglie |
|---|---|---|---|---|
| 1 | «Svuota la cache dei browser chiusi» | `browserStoreCacheReapEnabled` | **acceso** | solo la cache degli store orfani e fermi; accessi, cookie, local storage restano |
| 2 | «Cancella anche accessi e cronologia» | `browserStoreReapEnabled` | **spento** | lo store intero (il comportamento di prima); vale solo con il livello 1 acceso |
| | «dopo N giorni senza uso» | `browserStoreReapAfterDays` | 60 | uguale per i due livelli, 7..365 |

- `shared/browser-store-reap.ts` risolve i valori in un modo: `off | cache | all`. `off` solo con il
  livello 1 a `false` esplicito; `all` solo con il livello 1 acceso E il livello 2 a `true` esplicito;
  tutto il resto è `cache`.
- Rust: un comando NUOVO, `browser_reap_store_caches(keep_ids, max_age_days) -> usize`. Sceglie gli
  stessi store di `browser_reap_data_stores` (`stale_store_uuids`: orfani E fermi, pavimento di 7
  giorni) e su macOS chiama `removeDataOfTypes:` con gli stessi quattro tipi cache di
  `browser_purge_cache` (la chiusura di una pane). Comando nuovo e non argomento di quello vecchio, di
  proposito: una shell vecchia ignora un argomento che non conosce e toglierebbe store interi, mentre
  davanti a un comando che non conosce fallisce, e il reaper non toglie niente. L'elenco dei tipi cache
  è una costante (`CACHE_DATA_TYPE_KEYS`), con un test puro: nessun tipo d'identità, solo chiavi note.
- Il reaper legge l'impostazione a ogni avvio, prima di tutto. `off`: niente keep list, niente comando.
  `cache`: solo il comando nuovo. `all`: solo `browser_reap_data_stores`. Se il comando nuovo lancia (shell
  vecchia) torna -1 e **non** ripiega mai sulla rimozione intera.
- Server: la GET/PUT salvano e restituiscono entrambi gli interruttori (true e false); 503 quando la riga
  non si legge, come prima.
- UI (Sistema → Prestazioni, sotto «Libera le pagine non viste…»): due righe, la seconda rientrata sotto
  la prima e disabilitata finché la prima è spenta (mostra comunque ciò che era stato scelto), poi la
  riga «dopo N giorni senza uso».

## Barra

`specs/acceptance.md`: i file di test verdi, i mutanti M1..M4 rossi, i cancelli statici a 0, la CI
verde sulle tre OS (`cargo check` e `cargo test --lib` girano su macOS, Windows, Linux). Ciò che è verde
resta verde.

## Fuori

- Il livello 1 fuori da macOS: su Windows e Linux uno store è una cartella per pane, ma la sua cache si
  svuota solo da una webview viva (WebView2 `ClearBrowsingData`, WebKitGTK `WebsiteDataManager`) e gli
  store di cui parla il reaper non ne hanno una. Il comando risponde `Ok(0)`: lì il livello 1 per ora non
  fa niente, dichiarato come buco (`ENGINES-GAP`) e fissato in `PINNED_GAPS`. Il livello 2 invece funziona
  ovunque, come prima.
- Un «pulisci adesso» manuale, un elenco degli store, un conteggio di cosa è stato tolto.
- Il browser condiviso (Playwright), che tiene i suoi dati altrove.
- Un e2e: dovrebbe fingere Tauri, e `__TAURI_INTERNALS__` manda tutto al server di produzione.
- Rimuovere o rinominare «cronologia» dall'etichetta del livello 2 (vedi Non ancora specificato).

## Deciso da

- **Attilio**: che la pulizia sia un'impostazione di Topics; che il default sia il livello che conserva
  i login; le due etichette in italiano; 60 giorni e il campo dei giorni dei due livelli.
- **Io (agente)**:
  - NULL del livello 1 = acceso, NULL del livello 2 = spento, con `=== true` e `!== false` esatti: una
    stringa, un numero o un campo assente non accendono mai la rimozione intera;
  - il livello 2 senza il livello 1 non rimuove niente (il pannello lo disabilita, il reaper lo ignora
    comunque: una riga scritta a mano può avere entrambi);
  - il comando nuovo e il fallimento senza ripiego (vedi sopra);
  - la costante dei tipi cache è condivisa con `browser_purge_cache` (stesso `empty_store_cache`), così
    la chiusura di una pane e il reaper togliono per costruzione gli stessi tipi;
  - il livello 1 fuori da macOS è un buco dichiarato e non un finto successo.

## Non ancora specificato

- **La cronologia del livello 2.** Le pagine visitate che Topics ricorda stanno nel `localStorage`
  dell'app (`browser-history-<topicId>` e `browserSiteHistory`), non nello store WebKit, e la lista
  avanti/indietro di una pane è in memoria e muore con la pane. Lo store che il livello 2 rimuove contiene
  cookie, local/session storage, IndexedDB e cache: nessun tipo cronologia (WebKit non ne ha). Quindi il
  livello 2 non toglie la cronologia che Topics tiene. L'etichetta resta quella di Attilio e la
  descrizione dice cosa va davvero; se debba anche azzerare la cronologia di Topics è una sua scelta.
