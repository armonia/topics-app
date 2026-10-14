# Cursor

## In tre righe
- Cursor è un ambiente di sviluppo con agente di coding integrato, fatto di app desktop, CLI, web e mobile più agenti cloud che lavorano da soli su VM dedicate [doc: https://cursor.com/docs/cloud-agent].
- Si rivolge a team che vogliono delegare interi task, dalla pianificazione alla PR verificata con artefatti, senza restare davanti alla macchina [doc: https://cursor.com/docs/cloud-agent].
- Il suo punto più forte rispetto a Topics: il ciclo completo da prompt a PR unita, con piano revisionabile, checkpoint locali, subagenti specializzati e agenti cloud che aprono PR con screenshot, video e log [doc: https://cursor.com/docs/agent/overview].

## Identità
- Prodotto closed source della società Anysphere, a sorgente non disponibile: niente repository da clonare, niente stelle o commit da misurare [non verificato].
- Livello di questo dossier: documentazione, come previsto dal brief per i closed source. Le pagine lette sono salvate in `repos/cursor-doc/`.
- Maturità alta: documentazione ampia e curata, changelog attivo con release come la 2.4 del 22/01/2026 che introduce skill, subagenti e hook estesi [doc: https://cursor.com/changelog/2-4].
- Piattaforme: app desktop per macOS, Windows e Linux, CLI `agent` per macOS, Linux, WSL e Windows, web su `cursor.com/agents`, app nativa iOS, Android via PWA [doc: https://cursor.com/docs/cli/overview].
- Destinazione d'uso chiara fin dalla home: capire il codice, pianificare e costruire feature, correggere bug, revisionare modifiche [doc: https://cursor.com/docs].

## Architettura
- Closed source, linguaggi e righe di codice non misurabili: nessuna cifra in questa sezione, per onestà [non verificato].
- Tre componenti dichiarati dell'agente: istruzioni con regole, tool di lavoro, modello scelto per il task, con orchestrazione ottimizzata per ogni modello di frontiera [doc: https://cursor.com/docs/agent/overview].
- Modello dei processi: agente locale dentro l'editor e la CLI, più un agente cloud che gira su VM dedicata con ambiente di sviluppo completo, repository clonato, dipendenze, segreti e accesso rete [doc: https://cursor.com/docs/cloud-agent].
- Isolamento cloud dichiarato: una VM per agente su infrastruttura di microVM Firecracker, in un account AWS separato dal resto della produzione [doc: https://cursor.com/docs/cloud-agent/security].
- Storage: cronologia delle conversazioni e snapshot cifrati della VM, con cifratura AES-256 e chiavi dedicate per agente [doc: https://cursor.com/docs/cloud-agent/security].
- Con l'agente si parla via tool calling proprietario senza limite dichiarato di chiamate per task, via protocollo ACP per client esterni e via MCP per tool e browser [doc: https://cursor.com/docs/agent/overview].
- Niente Rust o Go documentati pubblicamente: dove giri il codice nativo non è dichiarato [non verificato].

## Sessioni e task
- Sessioni riprendibili ovunque: la CLI elenca e riprende le chat con `agent ls`, `agent resume` e `agent --continue` [doc: https://cursor.com/docs/cli/overview].
- Per lavori grandi esiste il Project: un agente coordinatore pianifica e delega ad altri agenti [doc: https://cursor.com/docs/agent/overview].
- Subagenti in primo piano o in background: i primi bloccano finché finiscono, i secondi lavorano in parallelo e il risultato arriva dopo [doc: https://cursor.com/docs/subagents].
- Due subagenti integrati, Explore per le ricerche nel codice e Browser per l'automazione web, scelti per tenere il contesto pesante fuori dalla conversazione principale [doc: https://cursor.com/docs/subagents].
- I subagenti di background scrivono l'output in `~/.cursor/subagents/`, così il padre può controllare l'avanzamento [doc: https://cursor.com/docs/subagents].
- Un agente locale può passare lavoro a un subagente cloud su VM e branch propri, mentre il resto continua in locale [doc: https://cursor.com/docs/subagents].
- Gli agenti cloud lavorano su branch separati e consegnano con PR pronte al merge, con artefatti dimostrativi allegati [doc: https://cursor.com/docs/cloud-agent].
- Tentativi e rifacimenti: gli agenti cloud provano a correggere da soli i fallimenti della CI nelle PR che aprono, al momento solo su GitHub Actions [doc: https://cursor.com/docs/cloud-agent/capabilities].
- Review automatica delle PR con Bugbot e agenti di sicurezza, più instradamento ai revisori e approvazione delle modifiche a basso rischio [doc: https://cursor.com/docs/cloud-agent/automations].
- Automazioni sempre attive su pianificazione o eventi da GitHub, GitLab, Slack, webhook e Linear [doc: https://cursor.com/docs/cloud-agent/automations].
- I membri del team possono inviare follow-up agli agenti altrui, con avviso esplicito sul rischio di escalation via segreti altrui [doc: https://cursor.com/docs/cloud-agent/settings].
- Gestione da Agents Window nel desktop e da dashboard web, senza una board kanban esplicita con code e tentativi come quella di Topics [non verificato].

## Usabilità
- Superfici: desktop, web, mobile iOS, CLI, più Android via PWA installabile da Chrome [doc: https://cursor.com/docs/cloud-agent].
- Flusso principale: descrivi l'obiettivo in chat, rivedi il piano, lascia lavorare l'agente, revisiona diff e artefatti, unisci la PR [doc: https://cursor.com/docs/agent/overview].
- Plan Mode dedicato: si attiva con Shift+Tab, fa domande chiarificatrici, studia il codice e produce un piano revisionabile prima di scrivere codice [doc: https://cursor.com/docs/agent/plan-mode].
- I piani si salvano di default nella home e si possono spostare nel workspace per condividerli col team [doc: https://cursor.com/docs/agent/plan-mode].
- Diff e review: anteprima dei file ai checkpoint, revisione delle PR con commenti, check e approvazioni anche da mobile [doc: https://cursor.com/docs/cloud-agent/mobile].
- Notifiche e continuità: gli agenti cloud lavorano a telefono bloccato e si ritrovano su ogni superficie, con inbox mobile dedicata [doc: https://cursor.com/docs/cloud-agent/mobile].
- Scorciatoie: Cmd+I per l'agente nel pannello, Shift+Tab per cambiare modo, Invio per accodare e Cmd+Invio per inviare subito mentre l'agente lavora [doc: https://cursor.com/docs/agent/overview].
- Obiettivi persistenti con `/goal`, anche in ciclo con lo skill `/loop` a intervallo scelto dall'agente [doc: https://cursor.com/docs/agent/overview].
- Side chat con `/side` o `/btw` per tangenti senza sporcare il thread principale, con contesto padre nascosto [doc: https://cursor.com/docs/agent/overview].
- Onboarding guidato dal quickstart che porta dall'installazione alla prima modifica utile [doc: https://cursor.com/docs].

## Browser e anteprima
- Ha un browser integrato nel pannello dell'agente, in finestra separata o riquadro interno, senza tool esterni da installare [doc: https://cursor.com/docs/agent/browser].
- L'agente naviga, clicca anche con doppio clic e tasto destro, compila moduli, scorre pagine lunghe e fa screenshot [doc: https://cursor.com/docs/agent/browser].
- Legge console ed errori JavaScript e monitora il traffico di rete con payload e stati, per ora solo dal pannello agente [doc: https://cursor.com/docs/agent/browser].
- Casi d'uso documentati: verifica di app web, audit di accessibilità WCAG, test automatici con regressione visiva, conversione da mockup a codice [doc: https://cursor.com/docs/agent/browser].
- Il browser è una web view sicura pilotata da un server MCP in forma di estensione, con token casuale per sessione e isolamento per tab [doc: https://cursor.com/docs/agent/browser].
- Ogni azione nel browser richiede approvazione di default, con tre modi: manuale, azioni in allow list, esecuzione automatica [doc: https://cursor.com/docs/agent/browser].
- Efficienza dichiarata: log su file con grep e lettura selettiva, screenshot come immagini vere nel contesto, niente più riassunti prolissi dopo ogni azione [doc: https://cursor.com/docs/agent/browser].
- L'agente viene spinto a riusare i dev server già attivi con le porte giuste invece di avviarne di nuovi [doc: https://cursor.com/docs/agent/browser].
- Stato persistente per workspace tra sessioni: cookie, localStorage, sessionStorage e IndexedDB [doc: https://cursor.com/docs/agent/browser].
- Per le enterprise: interruttore centrale sulle funzioni browser, allow list e deny list MCP, origin allowlist per la navigazione automatica [doc: https://cursor.com/docs/agent/browser].
- Niente co-browse fra dispositivi come quello di Topics: il controllo remoto riguarda il desktop della VM cloud, non il DOM condiviso fra Mac e iPad [doc: https://cursor.com/docs/cloud-agent/capabilities].

## Terminale, editor, file
- L'agente esegue comandi shell e ne monitora l'output, usando di default il primo profilo di terminale disponibile [doc: https://cursor.com/docs/agent/overview].
- Nella CLI i permessi di esecuzione sono unificati con l'editor: tutto automatico, auto in sandbox se disponibile, oppure richiesta ogni volta con allow list [doc: https://cursor.com/changelog/2-4].
- Sandbox commutabile con `/sandbox` o `--sandbox`, con menu interattivo e impostazioni persistenti fra sessioni [doc: https://cursor.com/docs/cli/overview].
- I comandi con `sudo` mostrano un prompt mascherato, la password viaggia su canale sicuro e il modello non la vede [doc: https://cursor.com/docs/cli/overview].
- File: lettura intelligente anche di immagini per i modelli con visione, modifiche proposte e applicate, checkpoint prima dei cambiamenti grossi [doc: https://cursor.com/docs/agent/overview].
- I checkpoint si ripristinano in un clic dalla timeline e revertono i file senza toccare i messaggi, ma vivono solo in locale e non sostituiscono git [doc: https://cursor.com/docs/agent/overview].
- Modalità a sola lettura Ask e Plan anche da CLI, via flag o comandi slash [doc: https://cursor.com/docs/cli/overview].
- Modalità non interattiva con `agent -p` per script e CI, con formato di output configurabile [doc: https://cursor.com/docs/cli/overview].

## Remoto e mobile
- App iOS nativa per avviare e seguire gli agenti, leggere diff completi, commentare, chiedere correzioni e unire con squash o auto merge [doc: https://cursor.com/docs/cloud-agent/mobile].
- Stesse macchine, modelli e tool di revisione del web, in tasca: non una chat ridotta [doc: https://cursor.com/docs/cloud-agent/mobile].
- Remote Control: una sessione del computer passa al telefono, il ciclo agente va sul cloud e i tool continuano a girare in locale su file, test e git [doc: https://cursor.com/docs/cloud-agent/mobile].
- Il computer deve restare acceso e in rete, con opzione per impedirne lo sleep mentre è alimentato [doc: https://cursor.com/docs/cloud-agent/mobile].
- Solo l'utente proprietario controlla i suoi agenti remoti, e solo il contesto necessario lascia la macchina [doc: https://cursor.com/docs/cloud-agent/mobile].
- Su Android si usa il web come PWA da Chrome, con installazione dedicata [doc: https://cursor.com/docs/cloud-agent].
- Niente LAN senza cloud come Topics: il relay passa sempre dai server Cursor e serve l'archiviazione cloud dei dati [doc: https://cursor.com/docs/cloud-agent/mobile].
- Avvio agenti anche da Slack con @cursor, da GitHub e Bitbucket commentando @cursor, da Linear, da API e da automazioni [doc: https://cursor.com/docs/cloud-agent].

## Provider e protocolli
- Modelli supportati in tabella ufficiale: Claude, GPT, Gemini, Grok, Composer proprio, Kimi e Muse Spark, con contesto fino a 1M token sui piani alti [doc: https://cursor.com/docs/models-and-pricing].
- Cursor ottimizza istruzioni e tool per ciascun modello supportato, così l'utente non rincorre le differenze fra provider [doc: https://cursor.com/docs/agent/overview].
- MCP completo: tool, prompt, risorse, roots, elicitation e app interattive, su stdio, SSE e HTTP streamabile [doc: https://cursor.com/docs/mcp].
- Non risulta che si possano usare Claude Code o Codex come backend esterni: i modelli passano dall'infrastruttura Cursor [non verificato].
- ACP supportato dalla CLI con `agent acp` su stdio in JSON-RPC, con metodi di estensione per domande, piani, todo e task dei subagenti [doc: https://cursor.com/docs/cli/acp].
- Integrazioni ACP già pronte per JetBrains, Neovim via avante.nvim e Zed [doc: https://cursor.com/docs/cli/acp].
- API per lanciare e gestire agenti cloud a programma, con agenti durevoli e run separati, più MCP diagnostico integrato per ispezionare run e trascritti [doc: https://cursor.com/docs/cloud-agent/capabilities].

## Performance
- Nessun benchmark pubblico di avvio, memoria o rendering nella documentazione: su questi numeri non ci sono affermazioni da citare [non verificato].
- Efficienza dichiarata del browser: log su file invece che nel contesto, lettura selettiva con anteprime e conteggi, per risparmiare token [doc: https://cursor.com/docs/agent/browser].
- Server e tool MCP caricati solo quando servono, per tenere il contesto focalizzato [doc: https://cursor.com/changelog/2-4].
- Avvio CLI più rapido a caldo e hook più efficienti nelle release recenti [doc: https://cursor.com/changelog/2-4].
- Lamentele degli utenti non consultabili: prodotto closed senza issue pubbliche da citare, a differenza dei concorrenti open [non verificato].

## Affidabilità e qualità
- Prodotto closed: nessun conteggio di file di test o workflow CI da misurare [non verificato].
- Checkpoint locali come rete di sicurezza per il lavoro esplorativo e i refactor complessi [doc: https://cursor.com/docs/agent/overview].
- Cronologia delle conversazioni conservata a tempo indeterminato di default, così le run passate si rivisitano e riprendono [doc: https://cursor.com/docs/cloud-agent/security-network].
- Snapshot della VM fino a 30 giorni di inattività, poi cancellati in automatico con estensione a ogni riuso [doc: https://cursor.com/docs/cloud-agent/security-network].
- Aggiornamenti via installazione CLI con `agent update` e controllo di versione con `agent --version` [doc: https://cursor.com/docs/cli/changelog].
- Recupero da CI rossa automatico sulle PR degli agenti, almeno su GitHub Actions [doc: https://cursor.com/docs/cloud-agent/capabilities].

## Sicurezza e privacy
- Conformità SOC 2 Tipo 2 dichiarata e penetration test almeno annuali da terze parti [doc: https://cursor.com/docs/cloud-agent/security].
- Privacy Mode: niente training sul codice e sui prompt degli agenti cloud, con accordi di zero retention verso la maggior parte dei fornitori di modelli [doc: https://cursor.com/docs/cloud-agent/security].
- La vecchia Privacy Mode legacy non è compatibile con gli agenti cloud, che devono salvare codice e ambienti sul cloud per girare [doc: https://cursor.com/docs/cloud-agent/security-network].
- Accesso al codice via app GitHub o GitLab con installazione da admin, mai con credenziali personali singole, e mai oltre i repository già raggiungibili dall'utente [doc: https://cursor.com/docs/cloud-agent/security].
- D торrette: nessun accesso dei dipendenti al codice dentro le VM, con tentativi monitorati dal team di sicurezza [doc: https://cursor.com/docs/cloud-agent/security].
- Segreti cifrati a rest e in transito, iniettati come variabili d'ambiente, con segreti runtime redatti da trascritti, output e commit [doc: https://cursor.com/docs/cloud-agent/security-network].
- Per i ruoli cloud si consigliano token OIDC di breve durata invece di chiavi longeve [doc: https://cursor.com/docs/cloud-agent/security-network].
- Rete in uscita controllabile in tre modi: tutto aperto, default più allow list, solo allow list, con blocco organizzativo per le enterprise [doc: https://cursor.com/docs/cloud-agent/security-network].
- Ogni commit degli agenti è firmato con chiave Ed25519 su HSM e mostra il badge di verifica [doc: https://cursor.com/docs/cloud-agent/security-network].
- File sensibili tenuti fuori dal contesto con `.cursorignore` [doc: https://cursor.com/docs/cloud-agent/security].
- Il draft della PR come passaggio umano obbligato: niente merge senza revisione di una persona [doc: https://cursor.com/docs/cloud-agent/security].
- Browser sotto guardrail con approvazioni, allow e block list, protezione best effort contro prompt injection da contenuti letti [doc: https://cursor.com/docs/agent/browser].
- Telemetria e porte esposte in rete non dettagliate pubblicamente nelle pagine lette [non verificato].

## Estendibilità
- MCP installabili con un clic dal marketplace o via `mcp.json`, a livello progetto o globale, con OAuth e variabili d'ambiente [doc: https://cursor.com/docs/mcp].
- Regole in quattro ambiti: progetto in `.cursor/rules` come file `.mdc`, utente, team da dashboard e `AGENTS.md` semplice per i casi lineari [doc: https://cursor.com/docs/rules].
- Regole con applicazione sempre, intelligente per descrizione, per glob di file o manuale con menzione [doc: https://cursor.com/docs/rules].
- Skill in file `SKILL.md` scoperte e applicate quando servono, invocabili da slash menu, con skill integrate come `/loop` [doc: https://cursor.com/changelog/2-4].
- Hook che osservano e controllano il ciclo agente: prima e dopo shell, MCP, letture e scritture, subagenti, compattazione e stop [doc: https://cursor.com/docs/hooks].
- Gli hook falliscono aperti di default su crash e timeout, con opzione di chiusura stretta per quelli critici di sicurezza [doc: https://cursor.com/docs/hooks].
- Compatibilità con gli hook di Claude Code nella CLI [doc: https://cursor.com/changelog/2-4].
- Plugin che impacchettano regole, skill, subagenti, comandi, MCP e hook, distribuibili anche via marketplace di team [doc: https://cursor.com/docs/mcp].
- API degli agenti cloud per lanciare run da sistemi esterni, con automazioni via webhook verso CI e monitoraggio [doc: https://cursor.com/docs/cloud-agent/automations].

## Da prendere per Topics
- Checkpoint locali con restore in un clic prima delle modifiche grosse: si vede nel pannello agente [doc: https://cursor.com/docs/agent/overview]. Conterebbe perché Topics oggi si affida a git, un rollback intermedio senza commit sporchi velocizza il lavoro esplorativo.
- Plan Mode esplicito con piano revisionabile salvato nel workspace: si attiva con Shift+Tab [doc: https://cursor.com/docs/agent/plan-mode]. Conterebbe perché dà al topic una fase di piano rileggibile prima di spendere tentativi di esecuzione.
- Coda dei messaggi con invio immediato o accodato mentre l'agente lavora: Invio accoda, Cmd+Invio interrompe con garbo [doc: https://cursor.com/docs/agent/overview]. Conterebbe perché evita di perdere istruzioni a metà run o di troncare lavoro utile.
- Subagente Browser dedicato che filtra snapshot rumorosi e restituisce solo l'essenziale: è uno dei due subagenti integrati [doc: https://cursor.com/docs/subagents]. Conterebbe perché il co-browse di Topics genera molto DOM, un filtro come questo riduce il contesto del thread principale.
- Log del browser su file con grep e lettura selettiva invece che nel contesto: è l'ottimizzazione dichiarata [doc: https://cursor.com/docs/agent/browser]. Conterebbe perché il pannello browser di Topics può adottare lo stesso schema e risparmiare token.
- Artefatti dimostrativi allegati alla consegna, con screenshot, video e log: è lo standard delle PR cloud [doc: https://cursor.com/docs/cloud-agent]. Conterebbe perché la land di Topics diventerebbe verificabile senza ricontrollare tutto a mano.
- Correzione automatica dei check CI falliti sulla PR dell'agente: attivo su GitHub Actions [doc: https://cursor.com/docs/cloud-agent/capabilities]. Conterebbe perché chiude il ciclo land senza un nuovo giro manuale su ogni check rosso.
- Origin allowlist per la navigazione autonoma dell'agente: l'amministratore elenca i siti permessi [doc: https://cursor.com/docs/agent/browser]. Conterebbe perché il browser pilotato di Topics oggi non ha un recinto equivalente.

## Da evitare
- Esecuzione automatica di ogni azione browser senza approvazione: la documentazione stessa la sconsiglia con codice non fidato e siti sconosciuti [doc: https://cursor.com/docs/agent/browser].
- Follow-up di chiunque sugli agenti altrui senza paletti: il rischio dichiarato è escalation via segreti del creatore, da replicare solo con ruoli minimi [doc: https://cursor.com/docs/cloud-agent/settings].
- Cloud obbligatorio per le funzioni migliori con legacy privacy incompatibile: per Topics, che gira in LAN senza cloud, sarebbe un passo indietro copiarlo [doc: https://cursor.com/docs/cloud-agent/security-network].
- Prezzi a consumo con modalità potenziate a parte: la tabella modelli lega funzioni e costi in modo opaco, meglio restare su costi locali prevedibili [doc: https://cursor.com/docs/models-and-pricing].
- Chiusura in un solo editor proprietario: l'estendibilità passa comunque da standard aperti come MCP, ACP e AGENTS.md, quelli sì da adottare [doc: https://cursor.com/docs/mcp].

## Fonti
- https://docs.cursor.com
- https://cursor.com/docs
- https://cursor.com/docs/agent/overview
- https://cursor.com/docs/agent/plan-mode
- https://cursor.com/docs/agent/browser
- https://cursor.com/docs/subagents
- https://cursor.com/docs/cloud-agent
- https://cursor.com/docs/cloud-agent/security
- https://cursor.com/docs/cloud-agent/security-network
- https://cursor.com/docs/cloud-agent/mobile
- https://cursor.com/docs/cloud-agent/automations
- https://cursor.com/docs/cloud-agent/capabilities
- https://cursor.com/docs/cloud-agent/settings
- https://cursor.com/docs/mcp
- https://cursor.com/docs/rules
- https://cursor.com/docs/hooks
- https://cursor.com/docs/cli/overview
- https://cursor.com/docs/cli/acp
- https://cursor.com/docs/cli/changelog
- https://cursor.com/docs/models-and-pricing
- https://cursor.com/changelog/2-4
