# Brief: dossier su un concorrente di Topics

Leggi questo file per intero prima di cominciare. Se non riesci a leggerlo intero, fermati e scrivi
solo «BRIEF ILLEGGIBILE».

## Per chi scrivi

Il team di Topics vuole sapere, con prove, cosa fa meglio di noi ogni concorrente e cosa conviene
prendere. Il dossier finisce in un repository pubblico: deve essere vero, citato e legale.

Topics in breve, per poter confrontare:
- App desktop con guscio Tauri (Rust), che sul Mac usa WKWebView. Server Bun in TypeScript con
  SQLite, client React. Gira come servizio launchd sulla porta 3333.
- Organizza le conversazioni con Claude Code, Codex e Muse in «topic». Ogni topic ha chat, file,
  git, terminale PTY e un pannello browser.
- Il browser è un WKWebView nativo. Supporta il co-browse Mac↔iPad: l'iPad rispecchia il DOM della
  pagina del Mac. L'agente può pilotarlo con 15 tool.
- Ha una board kanban globale che lancia gli agenti da sola, ognuno nella sua worktree, con code,
  tentativi, review, land (merge) e publish.
- Si usa da iPad e telefono in LAN, senza cloud.
- Ha un server MCP per gli agenti.
- La chat parla con `claude -p` in stream-json. C'è anche un motore nativo, ma è fuori da questo
  studio.

## Come lavori

1. Repository open source o a sorgente disponibile: clona in `repos/<slug>` con
   `git clone --depth 1 <url> repos/<slug>`. Se il repo è enorme, usa un clone sparso
   (`--filter=blob:none --sparse`, poi `sparse-checkout set` sulle sole cartelle utili).
   Concorrente closed source (livello «documentazione»): niente clone. Leggi la documentazione
   ufficiale e il changelog con `curl -sL`, seguendo i link interni utili.
2. Leggi README, docs, manifest (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`) e il
   codice delle parti che contano per le sezioni sotto. Misura, non stimare:
   - righe per linguaggio, con `tokei` se c'è, altrimenti `git ls-files` più `wc -l`;
   - numero di file di test;
   - data dell'ultimo commit e delle ultime release (`gh release list -R <owner/repo> --limit 5`).
3. Problemi veri degli utenti: `gh issue list -R <owner/repo> --state all --limit 40 --search "<parole>"`.
   Cerca con parole come slow, memory, crash, lag, freeze, CPU, battery e browser. Cita i numeri
   delle issue.
4. Su GitHub solo lettura: niente issue, PR, commenti, stelle o fork. Non scrivere fuori da
   `dossiers/` e `repos/`: nemmeno in `/tmp`, che ti viene rifiutato. Le pagine scaricate di un
   concorrente closed source vanno in `repos/<slug>-doc/`.

## Regole sulle fonti (obbligatorie)

- Ogni affermazione che conta ha la sua fonte accanto, in una di queste forme:
  - `[codice: percorso/file.ts:120]`, verificata leggendo il file;
  - `[doc: URL]`;
  - `[README]`;
  - `[issue #N]`;
  - `[release vX.Y]`.
  Se non hai potuto verificarla, scrivi `[non verificato]`. Meglio un «non verificato» onesto che
  una fonte inventata.
- Per i link al codice usa l'SHA del clone: `https://github.com/<owner>/<repo>/blob/<sha>/<percorso>#L<riga>`.
  L'SHA lo dà `git -C repos/<slug> rev-parse HEAD`.
- Le citazioni testuali sono di 5 righe al massimo. Niente codice copiato oltre, perché alcune
  licenze (AGPL, BSL, Elastic) non lo permettono. Descrivi con parole tue.
- Niente dati di persone: nessun nome di contributore, handle, email o foto. Parla di progetti e
  organizzazioni.
- Prosa in italiano, identificatori e nomi di file come sono. Mai il trattino lungo: usa virgola,
  due punti o punto.
- Italiano scritto bene, con accenti e apostrofi veri: «è», «più», «perché», «già», «può», «l'agente»,
  «un'app». Mai la forma senza accenti («e» per «è», «piu», «l agente»): il dossier va in un repository
  pubblico e un testo così si scarta.

## Struttura del dossier (titoli esatti, in quest'ordine, tutti presenti)

```
# <Nome del concorrente>

## In tre righe
## Identità
## Architettura
## Sessioni e task
## Usabilità
## Browser e anteprima
## Terminale, editor, file
## Remoto e mobile
## Provider e protocolli
## Performance
## Affidabilità e qualità
## Sicurezza e privacy
## Estendibilità
## Da prendere per Topics
## Da evitare
## Fonti
```

Cosa mettere nelle sezioni:
- **In tre righe**: cos'è, per chi, e il suo punto più forte rispetto a Topics.
- **Identità**: repository, stelle, licenza, ultimo commit, cadenza delle release, maturità,
  piattaforme.
- **Architettura**: linguaggi con le righe misurate, framework (Tauri, Electron, web, TUI),
  modello dei processi, IPC, storage. Come parla con l'agente: Agent SDK, PTY, stream-json, ACP o
  altro. Se usa Rust o Go, dove e per cosa.
- **Sessioni e task**: sessioni parallele, worktree, code e kanban, tentativi, review, merge, PR e
  CI.
- **Usabilità**: superfici (desktop, web, mobile, TUI), flussi principali, diff e review,
  notifiche, scorciatoie, onboarding.
- **Browser e anteprima**: ha un browser o un'anteprima integrata? L'agente può pilotarla? C'è
  qualcosa di simile al co-browse fra dispositivi? Come è fatto?
- **Remoto e mobile**: accesso da telefono, relay, cifratura, LAN o cloud.
- **Provider e protocolli**: Claude Code, Codex, Gemini, OpenCode, ACP, MCP.
- **Performance**: avvio, memoria, rendering (liste virtualizzate, streaming), lavoro in
  background. Riporta benchmark dichiarati e lamentele nelle issue. Se usa Rust per la velocità,
  dove e con quale effetto.
- **Affidabilità e qualità**: test (numero di file), CI, recupero dopo un crash, persistenza delle
  sessioni, aggiornamenti.
- **Sicurezza e privacy**: come tratta token e OAuth (usa le credenziali di Claude Code in modo
  lecito?), sandbox, telemetria, porte esposte in rete.
- **Estendibilità**: MCP, plugin, hook, skill.
- **Da prendere per Topics**: da 3 a 10 idee concrete. Per ognuna: cosa, dove si vede (fonte) e
  perché conterebbe per Topics.
- **Da evitare**: anti-pattern, rischi, scelte che le issue mostrano sbagliate.
- **Fonti**: elenco dei link usati.

Lunghezza: da 150 a 350 righe. Se una sezione non si applica, scrivi una riga che dice perché.

## Fine

Scrivi il file `dossiers/<slug>.md` e, come ultima riga della risposta, `FATTO <slug>`.
