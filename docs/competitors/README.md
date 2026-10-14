# I concorrenti di Topics, studiati a fondo

**Data: 14 ottobre 2026.** I prodotti qui dentro cambiano ogni settimana: ogni riga vale quanto la
sua data.

Topics deve diventare il software principale del team per lavorare con gli agenti di codice. Per
esserlo deve andare meglio dell'app nativa di Claude Code e delle alternative open source. Questo
studio dice, con le prove, cosa fanno meglio gli altri, cosa conviene prendere e cosa evitare.

Le scelte che ne escono sono nel piano `openspec/changes/daily-driver/`.

## Cosa c'è

- **[`synthesis.md`](synthesis.md)**: la sintesi per asse (usabilità, gestione, sistema, core), la
  matrice delle funzioni, dove Topics è avanti e dove è indietro, le verifiche fatte a mano.
- **Un dossier per concorrente (31).** Tutti hanno le stesse 16 sezioni, dall'architettura alla
  sicurezza, fino a «Da prendere per Topics» e «Da evitare». L'elenco è qui sotto.
- **[`method/`](method/)**: il brief dato a ogni agente, l'elenco dei concorrenti e i due controlli
  automatici, per rifare lo studio con lo stesso metro.
  - I controlli girano in una cartella di lavoro con i dossier in `dossiers/` e i cloni in
    `repos/<slug>`.
  - I cloni non sono nel repository.

## Metodo

1. **La scelta.**
   - Le alternative open source all'app di Claude Code: app desktop e web che orchestrano agenti,
     gestori da terminale, accessi da telefono, visori di sessioni.
   - Come riferimento, quattro prodotti chiusi: l'app di Claude Code, l'app di Codex, Cursor e
     Conductor.
2. **Gli open source.** Per ognuno:
   - clone superficiale del repository, al commit scritto nel dossier;
   - lettura di README, manifest e codice delle parti che contano;
   - righe per linguaggio contate;
   - issue e release lette dall'API di GitHub, in sola lettura.
3. **I closed source.** Solo documentazione ufficiale e changelog.
4. **Scrittura.** Ogni dossier l'ha scritto un agente con lo stesso brief
   ([`method/BRIEF.md`](method/BRIEF.md)).
5. **Controlli automatici.**
   - [`method/check-dossier.sh`](method/check-dossier.sh): le 16 sezioni nell'ordine, da 150 a 400
     righe, almeno 15 fonti, niente trattino lungo né email, accenti italiani.
   - [`method/check-citazioni.py`](method/check-citazioni.py): ogni `[codice: percorso:riga]` esiste
     nel repository clonato, con la riga dentro il file.
6. **Verifiche a mano.** Le affermazioni su cui il piano si appoggia sono state riverificate alla
   fonte: l'elenco è in `synthesis.md`, sezione «Verifiche».

**Cosa i controlli non garantiscono.** Una citazione valida dice che la fonte esiste, non che dice
esattamente quello che il dossier le fa dire. Per questo le affermazioni che decidono qualcosa sono
state riverificate a mano, e quelle non verificabili sono marcate `[non verificato]` nel testo.

## Note legali

- **Testo.** Analisi originale, con i link alle fonti. Le citazioni testuali sono di 5 righe al
  massimo.
- **Codice.** Nessun codice copiato: alcune licenze (AGPL, BSL, Elastic) non ne permettono il riuso.
- **Dati personali.** Nessuno nel testo: niente nomi di contributori, handle o email. Si parla di
  progetti e organizzazioni; i link ai repository usano il loro percorso pubblico.
- **Interazioni.** Nessuna con i progetti studiati: niente issue, commenti, stelle o fork.
- **Marchi.** Appartengono ai rispettivi titolari.

## Studi precedenti

- `docs/coverage-vs-competitors.md` (06/09/2026): funzione per funzione contro quattro prodotti,
  dalla sola documentazione. Questo studio lo allarga a 31 e scende nel codice.
- `docs/browser-confronto-browser-veri.md` e `docs/chrome-devtools-mcp-vs-topics-browser.md`:
  confronti del browser di Topics con i browser veri e con Chrome DevTools MCP.

## I dossier

| Concorrente | Studiato su | In breve |
|---|---|---|
| [Vibe Kanban](vibe-kanban.md) | codice, a fondo | Vibe Kanban è un kanban per orchestrare agenti di coding in workspace paralleli, ognuno con branch, terminale e dev server propri. |
| [Emdash](emdash.md) | codice, a fondo | Emdash è un'app desktop open source che coordina CLI di coding agent in task e worktree Git. |
| [Jean](jean.md) | codice, a fondo | Jean è un ambiente desktop per pilotare agenti AI in parallelo, un worktree git per task, su laptop o server proprio. |
| [Conductor](conductor.md) | solo documentazione | Conductor è un'app Mac closed source che esegue in parallelo Claude Code, Codex, Cursor e OpenCode in workspace isolati, uno per branch, con diff viewer, Checks pre merge, PR e merge assistiti. |
| [Claude Code (app desktop e CLI)](claude-code-native.md) | solo documentazione | Claude Code è lo strumento di coding agentico di Anthropic: legge il codice, modifica file, esegue comandi e si integra con gli strumenti di sviluppo, su terminale, IDE, app desktop e web. |
| [opcode](opcode.md) | codice, a fondo | opcode è un'app desktop (Tauri 2 più React) che fa da centro di comando per Claude Code: progetti, sessioni, agenti personalizzati in background, checkpoint con timeline, usage analytics e gestione MCP, il tutto usando l |
| [Happy](happy.md) | codice, a fondo | Happy è un harness open source che orchestra Claude, Codex e altri agenti da telefono, con le sessioni avviate nel terminale e continuabili da mobile. |
| [Maestro](maestro.md) | codice, a fondo | Maestro è un'app desktop Electron che orchestra flotte di agenti di coding AI in parallelo, per power user che vivono di tastiera e gestiscono più progetti insieme. |
| [Superset](superset.md) | codice | Superset è un'app desktop che fa girare Claude Code, Codex e altri agenti CLI in workspace paralleli, ognuno con terminali, diff viewer e browser integrato. |
| [Agor](agor.md) | codice | Agor è un workspace web multiplayer dove team e agenti AI lavorano insieme su board spaziali live, con ogni attività ancorata a un branch git isolato dotato di ambiente e cronologia propri. |
| [OpenCode](opencode.md) | codice, a fondo | OpenCode è l'agente open source di coding più usato, si presenta come "The open source AI coding agent". |
| [Zed (pannello agenti)](zed.md) | codice, a fondo | Zed è un editor di codice nativo ad alte prestazioni con pannello agenti integrato. |
| [App di Codex (OpenAI)](codex-app.md) | solo documentazione | L'app di Codex, oggi evoluta nella ChatGPT desktop app, è il client desktop con cui OpenAI fa lavorare gli agenti Codex in thread paralleli organizzati per progetti, tra locale, worktree Git e cloud, con CLI, estensione  |
| [Cursor (agenti)](cursor.md) | solo documentazione | Cursor è un ambiente di sviluppo con agente di coding integrato, fatto di app desktop, CLI, web e mobile più agenti cloud che lavorano da soli su VM dedicate. |
| [Craft Agents](craft-agents.md) | codice, a fondo | Craft Agents è un'app desktop Electron con server Bun che fa da guscio multi provider per sessioni agentiche parallele, orientata ai documenti più che al codice. |
| [AionUi](aionui.md) | codice, a fondo | AionUi è un'app desktop open source che fa da guscio unificato a molti agenti CLI esterni, come Claude Code, Codex e Gemini, parlando con loro in ACP, e include anche un agente integrato a configurazione zero. |
| [CloudCLI](cloudcli.md) | codice, a fondo | CloudCLI (già Claude Code UI) è un'interfaccia web e desktop per pilotare da ovunque le sessioni di Claude Code, Codex, Cursor CLI e OpenCode. |
| [HAPI](hapi.md) | codice, a fondo | HAPI è un'alternativa locale e open source a Happy: avvolge gli agenti già installati (Claude Code, Codex, Cursor e altri) e li rende pilotabili da telefono, web o Telegram senza perdere la sessione nel terminale. |
| [Omnara](omnara.md) | codice, a fondo | Omnara è una piattaforma open source per eseguire agenti IA come servizio: si definisce un agente in YAML, lo si lancia da API, CLI o dashboard, e i worker lo eseguono su sandbox o su macchine proprie con stato durevole. |
| [Claude Squad](claude-squad.md) | codice | Claude Squad è un'app da terminale che avvia più agenti di coding in parallelo, uno per sessione tmux e uno per worktree git isolato. |
| [Companion](companion.md) | codice | Companion, nome prodotto companions.build, è un sistema web open source per collaboratori IA persistenti, ognuno con un proprio computer cloud, chat durevole, routine e deleghe tra agenti. |
| [HolyClaude](holyclaude.md) | codice | HolyClaude è una workstation AI containerizzata: un'immagine Docker che impacchetta Claude Code, altri 7 CLI agentici, una web UI e un browser headless già configurati, con un solo `docker compose up`. |
| [CCManager](ccmanager.md) | codice | CCManager è una TUI da terminale che gestisce sessioni parallele di agenti di codice (Claude Code, Gemini, Codex, OpenCode e altri) sopra git worktree e più progetti. |
| [Agent Deck](agent-deck.md) | codice | Agent Deck è un centro di comando da terminale per flotte di agenti di coding: una sola TUI mostra tutte le sessioni attive su più progetti e tool, con gruppi, fork, worktree e costi. |
| [Claude Code Viewer](claude-code-viewer.md) | codice | È un client web self-hosted per avviare, seguire e consultare sessioni di Claude Code, con i log sul computer che ospita il server. |
| [Swttch](swttch.md) | codice | Swttch è un pannello GUI per la CLI di Claude Code dentro gli IDE JetBrains, con la stessa UX dell'estensione per Cursor e VS Code. |
| [OpenCockpit](opencockpit.md) | codice | OpenCockpit è una postazione di lavoro web per sviluppatori che usano Claude Code e altri motori nello stesso ciclo di sviluppo: chat multi progetto, terminale, database e browser pilotabili dall'agente, tutto in locale. |
| [OpenHands](openhands.md) | codice | OpenHands Agent Canvas è il centro di controllo self-hosted per agenti di coding. |
| [Goose](goose.md) | codice | goose è un agente AI generalista open source che gira sulla macchina dell'utente, con app desktop, CLI e API per codice, ricerca, scrittura e automazione. |
| [OpenWork](openwork.md) | codice | OpenWork è un'app desktop per macOS, Windows e Linux dove agenti AI lavorano sui file locali, costruita sopra OpenCode e con qualsiasi modello. |
| [CodePilot](codepilot.md) | codice | È un client desktop multipiattaforma per agenti di codice, con chat, Git, terminale e provider diversi. |
