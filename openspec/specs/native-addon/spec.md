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

### Requirement: D3C-01 — lo status nativo coincide con git

`gitStatus(path)` gira su un thread asincrono e riproduce `git status --porcelain -z --branch`
(v1), `rev-parse --git-dir --show-toplevel` e `log -1 --format=%h|%H|%s|%an` su 30 repository
fixture. `native/parity.test.ts` confronta parser e addon con campi e ordine identici; salta solo
l'addon non costruito e i casi Windows non applicabili.

### Requirement: D3D-01 — `computeGitStatus` usa l'addon e mantiene il ripiego Git

Con l'addon caricato e l'impostazione attiva, `computeGitStatus` usa `gitStatus` nativo per radice,
branch, file e ultimo commit, poi avvia solo i due comandi numstat. Se l'addon è assente,
l'impostazione è spenta o la chiamata nativa fallisce, usa il percorso Git esistente. Il tempo
dell'autore nel modulo nativo alimenta una data relativa uguale a `%ar`. `GET /api/system/status`
espone `nativeGit` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`; l'impostazione è
salvata nella chiave server-sincronizzata `settings` e mostrata nel pannello Performance.

### Requirement: D3F-02 — la visita nativa è controllabile e ignora gli errori delle voci

`nativeFileTreeEnabled` è server-sincronizzata e attiva di default. `GET /api/system/status` espone
`nativeFileTree` con `loaded`, `enabled`, `calls`, `fallbacks` e `lastError`, e il pannello
Performance permette di cambiare il percorso nativo o JavaScript. L'assenza dell'addon aggiorna lo
stato senza log di avviso; un errore nativo vero aggiorna `lastError` e ripiega sul walker JavaScript.
Un errore su una voce salta quella voce e la visita prosegue; un errore sulla radice resta un errore.
