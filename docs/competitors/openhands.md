# OpenHands (Agent Canvas)

## In tre righe
OpenHands Agent Canvas è il centro di controllo self-hosted per agenti di coding.
È una web app React che pilota conversazioni con agenti locali, remoti o cloud dallo stesso frontend.
È pensato per team che vogliono agenti sempre accesi, automazioni schedulate e integrazioni con Slack, GitHub e Linear, senza legarsi a un solo provider di modelli.
Il suo punto più forte rispetto a Topics è il protocollo ACP.
Fa girare Claude Code, Codex, Gemini CLI, Pi e OpenCode come subprocess dell'Agent Server.
L'utente cambia agente senza cambiare interfaccia, mentre Topics oggi parla con tre agenti via `claude -p`.

## Identità
Repository: `https://github.com/OpenHands/OpenHands` [doc: https://github.com/OpenHands/OpenHands].
Stelle: circa 90.899 al momento del rilievo [non verificato, valore letto via API il giorno del clone].
Licenza: MIT, con file `LICENSE` alla radice [codice: LICENSE:1].
Ultimo commit nel clone: `71427af` del 2026-10-14.
Il messaggio è un fix sul resume delle sandbox cloud in pausa [codice: src/api/cloud:1].
Ultime release: v1.27.1 del 2026-10-12 [release v1.27.1].
Prima ancora: v1.27.0 sempre del 2026-10-12, v1.26.0 del 2026-10-08, v1.25.0 del 2026-10-06, v1.24.0 del 2026-09-25 [release v1.27.1].
La cadenza è quindi quasi settimanale, con doppie release ravvicinate per i fix.
Maturità: progetto dichiarato beta nel README [README].
La maturità operativa è però alta: CI completa, release firmate via release-please, provenance npm.
Il lavoro è scomposto in repository separati con contratti tipizzati fra loro [codice: docs/architecture.md:23].
Piattaforme: web app servita su `http://localhost:8000` [README].
Immagine Docker `ghcr.io/openhands/agent-canvas` con tag di versione [README].
Pacchetto npm globale `@openhands/agent-canvas` con binario `agent-canvas` [codice: package.json:16].
App desktop Electron con build universale macOS e Node e uv impacchettati [codice: package.json:112].
Nota di perimetro: questo repository contiene solo il frontend Agent Canvas in React e TypeScript.
Il backend Python (Agent Server, SDK, agenti) vive nel repository separato `OpenHands/software-agent-sdk`.
Il contratto fra i due è il client tipizzato `@openhands/typescript-client` [codice: docs/architecture.md:23].

## Architettura
Linguaggi misurati in `src`: circa 175.800 righe totali fra file `.ts` e `.tsx` [non verificato, conteggio via `wc -l` sui file materializzati].
File tracciati: 733 `.ts` e 662 `.tsx`, più asset SVG, CSS e JSON [non verificato, conteggio via `git ls-files`].
Non c'è Rust né Go in questo repository [codice: package.json:22].
È una single-page React 19 con React Router 7, Vite 8 e Tailwind 4 [codice: package.json:40].
Lo stato sta in Zustand, i dati remoti in TanStack Query [codice: package.json:31].
Il terminale usa xterm con addon fit, l'editor usa Monaco [codice: package.json:24].
Il modello dei processi prevede tre servizi di runtime [codice: docs/architecture.md:23].
Primo: Agent Server, che esegue gli agenti ed espone REST e WebSocket.
Secondo: Automation Server, per run schedulati o su webhook.
Terzo: un ingress che espone frontend, Agent Server e automazioni dietro un'unica origine locale.
L'IPC fra UI e agenti passa per il client tipizzato alla versione 1.54.0 [codice: package.json:27].
Gli agenti esterni parlano invece ACP, cioè JSON-RPC su stdio [codice: docs/ACP_AGENTS.md:10].
L'Agent Server fa da ponte: genera il subprocess del CLI e ne possiede le credenziali.
Storage nel frontend: niente SQLite, lo stato durevole sta nei backend registry e nei conversation store su localStorage.
Cronologia e workspace persistono sul server alla sostituzione dei container [README].
Come parla con l'agente: Canvas non chiama mai un LLM direttamente.
Traduce le azioni UI in chiamate all'Agent Server o in turni di conversazione.
Per gli agenti ACP registra solo quale agente usare più i segreti necessari [codice: docs/ACP_AGENTS.md:29].
La direzione delle dipendenze è fissa: contratto Agent Server, poi client TypeScript, poi Canvas.
È vietato reimplementare gli endpoint del server nel frontend [codice: AGENTS.md:1].

## Sessioni e task
Le conversazioni sono l'unità base del prodotto [codice: src/components/features/conversation-panel/conversation-panel.tsx:1].
Si creano sul backend attivo e si archiviano, si fissano in alto, si raggruppano in cartelle.
Si filtrano per tag, stato e testo, con viste per le appuntate e per le archiviate [non verificato].
La modalità con più sandbox Docker fa girare ogni conversazione nel suo container [README].
Ogni container ha Agent Server e tool propri, e Canvas instrada le richieste dal server esterno verso i container.
I workspace e la cronologia sopravvivono alla sostituzione dei container [README].
Esistono conversazioni figlie lanciabili dall'agente via tool dedicato [non verificato].
Esistono conversazioni di pianificazione e conversazioni delegate su backend diversi [non verificato].
Le automazioni sono il vero equivalente delle code e della kanban di Topics.
Offrono scheduling, webhook, run history e dispatch con dashboard, card, toggle e form di setup [codice: src/components/features/automations/automation-card.tsx:1].
Le definizioni vivono però nel repository separato `OpenHands/automation`, non qui [codice: AGENTS.md:1].
C'è supporto a workspace mode e worktree per evitare edit concorrenti sullo stesso checkout [codice: src/utils/workspace-mode.ts:1].
Git è integrato con barra di controllo, lista commit e drawer di diff [codice: src/components/features/diff-viewer/file-diff-viewer.tsx:1].
Non risultano code globali con tentativi, review, land e publish come nella board di Topics.
Il flusso è conversazione più automazione, non pipeline kanban [non verificato].

## Usabilità
Superficie prima: web desktop, servita in locale o dal server self-hosted [README].
Superficie seconda: app desktop Electron con menu, branding e aggiornamenti impacchettati [codice: package.json:112].
Superficie terza: libreria di componenti pubblicata su npm [codice: package.json:210].
Gli entrypoint separati coprono browser, conversazione, file, impostazioni, sidebar, terminale e i18n.
Terzi possono incorporare singoli pezzi di Canvas senza tutta l'app.
Flussi principali: onboarding guidato con modale, passi e progress bar.
Menu di lancio, command menu, menu contestuali, vista home e selettore di backend sempre visibile.
Il selettore permette di passare da locale a remoto a cloud senza perdere il focus [README].
Diff e review: drawer con lista dei cambiamenti e righe per commit [codice: src/components/features/diff-viewer/file-diff-viewer.tsx:1].
Le modifiche non committate hanno una riga dedicata, il viewer è basato su Monaco.
Notifiche: banner di allerta e toast, senza evidenza di push native o PWA [non verificato].
Onboarding dei provider: rileva i login esistenti dei CLI esterni [codice: src/api/acp-service/acp-service.api.ts:28].
Mostra i campi API key solo quando la sonda non trova un login valido.
Internazionalizzazione completa via i18next con controllo di completezza in CI [codice: package.json:97].
Le regole di contributo impongono test TDD per i cambiamenti comportamentali e checklist di compatibilità [codice: AGENTS.md:1].

## Browser e anteprima
C'è un pannello browser integrato nel layout di conversazione [codice: src/components/features/browser/browser.tsx:6].
È però una vista di sola osservazione, non un browser pilotabile.
Mostra l'URL corrente e uno screenshot PNG in base64 della pagina remota.
Non c'è DOM interattivo né co-browse fra dispositivi [codice: src/components/features/browser/browser.tsx:1].
Il componente compone solo tre pezzi: barra chrome, snapshot e messaggio di vuoto.
Legge tutto dallo store Zustand del browser, senza canali verso altri device.
Nessuna ricerca di mirror del DOM ha dato risultati nel codice [non verificato].
Niente di simile al co-browse Mac iPad di Topics, che rispecchia il DOM e si pilota con 15 tool.
Le azioni browser dell'agente girano lato sandbox come screenshot e snapshot testuale.
L'utente le osserva, non le condivide fra dispositivi.
Per Topics questa è una lacuna del concorrente, non un modello da copiare alla lettera.
Riusabile è invece l'idea di esporre l'anteprima come entrypoint di libreria (`./browser`) [codice: package.json:216].

## Terminale, editor, file
Il terminale è un pannello xterm integrato nel layout di conversazione [codice: src/components/terminal/index.ts:1].
Usa `@xterm/xterm` con addon fit ed è esposto anche come entrypoint di libreria.
L'editor di file e diff usa Monaco con il binding React ufficiale [codice: package.json:24].
La scheda file ha uno store dedicato con tab persistiti.
L'upload ha un limite dichiarato di 3 MB, con issue aperta per renderlo configurabile [issue #18340].
Il controllo del workspace rifiuta con 422 i percorsi fuori dalla conversazione [issue #18421].
I comandi rapidi e la tavolozza passano dal command menu [non verificato].
Non risulta un sistema di scorciatoie paragonabile a un editor nativo [non verificato].
Git panel e file panel restano due viste distinte ma collegate dal drawer di diff.

## Remoto e mobile
L'accesso remoto è un caso d'uso primario, non un ripiego [README].
Lo stesso frontend passa da backend locale a remoto a cloud.
La guida raccomanda un server sempre acceso così gli agenti girano a laptop spento.
Il trasporto LAN esiste ma è sorvegliato da un flag esplicito.
La chiave di sessione viene iniettata nell'`index.html` solo in bind locale.
Serve `--allow-lan-session-key` per abilitarla in LAN [codice: scripts/static-server.mjs:247].
Una guardia rifiuta le combinazioni incoerenti di flag di autenticazione.
La cifratura oltre la LAN è delegata alle pratiche di hardening del deploy.
Il documento cita autenticazione, HTTPS, firewall e scoping dei workspace [codice: docs/architecture.md:80].
Niente relay cloud proprietario nel repo: il cloud è OpenHands Cloud o Enterprise come backend opzionale [codice: docs/architecture.md:25].
Non c'è uso nativo da telefono paragonabile a Topics in LAN.
Il layout mobile è curato solo a tratti e per singoli hub come le skill.
Una issue segnala il dialogo di richiesta segreti più largo dello schermo del telefono [issue #18432].
Un'altra chiede di popolare il selettore repo e branch con i valori recenti per gli avvii rapidi [issue #15450].

## Provider e protocolli
Claude Code, Codex e Gemini CLI funzionano su backend locali e cloud [codice: docs/ACP_AGENTS.md:41].
Pi e OpenCode funzionano solo su backend locali e self-hosted.
L'immagine Agent Server non li preinstalla e il primo uso li scarica via `npx`.
La tabella dei provider con i comandi di default vive nella documentazione [codice: docs/ACP_AGENTS.md:33].
La lista canonica arriva dal registry dell'SDK e Canvas aggiunge solo metadati UI.
Autenticazione a due vie: login in abbonamento del CLI oppure API key.
Le sonde locali sono dedicate per provider: JSON di `claude auth status` per Claude [codice: src/api/acp-service/acp-service.api.ts:28].
Parsing testuale di `codex login status` per Codex, controllo credenziali per Gemini e Pi.
Il timeout di sonda è di 10 secondi per non bloccare l'onboarding [codice: src/api/acp-service/acp-service.api.ts:11].
Tre esiti possibili: autenticato, non autenticato o sconosciuto, con fallback ai campi chiave solo quando serve.
MCP è cittadino di prima classe con pagina dedicata [codice: src/api/mcp-service/mcp-service.api.ts:1].
La pagina offre marketplace, editor di server custom, badge di salute e pannello integrazioni native.
Il test dei server ha timeout fino a 120 secondi, con OAuth per i server cloud.
I segreti sono redatti prima del salvataggio e reiniettati all'uso.
Le skill riusabili arrivano dal pacchetto `@openhands/extensions` alla versione 0.30.0 [codice: package.json:26].
I filtri per categoria includono un hub anche per schermi piccoli.

## Performance
Avvio: stack locale lanciato dal binario `agent-canvas` [codice: docs/architecture.md:45].
Le varianti sono full, solo frontend, solo backend e minima senza automazioni per alleggerire il boot.
Nessuna misura ufficiale di memoria o tempi dichiarata [non verificato].
I segnali dalle issue sono però concreti e tutti nella stessa direzione.
La lista dei messaggi di conversazione non è virtualizzata.
Una feature request chiede di virtualizzarla per le conversazioni molto lunghe [issue #18102].
Oltre 3 conversazioni l'app diventa estremamente lenta con errori di connessione rifiutata [issue #16690].
Il dettaglio automazioni perde modifiche allo schedule e mostra pagine lente per run inesistenti [issue #17948].
La condensazione del contesto fallisce sempre dopo 60 secondi netti [issue #17621].
Il timeout lato client abortisce un lavoro che il server poi completa, sprecando il calcolo.
Lavoro in background: automazioni schedulate e webhook girano sul server anche a UI chiusa.
È il modello always-on del prodotto, con run osservabili dalla dashboard [README].
Niente Rust per la velocità: il frontend è tutto TypeScript [codice: package.json:22].
Il lavoro pesante sta nei container Docker e nell'Agent Server, non nella UI.

## Affidabilità e qualità
Test misurati: 69 file di unit e component test sotto `src` [non verificato, conteggio via `find`].
Circa 770 file sotto `__tests__`, fra test, mock e fixture [non verificato, conteggio via `find`].
Quattro configurazioni Playwright: e2e live, mock-LLM, mock-LLM su Docker e bind-policy.
La CI installa con `npm ci` ed esegue typecheck, ESLint, Prettier, test, build app e build libreria [codice: docs/architecture.md:68].
Segue la verifica del pacchetto con `npm pack` e QA e2e opzionale.
C'è una configurazione Stryker per mutation testing con varianti incrementali [codice: package.json:92].
Le pull request devono rispettare una guida di review dedicata oltre ai controlli CI [codice: AGENTS.md:1].
Recupero dopo crash: workspace e cronologia sopravvivono alla sostituzione dei container [README].
Ogni container monta stato persistito e i file condivisi restano sul workspace host.
Le issue mostrano però falle di robustezza ancora aperte.
Conversazioni cloud completate che si riaprono con cronologia vuota per un fallback silenzioso [issue #18445].
Attivazione di un nuovo backend che interroga il vecchio id di conversazione [issue #18390].
Canvas che parte anche se il backend automazioni è morto prima del ready [issue #18362].
Upload che fallisce quando il percorso esce dal workspace, senza rimedio proposto all'utente [issue #18421].
Primo prompt ACP senza indicatore di pensiero, con attività che appare solo al secondo invio [issue #18371].
Aggiornamenti: release-please con manifest e npm trusted publishing con provenance [codice: docs/architecture.md:60].

## Sicurezza e privacy
Le credenziali degli agenti esterni restano legittime per costruzione.
Canvas non tocca gli account: registra solo quale agente usare e passa i segreti al backend [codice: docs/ACP_AGENTS.md:29].
È il backend a possedere il subprocess ACP e le chiamate al provider.
I segreti MCP sono redatti prima della persistenza e reiniettati al momento dell'uso [codice: src/api/mcp-service/mcp-service.api.ts:22].
La guida avverte che senza sandbox l'agente ha accesso completo al filesystem [codice: docs/architecture.md:80].
Per l'uso su laptop raccomanda la modalità Docker con directory progetti montata.
Le approvazioni a livello di singolo tool per i server MCP sono richieste ma non ancora presenti [issue #18446].
Telemetria PostHog dichiarata anonima ma attiva di default verso il progetto dell'organizzazione [codice: src/services/telemetry.ts:4].
Il traffico passa dal proxy dell'organizzazione, con variabili per ridirigerlo altrove.
Porte esposte: la 8000 in bind locale di default, con esempi Docker su loopback [README].
Esiste un documento di difesa in profondità (`DefenseClaw.md`) non letto per intero [non verificato].

## Estendibilità
MCP con marketplace, server custom, integrazioni native e badge di salute [codice: src/components/features/mcp-page/mcp-toolbar.tsx:1].
Un toggle permette di salvare la configurazione come segreto.
Plugin e automazioni riusabili dal pacchetto `@openhands/extensions` [codice: package.json:26].
Cataloghi ed editor di importazione con test dedicati alle automazioni.
Hook di workspace caricati da `.openhands/hooks.json` via Agent Server [codice: src/api/hooks-service.ts:13].
Il timeout è di 5 secondi per non bloccare l'avvio della conversazione.
Una feature chiede di caricare anche gli hook globali di `~/.openhands/hooks.json` con indicazione della provenienza [issue #18365].
Skill con pagine, filtri per categoria e lancio da chat [codice: src/components/features/skills/skill-filter.ts:1].
Tool client integrati per le automazioni: form interattivi e UI Canvas richiamabile dall'agente.
C'è anche il lancio di conversazioni figlie come tool dell'agente [codice: src/api/automation-form-client-tool.ts:1].
Libreria pubblicata con sei entrypoint oltre al bundle principale [codice: package.json:210].
Un host può incorporare solo terminale, file o conversazione senza il resto.

## Da prendere per Topics
1. Matrice di provider ACP con comandi di default e metadati UI [codice: docs/ACP_AGENTS.md:41].
   Una tabella come quella dei cinque agenti rende banale aggiungere il prossimo CLI senza rifare l'onboarding.
   Per Topics conterebbe perché oggi parla solo con tre agenti via `claude -p`.
   La stessa astrazione aprirebbe altri motori senza riscrivere la chat.
2. Sonde di autenticazione con timeout corto e tre stati [codice: src/api/acp-service/acp-service.api.ts:11].
   Autenticato, non autenticato o sconosciuto, con fallback ai campi API key solo quando serve.
   Per Topics significherebbe smettere di indovinare il login e mostrare solo ciò che manca davvero.
3. Backend registry con switch senza perdita di focus [codice: docs/architecture.md:23].
   Locale, remoto e cloud convivono e la scelta dell'agente è per backend.
   Per Topics, servizio su porta fissa in LAN, è il modello per passare da istanza Mac a remota senza perdere il topic.
4. Conversazioni figlie lanciabili dall'agente con esempio documentato [issue #18430].
   Decompongono un task senza intasare il thread principale.
   Per Topics è la versione esplicita del lancio in worktree della kanban, restando dentro la conversazione.
5. Redazione dei segreti MCP prima del salvataggio e reiniezione all'uso [codice: src/api/mcp-service/mcp-service.api.ts:22].
   Piccola funzione, grande garanzia per config e log condivisibili.
   Per Topics andrebbe applicata al server MCP e ai log prima di qualsiasi condivisione.
6. Timeout dedicato di 5 secondi sul caricamento hook nel percorso critico di avvio [codice: src/api/hooks-service.ts:13].
   Evita che un backend lento blocchi l'apertura della conversazione.
   Per Topics è una regola generale: ogni chiamata non essenziale all'avvio merita un budget proprio.
7. Guardia LAN sulla chiave di sessione con flag esplicito [codice: scripts/static-server.mjs:247].
   In LAN niente iniezione automatica senza consenso dell'operatore.
   Per Topics, usabile da telefono in LAN, è il controllo che manca per non esporre la sessione di default.
8. Entrypoint di libreria per singoli pannelli [codice: package.json:210].
   Conversazione, terminale, file e browser come moduli separati aprono a embedding e riuso.
   Per Topics significherebbe incorporare il PTY o il browser altrove senza trascinarsi tutta l'app.
9. Nomi canonici degli eventi con eliminazione dei duplicati [issue #18354].
   Evita doppioni come onboarding completato in due forme diverse.
   Per Topics conta perché chat, git e terminale emettono già eventi che finiranno in telemetria.

## Da evitare
1. Anteprima browser a soli screenshot [codice: src/components/features/browser/browser.tsx:6].
   Osservare un PNG in base64 non è pilotare.
   Il divario con il co-browse DOM di Topics va mantenuto, non colmato al ribasso.
2. Lista messaggi non virtualizzata [issue #18102].
   Oltre una certa lunghezza la chat degrada e il fix arriva solo come feature request.
   Meglio virtualizzare da subito le viste lunghe.
3. Fallback silenziosi che mostrano pagine vuote [issue #18445].
   Cronologia cloud sparita senza errore e schedule persi senza avviso sono la stessa malattia.
   Nascondere il fallimento invece di dichiararlo costa più del crash.
4. Timeout client più corti del lavoro server [issue #17621].
   Abortire a 60 secondi una condensazione che il server completa spreca token e confonde l'utente.
   I timeout vanno negoziati con la durata reale dell'operazione.
5. Avvio che ignora la salute dei backend [issue #18362].
   Partire con il servizio automazioni morto garantisce errori a valle.
   Il fail-fast all'avvio costa poco e previene stati inconsistenti.
6. Telemetria attiva di default verso infrastruttura del fornitore [codice: src/services/telemetry.ts:4].
   Anche se anonima, in un prodotto self-hosted l'opt-in esplicito genera più fiducia dell'opt-out.
7. Limiti hard-coded non configurabili [issue #18340].
   Il tetto di 3 MB sugli upload si alza solo con una patch.
   Ogni limite numerico merita una voce di configurazione dal primo giorno.

## Fonti
- Repo e README: `https://github.com/OpenHands/OpenHands`
- Architettura: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/docs/architecture.md`
- Agenti ACP: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/docs/ACP_AGENTS.md`
- Manifest: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/package.json`
- Pannello browser: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/src/components/features/browser/browser.tsx#L6`
- Sonde ACP: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/src/api/acp-service/acp-service.api.ts#L11`
- Servizio MCP: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/src/api/mcp-service/mcp-service.api.ts#L1`
- Hook di workspace: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/src/api/hooks-service.ts#L13`
- Telemetria: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/src/services/telemetry.ts#L4`
- Guardia LAN: `https://github.com/OpenHands/OpenHands/blob/71427af5b426b3f1270db86341dffe30a947d53c/scripts/static-server.mjs#L247`
- Release: `https://github.com/OpenHands/OpenHands/releases/tag/v1.27.1`
- Issue #15450, #16690, #17621, #17948, #18102, #18340, #18362, #18365, #18371, #18390, #18421, #18430, #18432, #18445, #18446 su `https://github.com/OpenHands/OpenHands/issues`
