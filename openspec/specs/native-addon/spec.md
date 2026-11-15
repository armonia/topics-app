# native-addon Specification

## Purpose

Il server legge lo stato Git e visita l'albero dei file con un modulo N-API
scritto in Rust, con il ripiego JavaScript sempre pronto. Nato nel piano
`daily-driver` (traccia D3), archiviato il 23/10/2026. La freschezza dello
stato Git misurata dal banco sta in `git-freshness`.

## Requirements

### Requirement: D3B-01 — il modulo N-API si carica nel server compilato

Il server compilato carica il modulo N-API incorporato e stampa versione e commit di HEAD con
`--native-selftest`. `server/lib/native-addon.test.ts` copre anche il modulo assente, un repository
normale, una worktree collegata e una cartella non Git.

#### Scenario: il modulo incorporato risponde nel server compilato
- **GIVEN** il server compilato con il modulo N-API incorporato
- **WHEN** parte con `--native-selftest`
- **THEN** stampa la versione del modulo e il commit di HEAD

#### Scenario: il modulo assente non rompe il caricamento
- **GIVEN** un percorso del modulo nativo che non esiste
- **WHEN** il server prova a caricarlo
- **THEN** il caricamento restituisce `null`

#### Scenario: il modulo costruito risolve HEAD e lo status per tre forme di cartella
- **GIVEN** il modulo costruito e, in cartelle temporanee, un repository normale, una worktree collegata e una cartella non Git
- **WHEN** il test chiede HEAD e lo status al modulo
- **THEN** per il repository normale e per la worktree collegata HEAD è quello di `git rev-parse HEAD`, e lo status del repository ne riporta la radice
- **AND** per la cartella non Git HEAD e status sono `null`

### Requirement: D3C-01 — lo status nativo coincide con git

`gitStatus(path)` gira su un thread asincrono e riproduce `git status --porcelain -z --branch`
(v1), `rev-parse --git-dir --show-toplevel` e `log -1 --format=%h|%H|%s|%an` su 30 repository
fixture. `native/parity.test.ts` confronta parser e addon con campi e ordine identici; salta solo
l'addon non costruito e i casi Windows non applicabili.

#### Scenario: l'addon e il parser riproducono lo stesso status di git
- **GIVEN** uno dei 30 repository fixture (pulito, modificato, in conflitto, con rename, worktree collegata, HEAD staccato, branch non nato e altri)
- **WHEN** `gitStatus(path)` nativo e il parser dell'output di `git status --porcelain -z --branch` (v1), `rev-parse --git-dir --show-toplevel` e `log -1 --format=%h|%H|%s|%an` leggono lo stesso repository
- **THEN** i due risultati hanno gli stessi campi nello stesso ordine

#### Scenario: la parità si salta solo dove non è applicabile
- **GIVEN** l'addon non costruito, oppure un caso fixture che richiede una capacità che Windows non ha
- **WHEN** gira `native/parity.test.ts`
- **THEN** saltano soltanto i casi interessati da quel motivo e nessun altro

### Requirement: D3D-01 — `computeGitStatus` usa l'addon e mantiene il ripiego Git

Con l'addon caricato e l'impostazione attiva, `computeGitStatus` usa `gitStatus` nativo per radice,
branch, file e ultimo commit, poi avvia solo i due comandi numstat. Se l'addon è assente,
l'impostazione è spenta o la chiamata nativa fallisce, usa il percorso Git esistente. Il tempo
dell'autore nel modulo nativo alimenta una data relativa uguale a `%ar`. `GET /api/system/status`
espone `nativeGit` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`; l'impostazione è
salvata nella chiave server-sincronizzata `settings` e mostrata nel pannello Performance.

#### Scenario: con l'addon attivo lo stato non lancia i comandi Git di lettura
- **GIVEN** l'addon caricato e l'impostazione attiva
- **WHEN** `computeGitStatus` calcola lo stato di un repository
- **THEN** radice, branch, file e ultimo commit vengono da `gitStatus` nativo, senza i comandi Git che li leggevano, e al più partono i due comandi numstat
- **AND** il risultato è uguale a quello del percorso Git

#### Scenario: senza addon, a impostazione spenta o a chiamata fallita si usa Git
- **GIVEN** l'addon assente, oppure l'impostazione spenta, oppure una chiamata nativa che fallisce
- **WHEN** `computeGitStatus` calcola lo stato
- **THEN** usa il percorso Git esistente e restituisce lo stato

#### Scenario: la data relativa nativa è uguale a `%ar`
- **GIVEN** il tempo dell'autore dell'ultimo commit restituito dal modulo nativo
- **WHEN** si calcola la data relativa
- **THEN** è uguale a quella di `%ar` di Git

#### Scenario: lo stato nativo è esposto e l'impostazione si cambia dal pannello Performance
- **GIVEN** il pannello Performance aperto
- **WHEN** l'utente cambia l'impostazione dello stato Git nativo
- **THEN** la scelta è salvata nella chiave server-sincronizzata `settings` e resta dopo il ricarico
- **AND** `GET /api/system/status` espone `nativeGit` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`

### Requirement: D3F-02 — la visita nativa è controllabile e ignora gli errori delle voci

`nativeFileTreeEnabled` è server-sincronizzata e attiva di default. `GET /api/system/status` espone
`nativeFileTree` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`, e il pannello
Performance permette di cambiare il percorso nativo o JavaScript. L'assenza dell'addon aggiorna lo
stato senza log di avviso; un errore nativo vero aggiorna `lastError` e ripiega sul walker JavaScript.
Un errore su una voce salta quella voce e la visita prosegue; un errore sulla radice resta un errore.

#### Scenario: l'interruttore sceglie il percorso e `/api/system/status` mostra i contatori
- **GIVEN** `nativeFileTreeEnabled`, server-sincronizzata e attiva di default
- **WHEN** è spenta o accesa e la visita dell'albero parte
- **THEN** la visita segue il percorso JavaScript o quello nativo scelto
- **AND** `GET /api/system/status` espone `nativeFileTree` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`

#### Scenario: l'addon assente aggiorna lo stato senza avvisi
- **GIVEN** l'addon non caricato
- **WHEN** parte una visita dell'albero
- **THEN** il contatore dei ripieghi sale e nessun avviso finisce nel log

#### Scenario: un errore nativo vero ripiega sul walker JavaScript
- **GIVEN** una chiamata nativa che fallisce con un errore vero
- **WHEN** parte la visita dell'albero
- **THEN** `lastError` riporta l'errore e l'albero è restituito dal walker JavaScript

#### Scenario: un errore su una voce non ferma la visita
- **GIVEN** una cartella che non si può leggere dentro l'albero
- **WHEN** la visita nativa incontra quella voce
- **THEN** salta la voce e prosegue, con lo stesso risultato della visita JavaScript

#### Scenario: un errore sulla radice resta un errore
- **GIVEN** una radice che non esiste
- **WHEN** parte la visita nativa
- **THEN** la visita fallisce con un errore
