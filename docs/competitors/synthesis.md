# Sintesi: Topics e 31 concorrenti

**Data: 14 ottobre 2026.** Fonti: i 31 dossier di questa cartella, il codice di Topics a
`origin/main` dello stesso giorno, le misure di produzione e l'audit del browser riportati nel piano
`openspec/changes/daily-driver/`.

## In breve

1. **Nessuno dei 31 ha il co-browse fra dispositivi.**
   - È la differenza di Topics: il Mac tiene la pagina, l'iPad la rispecchia e la può pilotare.
   - L'audit del 14/10 dice però che oggi non regge le pagine vere: il primo frame pesa da 2,1 a
     4,8 MB contro un limite di 1 MiB del socket (piano, traccia D4).
2. **Il metro resta l'app di Claude Code.** Ha:
   - sessioni parallele con worktree;
   - il pannello Browser che verifica da solo dopo ogni modifica;
   - Remote Control e l'app mobile;
   - il monitoraggio delle PR con la CI;
   - hook, skill e plugin;
   - una release quasi ogni giorno.
3. **Cosa hanno gli altri e Topics no:**
   - automazioni a calendario, in 17 concorrenti su 31, compresa l'app di Claude Code;
   - commenti sul diff mandati all'agente;
   - worktree pronte, con script e porte;
   - CI prima del merge;
   - selettore di elemento per l'agente;
   - budget di performance dichiarati.
4. **Gli errori da non ripetere sono quasi tutti di performance:**
   - tempeste di processi `git` e watcher su tutto;
   - bundle enormi;
   - memoria senza tetto;
   - processi orfani.

   Topics ne ha versioni sue, misurate: piano, tracce D1 e D2.
5. **Dove Topics è avanti:**
   - la board globale che lancia gli agenti da sola, con code, tentativi, review, land e publish;
   - il co-browse;
   - il server MCP per gli agenti;
   - l'uso da iPad in LAN senza cloud;
   - i provider: Claude Code, Codex, Muse, ACP e compatibili OpenAI.

## Le famiglie

| Famiglia | Concorrenti | Cosa li accomuna |
|---|---|---|
| Orchestratori desktop con worktree | Conductor, Superset, Emdash, Jean, Vibe Kanban, Maestro, Craft Agents, AionUi, CodePilot, OpenWork, CloudCLI, opcode | una worktree per sessione, diff, spesso un'anteprima. Quasi tutti su Electron; Jean, Vibe Kanban e opcode su Tauri |
| Il telefono prima di tutto | Happy, HAPI, Omnara, Companion, HolyClaude, Claude Code Viewer | relay o tunnel, app o PWA, notifiche; il lavoro resta sulla macchina dell'utente o in una sandbox |
| Gestori da terminale | Claude Squad, CCManager, Agent Deck | tmux o PTY, leggerezza, nessun browser |
| Editor e agenti generalisti | Zed, OpenHands, Goose, OpenCode, OpenCockpit, Swttch | ACP o un server unico per più client |
| Riferimenti chiusi | app di Claude Code, app di Codex, Cursor, Conductor | ciclo completo da prompt a PR, cloud, mobile |

## La matrice delle funzioni

Ogni cella viene dal dossier del concorrente: «?» vuol dire che il dossier non lo dice, non che manca.
La riga di Topics è verificata nel codice del 14/10.

### Gestione e usabilità

| Concorrente | Superfici | Worktree per sessione | Board o coda | Commenti diff | PR/CI/merge in app | Preview/browser | Agente pilota browser | Co-browse | Telefono | Checkpoint/rewind |
|---|---|---|---|---|---|---|---|---|---|---|
| **Topics** | desktop (Mac, Windows, Linux), web, iPad e telefono in LAN | sì, sulla board | kanban globale con dispatcher | no | land e automerge in locale, la CI non entra | WKWebView nativo e Chromium | sì, 16 tool | **sì, Mac↔iPad** | sì in LAN, relay in corso | sì, con rollback |
| vibe-kanban | Desktop, web, VS Code | sì | Kanban | sì | PR da UI | iframe | no | no | Web remoto | ? |
| emdash | Desktop (macOS, Windows, Linux), host SSH | sì, per task | lista di task, non board | ? | stato PR nella lista | webview per task, anteprima di localhost | non verificato | no | no | ? |
| jean | Desktop, web, mobile | sì | Nessuna board | ? | PR e merge | Browser integrato | sì | no | sì | sì |
| conductor | Mac, iOS, web | sì | Coda messaggi | sì | PR/CI/merge | sì | no | no | sì | sì |
| claude-code-native | CLI, desktop, web, mobile | sì | Lista agenti | sì | sì | Browser integrato | sì | no | sì | sì, `/rewind` |
| opcode | Desktop, web | no | no | ? | no | iframe | no | no | parziale | sì |
| happy | Mobile, web, CLI | no | no | ? | no | no | no | no | sì | ? |
| maestro | Desktop, web, CLI | sì | Coda Auto Run | ? | PR/CI esterna | sì | sì | no | PWA | ? |
| superset | Desktop, web, iOS | sì | API task | sì | Merge PR | sì | sì | no | sì | ? |
| agor | Web, mobile, CLI | Per branch | Kanban | ? | PR metadati | URL esterno | no | no | sì | ? |
| opencode | TUI, desktop, web | sì | no | ? | no | Plugin browser | sì | no | PWA | ? |
| zed | Desktop | Parziale | no | ? | no | Preview Markdown | no | no | no | ? |
| codex-app | Desktop, web, mobile | Per thread | Progetti/thread | sì | sì | Browser integrato | sì | no | sì | ? |
| cursor | Desktop, web, mobile | ? | Inbox | ? | PR/CI/merge | sì | sì | no | sì | Locale |
| craft-agents | Desktop, web, CLI | no | Workflow/inbox | ? | Via Bash | sì | sì | no | ? | ? |
| aionui | Desktop, web, mobile | ? | Coda comandi | ? | ? | Browser/preview | sì | no | sì | ? |
| cloudcli | Desktop, web | sì | no | ? | PR/merge | Playwright | sì | no | Web/LAN | ? |
| hapi | CLI, web, mobile | Parziale | no | ? | no | no | no | no | sì | ? |
| omnara | Web, CLI | no | no | no | no | no | Esempio Chrome | no | no | ? |
| claude-squad | TUI | Per sessione | no | ? | Push branch | no | no | no | no | ? |
| companion | Desktop, web, mobile | no | Coda background | ? | no | Box desktop | ? | no | sì | ? |
| holyclaude | Web, SSH | no | no | ? | GitHub manuale | Headless/preview | sì | no | sì | ? |
| ccmanager | TUI | Per sessione | no | ? | Merge worktree | no | no | no | no | ? |
| agent-deck | TUI, CLI, web | Per sessione | no | ? | Merge via CLI | no | no | no | Via conductor | ? |
| claude-code-viewer | Web, PWA sul telefono | no | task nativi di Claude Code, scheduler | sì | commit e push | iframe in sandbox | no | no | sì, PWA e push | ? |
| swttch | JetBrains, web | no | no | ? | no | no | no | no | Web remoto | ? |
| opencockpit | Web/LAN | ? | Task schedulati | sì | no | Browser integrato | sì | no | sì | Snapshot locali |
| openhands | Web, Electron | sì | Automazioni | ? | ? | Browser osservato | sì | no | Parziale | ? |
| goose | Desktop, CLI | Parziale | Scheduler | ? | ? | no | no | no | no | ? |
| openwork | Desktop, web | ? | Automazioni | ? | no | Browser integrato | sì | no | ? | ? |
| codepilot | Desktop (macOS, Windows, Linux) | sì, dal pannello | task a calendario, nessuna board | ? | commit e push; PR non documentate | browser Electron, anteprima file | no | no | via bridge di messaggistica | sì, rewind per messaggio |

### Sistema e core

| Concorrente | Licenza | Guscio | Rust/Go e dove | Interfaccia agente | Provider | Relay E2E | MCP/plugin | Costi/uso | File di test | Ultimo commit/release |
|---|---|---|---|---|---|---|---|---|---|---|
| **Topics** | MIT | Tauri (WKWebView sul Mac) | Rust nel guscio e nel bridge PTY | stream-json, ACP, `codex exec` | Claude Code, Codex, Muse, Gemini via ACP, compatibili OpenAI | in corso (`relay`) | server MCP proprio, MCP degli agenti | sì, per progetto | 2.420 | v2.2.501 · 14/10 |
| vibe-kanban | Apache-2.0 | Tauri + web | Rust backend | CLI + ACP | 10 CLI | ? | MCP server | ? | ≈10 test | d5cbb53 · v0.1.44 |
| emdash | Apache-2.0 | Electron | No Rust/Go | ACP e PTY | 37 provider, 23 con ACP | no | MCP per provider, skill, script | ? | 1.251 test/spec | v1.2.8 · ottobre |
| jean | Apache-2.0 | Tauri + web | Rust core | stream-json/ACP | 9 CLI | ? | MCP + estensioni | Costi provider | 443 + 13 E2E | v1.0.11 · 14/10 |
| conductor | Proprietaria | Mac/web/iOS | ? | Harness | 4 agenti | ? | MCP server | Pro/Teams | ? | v0.90.0 · 02/10 |
| claude-code-native | Closed source | TUI + app | ? | CLI/SDK | Anthropic + cloud | ? | MCP/plugin/skill | ? | ? | v2.1.299 · 14/10 |
| opcode | AGPL-3.0 | Tauri + web | Rust backend | stream-json | Claude Code | ? | MCP + hook | Token/costi JSONL | pochi, in `claude.rs` | d1ca30a · v0.2.0 |
| happy | MIT | Expo + CLI | No Rust/Go | CLI/ACP | 6 provider | sì | MCP + skill | Uso per sessione | 311 test/spec | cli-1.2.5 · 22/09 |
| maestro | AGPL-3.0 | Electron + web | No Rust/Go | stream-json/CLI | Claude/Codex/OpenCode | no | MCP + plugin | Costo per sessione | 2045 test + 9 E2E | v1.0.0 · 09/10 |
| superset | Elastic 2.0 | Electron + web | No Rust/Go | PTY/ACP | 20+ agenti | no | MCP + plugin | ? | 1320 + 13 PTY | v1.38.0 · 14/10 |
| agor | BSL 1.1 | Web + daemon | No; Node | SDK/CLI | 6 provider | no | MCP gateway | Token per prompt | 1555 test/spec | eee0108 · 14/10 |
| opencode | MIT | Electron + TUI | TypeScript/Bun | In-process/PTY | 48 provider | ? | MCP + plugin | ? | 1183 test/spec | v1.19.0 · 11/10 |
| zed | GPL-3.0+/Apache-2.0 | Nativo GPUI | Rust editor/agenti | ACP stdio | Agenti ACP | ? | MCP + API | Uso modello | Pochi + E2E | e463c5a · 14/10 |
| codex-app | Licenza ? | Desktop + web | ? | App Server JSON-RPC | OpenAI | ? | MCP + plugin | Piani/limiti | ? | CLI v0.162.1 · 09/10 |
| cursor | Licenza ? | Desktop + web | ? | Tool calling/ACP | 6 modelli | ? | MCP + plugin | Prezzi a consumo | ? | changelog attivo |
| craft-agents | Apache-2.0 | Electron + web | TypeScript/Bun | Claude SDK/Pi | Anthropic/Pi | ? | MCP client/server | ? | 521 + 9 smoke | v0.15.1 · 13/10 |
| aionui | Apache-2.0 | Electron + web | Rust sidecar | ACP/SDK | 5+ provider | ? | MCP + estensioni | Uso contesto | 653 test | v2.2.2 · 14/10 |
| cloudcli | AGPL-3.0-or-later | Electron + web | TypeScript/JavaScript | SDK/stream JSON | 4 agenti | ? | MCP + plugin | ? | 197 test | v1.37.4 · 09/10 |
| hapi | AGPL-3.0 | CLI/web/mobile | Bun/TypeScript | ACP/SDK | 10 agenti | sì | MCP bridge | ? | 945 + Playwright | v0.30.7 · 13/10 |
| omnara | Apache-2.0 | Web + CLI | Go backend | Loop/daemon | OpenAI/Anthropic/Bedrock | ? | MCP client/server | ? | 872 Go + 2 E2E | v0.2.3 · 14/10 |
| claude-squad | AGPL-3.0 | TUI | Go app | PTY/tmux | Qualsiasi CLI | no | Assente | ? | 10 Go + 1 helper | v1.0.20 · 20/08 |
| companion | MIT | Web | TypeScript/Python | Pi SDK | 7 provider | no dedicato | MCP + plugin | Uso provider | 80 test | v0.2.0 · 03/06 |
| holyclaude | MIT | Web/Docker | Go solo build | CLI/PTY/hook | 8 agenti | no dedicato | MCP client | ? | 102 test | v1.6.6 · 10/10 |
| ccmanager | MIT | TUI Ink/Bun | TypeScript/Bun | PTY/parser | 8 agenti | no | Assente | Token Claude | 84 test/spec | v4.4.6 · 10/10 |
| agent-deck | MIT | TUI + web | Go app | tmux/hook | 7+ agenti | no | MCP + skill | Costi/budget | 1993 test Go | v1.16.28 · 10/10 |
| claude-code-viewer | MIT | Web (Node) | No Rust/Go | Agent SDK | Claude Code | no | legge l'MCP di Claude Code | ? | 120 test/spec | v0.8.2 · 18/08 |
| swttch | AGPL-3.0 | JetBrains/web | TypeScript/Kotlin | stream-json | Claude Code | no | MCP client | ? | 887 test | 7c33d90 · 14/10 (UTC) |
| opencockpit | MIT | Next.js web | TypeScript/Node | Agent SDK | 6 provider | no | MCP lettura | Saldo/quota | 124 + 132 test | v1.0.285 · 13/10 |
| openhands | MIT | Web + Electron | Python backend | Agent Server/ACP | 3+ agenti | no | MCP + skill | ? | 69 + 770 test | v1.27.1 · 12/10 |
| goose | Apache-2.0 | Electron + CLI | Rust core | ACP HTTP/stdio | 10+ provider | ? | MCP + estensioni | ? | ≈308 test | 1.55.0 · 14/10 |
| openwork | MIT/EE source-available | Electron + web | 2 file Rust | OpenCode SDK | 50+ provider | ? | MCP gateway/plugin | ? | 499 test/spec | v0.18.58 · 13/10 |
| codepilot | BSL 1.1 | Electron + Next.js | No Rust/Go | Claude/Vercel SDK | 17+ provider | ? | MCP + skill | Token/costi | 448 + 25 E2E | v0.67.17 · 22/09 |

## Cosa i dossier non sapevano di Topics

Gli agenti avevano una descrizione breve di Topics. Dove un dossier la contraddice, valgono le righe
qui sotto, verificate nel codice il 14/10.

| Il dossier dice | Com'è | Prova |
|---|---|---|
| «Topics oggi parla con tre agenti via `claude -p`» (openhands), «parla con tre CLI» (superset) | Topics ha anche un provider ACP: Gemini CLI e qualunque agente elencato in `ACP_AGENTS`, oltre a Claude Code, Codex, Muse e i provider compatibili OpenAI | `server/providers/acp/agents.ts`, `server/providers/` |
| «Topics non ha undo di sessione» (opcode, opencockpit) | Topics ha checkpoint con rollback e piano dei blocchi | `client/src/components/Chat/CheckpointTimeline.tsx`, `useCheckpoints` |
| Ripresa dopo un crash assente (companion, sul co-browse) | Vale per il co-browse (piano, traccia D4, punti W5 e W6). I turni della chat invece sopravvivono al riavvio del server grazie al daemon staccato | `server/providers/claude-code-reattach.test.ts`, change `chat-claude-code-parity` punto 5 |
| «Topics single user in LAN» (agor) | Condivisione con persone e organizzazioni già nel codice. L'accesso fuori casa (relay) non è finito | change `sharing-orgs` (26 compiti su 30), `relay` (14 su 24) |

## Per asse

### Usabilità

**Chi fa meglio.**
- **L'app di Claude Code e Cursor** chiudono il giro da prompt a PR verificata senza cambiare
  finestra.
- **Superset** ha il Design Mode: si seleziona un elemento nell'anteprima e lo si manda all'agente
  con DOM, stili e screenshot.
- **Vibe Kanban, Conductor, l'app di Codex e Claude Code Viewer** permettono di commentare righe del
  diff e mandare i commenti all'agente.
- **Happy e HAPI** trattano il telefono come cittadino di prima classe: relay cifrato, app native,
  notifiche push, approvazioni in un tocco.

**Cosa prendere.**
- Commenti sul diff all'agente (D5).
- Selettore di elemento e verifica dopo la modifica (D4).
- Abbinamento del telefono con un QR o un codice (D6, con `relay`).

**Dove Topics è avanti.**
- Il co-browse.
- Una sola app per chat, file, git, terminale e browser per topic.
- L'iPad in LAN senza account.

### Gestione: sessioni e task

**Chi fa meglio.**
- **Conductor** ha i Checks prima del merge e tre script per progetto (setup, run, archive), con
  intervalli di porte per workspace.
- **L'app di Claude Code** copia nelle worktree i file non tracciati che servono
  (`.worktreeinclude`) e segue la CI delle PR.
- **Maestro** fa girare playbook interi senza supervisione, una sessione per task con contesto
  pulito.

**Le automazioni a calendario sono la funzione più diffusa che manca a Topics.**
- Le documentano 17 concorrenti su 31.
- Fra questi c'è l'app di Claude Code: Routines, task pianificati e `/loop`.

**Cosa prendere.**
- Worktree pronte, con file copiati, script e porte stabili (D5).
- La CI come condizione del land (D5).
- Card a calendario (D5).
- Una domanda a lato che non sporca il filo (D5).

**Dove Topics è avanti.**
- Nessuno dei 31 documenta una board globale con un dispatcher che sceglie il prossimo task, lo
  lancia, lo riprova e lo porta fino al merge.
- Vibe Kanban e Agor hanno una board, ma non questo dispatcher.
- Maestro esegue playbook interi da solo, ma senza board.

### Sistema: performance, affidabilità, sicurezza

**Chi fa meglio.**
- **Maestro** dichiara budget misurabili: meno di 5.000 nodi DOM a riposo, heap sotto 250 MB, frame
  sotto 32 ms. Fa lo streaming a lotti ogni 200 ms, liste virtualizzate e scritture differite.
- **L'app di Claude Code** compatta una conversazione ferma prima che scada la cache di un'ora, e
  tronca l'output dei tool oltre una soglia.
- **Zed** ha regole di sicurezza scritte nel codice, che nessuna impostazione scavalca.
- **Superset** fa sopravvivere i PTY agli aggiornamenti con un daemon separato.

**Cosa prendere.**
- I budget come cancelli (D0, D2).
- Le letture dalla memoria e i frame solo a chi guarda (D1).
- Una pagina di stato per ogni sottosistema (D6).

**Gli errori degli altri sono i nostri rischi:** vedi «Da evitare».

**Dove Topics è già a posto.**
- I turni della chat sopravvivono al riavvio del server grazie al daemon staccato.
- Il bridge PTY sopravvive ai riavvii.
- `file://` non entra mai nella pane.
- La porta CDP del sidecar ha una guardia sul proprietario.

### Core: architettura e protocolli

**Chi fa meglio.**
- **Zed, OpenHands, Goose, Jean e AionUi** parlano con gli agenti esterni via ACP.
- **OpenCode, Swttch e Jean** hanno un solo backend per tutti i client.
- **Maestro** ha una regola che rende l'app pilotabile dagli agenti: ogni azione della UI ha il suo
  comando da riga di comando.

**Cosa prendere, o già fatto.**
- ACP in Topics c'è già: vedi «Cosa i dossier non sapevano di Topics».
- Resta da valutare `codex app-server`, la sessione lunga di Codex che l'app di Codex usa. Topics
  oggi lancia `codex exec` a ogni messaggio (`server/providers/codex.ts`).

**Rust.**
- Lo usano per il nucleo Jean, Vibe Kanban, opcode, Goose, Zed e AionUi (come sidecar).
- Nessuno porta un numero che leghi Rust alla velocità percepita.
- Vibe Kanban ha il backend in Rust e le stesse lamentele di memoria e di caricamento degli altri
  (issue #1140, #3153, #3373): il collo di bottiglia era il client, non il linguaggio del
  server.
- Il piano usa Rust solo dove la misura lo chiede (D3).

## Le idee scelte per il piano

| Idea | Chi ce l'ha (dossier) | Traccia |
|---|---|---|
| Card a calendario, con sovrapposizioni e recuperi decisi | 17 su 31: claude-code-native, codex-app, superset, agor, emdash, maestro, openhands, goose, omnara, companion, cloudcli, claude-code-viewer, craft-agents, codepilot, opencockpit, openwork, aionui | D5 |
| Commenti sul diff mandati all'agente | vibe-kanban, conductor, codex-app, superset, claude-code-viewer | D5 |
| Worktree pronte: file copiati, script di ciclo di vita, porte stabili | claude-code-native, ccmanager, conductor, agor, superset, vibe-kanban | D5 |
| CI prima del land, e riparazione dei check rossi | conductor, cursor, claude-code-native | D5 |
| Domanda a lato che non entra nel filo | claude-code-native | D5 |
| Selettore di elemento e verifica dopo la modifica | superset, vibe-kanban, codex-app, claude-code-native, cursor | D4 |
| Budget di performance come cancelli, streaming a lotti, virtualizzazione | maestro, opcode, aionui | D0, D2 |
| Stato e diagnosi per sottosistema | claude-code-native, aionui, goose, codepilot, openhands | D6 |
| Telefono abbinato col QR, relay cifrato, push | happy, hapi, opencode, vibe-kanban, swttch, claude-code-viewer, cloudcli | D6 |
| Installazione e aggiornamento provati, migrazioni provate anche da una versione vecchia | agor (l'errore), opencockpit, openwork | D6 |

## Le idee non scelte, e perché

- **Checkpoint a ogni tool call con un git ombra** (opencockpit, jean). Topics ha già checkpoint con
  rollback: prima si misura se servono più fitti.
- **Messaggistica fra sessioni e sottoagenti** (claude-code-native, maestro, opencockpit,
  openhands). La board ha già `session_send` nel suo server MCP. Il resto lo fanno gli agenti
  stessi.
- **Profili di permesso** (codex-app, craft-agents, goose, opencode, omnara, zed). Sono in
  `chat-claude-code-parity`, punto 3, con i prompt di permesso per topic: non si duplica.
- **Condivisione di una sessione via link** (opencode) e **deep link** (agor, conductor,
  craft-agents). Utili, ma non per il «software principale per tutti». Restano per dopo.
- **Esecuzione in sandbox cloud** (cursor, companion, omnara). Topics è locale per scelta.

## Da evitare

| Errore | Dove si vede | Cosa vuol dire per Topics |
|---|---|---|
| Processi `git` e watcher su tutti i workspace, anche quelli chiusi | superset, issue #4198, #6729, #7877 | `git/status` fa 6.008 letture al giorno e 5 spawn per miss (D1); il ricalcolo va legato ai progetti aperti |
| Bundle enorme senza code splitting | vibe-kanban, issue #3153 (4,7 MB, da 7 a 10 s) | il nostro entry eager è 544 KB compressi: tetto in D2 |
| Memoria senza tetto | opencode, issue #49222 (6,5-7 GB); vibe-kanban, issue #1140 e #3373 | la webview va da 0,6 a 1,7 GB in 7,5 minuti (D2) |
| Processi MCP o executor orfani | opencode #46035, agent-deck, agor, craft-agents | sweep all'avvio e kill gentile, poi forzato (D7) |
| Permessi aggirati come abitudine (bypass, AutoYes, full access) | claude-squad, ccmanager, codex-app, claude-code-native | Topics parte da `bypassPermissions`: per un team va deciso un default (`chat-claude-code-parity`) |
| Contenuto delle pagine trattato come fidato | codex-app, claude-code-native, cursor | il browser pilotato dall'agente legge pagine ostili (D4, D8) |
| Sleep e riavvii che uccidono turni, code perse dopo un'interruzione | conductor, companion, codepilot, hapi | due card tagliate a metà turno in sei giorni (D7) |
| Migrazioni provate solo su installazioni nuove | agor | `install-smoke` prova l'aggiornamento dalla versione precedente (D6) |

## Verifiche

**Controlli automatici, 14/10.**
- `check-dossier.sh`: 31 dossier su 31 passano.
- `check-citazioni.py`: 2.201 citazioni al codice su 2.203 esistono nei cloni, con la riga dentro
  il file (99,9%).
- I quattro dossier sui prodotti chiusi si basano solo su documentazione e changelog.
- Nei dossier, 224 affermazioni sono marcate `[non verificato]`.

**A mano, sulle affermazioni che decidono il piano.**

| Affermazione | Verifica | Esito |
|---|---|---|
| Maestro dichiara budget a riposo: meno di 5.000 nodi DOM, heap sotto 250 MB, frame sotto 32 ms | `CLAUDE-PERFORMANCE.md` nel clone di Maestro, tabella «Resting-state baselines» | confermata |
| Superset ha lag d'input da sottoprocessi `git` su tutti i workspace aperti, e un watcher anche sui workspace chiusi | issue #4198 e #6729, aperte, titoli coerenti | confermata |
| Vibe Kanban: bundle da 4,7 MB senza code splitting, caricamenti da 7 a 10 s | issue #3153, aperta, titolo identico | confermata |
| La TUI di OpenCode occupa da 6,5 a 7 GB all'avvio in un progetto vuoto | issue #49222, aperta | confermata |
| 17 concorrenti su 31 documentano automazioni a calendario | ricerca di cron, RRULE e pianificazione nei dossier, poi lettura del contesto: dei 6 casi incerti, 3 confermati (app di Claude Code, Maestro, Emdash) e 3 scartati (Conductor, Happy, Swttch) | confermata |
| Vibe Kanban, Conductor e l'app di Codex mandano all'agente i commenti sul diff | sezioni dei tre dossier, con le fonti citate | confermata |
| Superset ha il Design Mode; l'app di Claude Code verifica dopo ogni modifica (`autoVerify`) | `docs.superset.sh/browser` e `code.claude.com/docs/en/desktop`, citate nei dossier | confermata |
| Il relay di Happy è cifrato end-to-end | codice di cifratura in `packages/happy-agent/src/` del clone | confermata |
| Matrice, app di Claude Code: checkpoint | la pagina «Checkpointing» della documentazione ufficiale (`code.claude.com/docs/en/checkpointing`, «Track, rewind, and summarize») | aggiunta: il dossier non lo diceva |
| Matrice, Swttch: ultimo commit «15/10» | era l'ora del committer (UTC+9): il 14/10 in UTC | corretta |
| Matrice, Cursor: «v2.4 del 22/01» come ultima release | era un esempio dal changelog, non l'ultima versione | corretta |
| Le frasi dei dossier su Topics | vedi «Cosa i dossier non sapevano di Topics» | corrette dove sbagliate |
