# D3 · Rust dove la misura lo chiede: git e la visita dei file senza processi

Regole comuni: `tracks/_comuni.md`. Dipende da D1. **Si apre solo se passa il cancello d'ingresso
qui sotto.**

**GOAL.** Lo stato git e l'albero dei file si calcolano dentro il server, senza lanciare processi,
così la freschezza non dipende da quanto è carica la macchina.

## Perché qui e non altrove

Il server lancia `git` per tutto: stato (cinque spawn), diff, numstat, fetch. Con la macchina sotto
pressione (load 110, swap pieno, 14/10) uno spawn di `git/status` è arrivato a 12,6 s.

D1 toglie gli spawn dalle **letture**. Restano quelli del **ricalcolo** dopo ogni cambio, e quella è
la freschezza che l'utente vede: il file salvato che compare nel pannello git.

`gix` (git in Rust) toglie fork ed exec e legge l'indice una volta. `ignore`, il cuore di ripgrep,
fa la visita dell'albero in parallelo rispettando `.gitignore`.

**Dove Rust no:**
- **La UI React:** il costo è cosa si rende (D2).
- **La logica del server in Bun:** riscriverla costerebbe mesi per guadagni che nessuna misura
  mostra.
- **Il mirror del co-browse:** prima si misura, e oggi il costo è la banda, non il calcolo.
- **Il PTY:** il bridge in Rust esiste già (`desktop-tauri/pty-bridge`, `portable-pty`) e lo usa
  l'app installata. Il server del Mac, che gira dal checkout, usa ancora quello in Node
  (`server/pty-bridge.mjs`), quindi chi sviluppa non prova il binario degli utenti. Qui si fa solo
  questo: il server dal checkout usa il bridge Rust.

## Cancello d'ingresso

La traccia parte se, dopo D1, è vera almeno una delle due:
- la freschezza (file salvato → stato git aggiornato nel client) ha p95 > 150 ms con la CPU
  saturata da 8 processi;
- il ricalcolo lancia più di 1.000 processi `git` l'ora in uso normale.

Si misura con gli script di D0. Se nessuna delle due è vera, la traccia si chiude con il numero e
il motivo.

## Come

- **Addon Node-API scritto con napi-rs** (`native/`), caricato dal server Bun. Le chiamate girano sui
  thread del pool, non sul loop.
- **Se l'addon non si carica** (piattaforma senza binario), si torna al percorso con `git` da riga di
  comando, che resta.
- **Alternativa, se il primo passo fallisce:** un sidecar Rust con protocollo a righe JSON su socket
  Unix, come il bridge PTY.

## Passi

1. **Prova di fattibilità, un giorno.**
   - Condizione: l'addon si carica dentro il binario di `scripts/build-server-sidecar.sh`
     (`bun build --compile`) su macOS universale, Linux e Windows, nel job `tauri` della CI.
   - Se non si carica, la traccia passa all'alternativa e lo scrive.
2. **Parità.** `gitStatus(path)` con `gix` contro `git status --porcelain=v2 -z --branch` su 30 repo
   fixture: rinomine, submodule, sparse checkout, worktree, conflitti, file ignorati, LFS. Il
   formato normalizzato deve essere uguale.
3. **Collegamento.** `computeGitStatus` usa l'addon; numstat subito dopo.
4. **Visita dei file.** `walkFileTree` con `ignore`.
5. **Bridge PTY.** Il server dal checkout usa il bridge Rust.

## Barra

```bash
bun test native/parity.test.ts               # 30/30 repo fixture uguali a git
```

- **Mutazione.** Nell'adapter si invertono staged e unstaged: la parità deve fallire.
- **Freschezza.** p95 ≤ 150 ms con 8 processi che saturano la CPU, misurata con lo script di D0.
- **Spawn.** Con il contatore di D1, 0 spawn di `git` per un ricalcolo dello stato.
- **CI.** Il job `tauri` è verde su tre sistemi operativi con l'addon dentro il binario.
- **Terminali.** `ps` sul Mac mostra il bridge Rust e nessun `node pty-bridge.mjs`, e gli e2e dei
  terminali sono verdi.
