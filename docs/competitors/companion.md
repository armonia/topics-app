# Companion

## In tre righe

Companion, nome prodotto companions.build, è un sistema web open source per collaboratori IA persistenti, ognuno con un proprio computer cloud, chat durevole, routine e deleghe tra agenti.
È pensato per utenti non tecnici che vogliono un assistente sempre pronto via browser, con intervento umano sul desktop reale quando serve.
Il suo punto più forte rispetto a Topics è il modello di esecuzione durevole su macchine isolate: ogni effetto esterno è preceduto da persistenza, ogni richiesta ambigua non viene mai ripetuta alla cieca.

## Identità

Il repository è `The-Vibe-Company/companion`, con circa 2403 stelle e 291 fork, licenza MIT, creato il 7 febbraio 2026 [non verificato].
L'ultimo commit nel clone è del 23 settembre 2026, l'ultimo push registrato il 12 ottobre 2026, mentre l'ultima release è la v0.2.0 del 3 giugno 2026 [release v0.2.0].
La serie precedente di tag `the-companion v0.92.5, v0.95.0` si ferma ad aprile 2026, segno di un cambio di architettura dichiarato: il nuovo prodotto riparte da zero e l'antico Skills Hub vive altrove [README].
La maturità è esplicitamente pre produzione: il README avverte che il repository implementa il percorso locale e i confini hosted, ma non prova che servizio hosted, OAuth dei provider, prezzi Stripe o avvio a freddo siano pronti [README].
Le piattaforme sono web su desktop e mobile via browser, runtime Linux in container Docker in locale e su Box in hosted, distribuzione come immagine Docker multi ruolo [README].

## Architettura

I linguaggi misurati nel clone, con `git ls-files` più `wc -l`, sono TypeScript con 20276 righe in 189 file, TSX con 4242 righe in 44 file, Python con 7951 righe in 56 file, JSON con 3616 righe, CSS con 2908 righe, SQL con 1723 righe in 23 file, per un totale di circa 58400 righe su 550 file [codice: package.json].
Il runtime è Bun 1.4.2 fissato dal package manager, il motore agente è il Pi SDK 0.85.0 nei pacchetti `@earendil-works/pi-ai`, `pi-coding-agent` e `pi-server`, il client web usa React con shadcn/ui e AI Elements [codice: package.json].
Non c'è Rust né Go nel prodotto: i due linguaggi compaiono solo nei documenti di ricerca come alternative scartate [doc: https://github.com/The-Vibe-Company/companion].
Il modello dei processi prevede tre ruoli nella stessa immagine, cioè `api`, `executor` e `worker`, più PostgreSQL come control plane durevole, object storage MinIO o S3 e Mailpit per il login locale [README].
L'API valida l'autorizzazione e persiste ogni messaggio, file, richiesta di ciclo di vita e ricevuta webhook, senza contattare l'agente in ammissione ordinaria; solo l'executor detiene il lease sul database ed è l'unico a produrre effetti su macchine e run; il worker schedula routine, valuta trigger e scarica l'uso [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Lo storage web è PostgreSQL come unica fonte di verità, con sessioni Better Auth e query sempre limitate al proprietario; ogni agente possiede invece il proprio transcript Pi e un journal locale, con outbox MCP e journal desktop su SQLite [codice: packages/control/agent.ts].
Con l'agente si parla via Pi SDK nativo in streaming, con steering nativo, sessioni separate e cancellazione; non risultano Agent SDK di Claude Code, PTY condiviso in stream-json né ACP tra le dipendenze [codice: package.json].

## Sessioni e task

Ogni Companion ha una lane principale durevole e una lane di background: i messaggi del chat usano lo steering nativo di Pi su una sessione persistente, mentre routine, trigger e deleghe usano sessioni distinte con memoria strutturata condivisa ma storici Pi separati [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Routine, trigger e deleghe ricevute condividono una sola coda di background con una sola task in esecuzione per Companion; una task sospesa in attesa di risposta umana libera il posto [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
Dopo un'indisponibilità viene recuperata solo l'ultima occorrenza mancata di ogni routine, le precedenti sono marcate come mancate e non rieseguite [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
La collaborazione prevede delega a Companion permanenti, repliche temporanee da template autorizzati senza creazione ricorsiva di figli, revisioni immutabili dei template con rollback, adozione dello snapshot della Box di un figlio e risultati trattenuti con la task anche dopo l'archiviazione del figlio [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
L'Activity elenca le task con paginazione a cursore da 20 elementi e 50 al massimo, con lettura pigra di richiesta, risultato e file e cancellazione mirata del background [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Non esistono worktree git parallele, code con tentativi, review con land e merge, né PR e CI integrate: Conductor compare solo come plugin MCP esterno [codice: packages/plugins/definitions.ts].
Chat e background condividono una memoria strutturata durevole del Companion con snapshot limitato di preferenze e correzioni subito disponibile; recupero dettagliato e indicizzazione passano per un subprocess pigro e il `MEMORY.md` storico resta supportato [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Resta invece da validare la politica di prodotto su quali memorie del padre entrano nel brief di un figlio e quali apprendimenti del figlio tornano nella memoria del padre [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].

## Usabilità

Le superfici sono solo web, con direzione design minimale: canvas avorio, rail da 96px, avatar sticker, navigazione a pill, righe di chat allineate e pannello laterale di configurazione [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
I flussi principali sono creazione guidata con preparazione anticipata del computer, chat con stati reali persistiti, scheda con mission, skill, connessioni, routine, trigger e specialisti, e apertura del desktop [README].
Le domande bloccanti usano carte esplicite di attesa con risposte suggerite e testo libero, che restano nello storico anche dopo la chiusura [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Digitare `/` nel composer scopre i comandi skill Pi del runtime corrente e inserisce `/skill:<nome>` al cursore senza inviare; la scoperta mostra solo nomi, descrizioni e origine e non sveglia mai un Companion addormentato [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
La creazione resta in attesa interna durante il setup irrisolto e le risposte asincrone staccate non possono navigare l'utente altrove [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Le notifiche non sono un log durevole per scelta: alla riconnessione il client ricarica lo snapshot e gli intervalli, così una notifica persa offline non può perdere stato persistito [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Il frontend deve mostrare solo stati reali, senza successi simulati né indicatori cosmetici di progresso, per regola interna del progetto [codice: AGENTS.md].
L'onboarding locale è email più magic link con inbox di test; scorciatoie da tastiera globali e centro notifiche non risultano documentati [non verificato].

## Browser e anteprima

Non esiste un browser integrato nel client né un'anteprima pilotabile dall'agente come in Topics, e non esiste nulla di simile al co-browse tra dispositivi [non verificato].
Esiste invece il desktop reale della Box: apertura da chat con risveglio se necessario, preparazione su richiesta, e presa di controllo umana come intento durevole con conferma esplicita prima di dichiarare la mano disponibile [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
Il desktop è servito in streaming VNC o noVNC in una tab dedicata, perché l'autenticazione richiede una pagina di primo livello [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
L'unico percorso agente verso il desktop è un broker dedicato con due socket Unix, uno per azioni tipizzate di screenshot, click, digitazione, tasti e scroll, uno per lo stato di takeover; usa `xdotool` senza shell, journal SQLite fail-closed a ogni boot, UUID stabili con idempotenza e 64 MiB di budget per i risultati [codice: packages/desktop/README.md].
Durante la presa umana il lavoro headless, i file, la rete e la chat continuano; chiudere il browser non restituisce la mano, serve l'azione esplicita [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].

## Terminale, editor, file

Gli strumenti shell e file dell'agente girano in Linux isolato, in container Docker in locale e su Box in hosted, mai sull'host di sviluppo [codice: AGENTS.md].
Il confine desktop è istruito all'agente: shell, file e plugin stanno in ambiente headless isolato e non toccano il desktop condiviso, e lanciare automazione via terminale del desktop per aggirarlo è vietato [codice: packages/agent/src/companion-instructions.ts].
Ogni messaggio può portare fino a cinque allegati privati validati, l'invio attende gli upload dichiarati e i file prodotti dall'agente finiscono in object storage privato e vengono proiettati sul messaggio o sulla task [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Il pannello di lavoro mostra tab per risultati, file, computer e dettagli, con ambito per conversazione o per Companion, ma non risulta un terminale PTY interattivo né un editor integrato come in Topics [codice: apps/web/src/components/discussions/Workbench.tsx].
I file consegnati come risultati sopravvivono al figlio temporaneo e restano attaccati alla sua task; gli altri spariscono con la sua Box salvo conservazione in template [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].

## Remoto e mobile

L'accesso remoto è il web hosted su HTTPS con URL pubblica configurata, login con magic link via Better Auth e sessioni da 30 giorni; non esiste una modalità LAN senza cloud come in Topics [README].
Solo il ruolo API espone una porta, con controllo dell'origin e verifica di salute; i filtri dei trigger girano in QuickJS WebAssembly dentro l'immagine, così nessun servizio richiede il socket Docker [README].
Il client è responsive e i test guidati da browser coprono viste desktop e mobili con soglia a 1024px, ma non risulta un'app nativa [codice: apps/web/src/components/DiscussionsWorkspace.browser.test.tsx].
Il supporto PWA per l'installazione da mobile è solo una proposta aperta [issue #587], e il supporto ad agenti remoti è una richiesta ancora aperta [issue #489].
Non risulta documentato un relay dedicato oltre HTTPS [non verificato].

## Provider e protocolli

I modelli passano da un gateway con credenziali firmate a scadenza per singola run: le chiavi globali restano nell'API, la Box non le riceve mai, e l'uso rendicontato dal provider è registrato indipendentemente dal transcript [README].
I provider instradati sono Google, Anthropic, Azure, DeepSeek, OpenAI, OpenRouter e Z.AI, con catalogo proiettato in UI e scelta validata per Companion [codice: apps/server/src/model-gateway.ts].
In locale il default è un modello di test deterministico scripted, mentre le risposte reali richiedono chiavi in file `.env` non committato, con Google e Gemini 2.5 Flash come esempio [README].
Claude Code, Codex, Gemini, OpenCode e ACP non risultano come harness: il motore è solo Pi SDK, e lo stesso documento di ricerca li cita come alternative valutate e scartate [codice: package.json].
Sul fronte MCP ci sono tre livelli: il `companion-control` per identità, modelli, routine, trigger, task, deleghe, template, ciclo di vita, plugin e consegne; i plugin MCP dei provider; e MCP personalizzati HTTPS o stdio [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].

## Performance

Le misure ufficiali V12 su Box reale riportano ammissione in 10-15 ms, preparazione a freddo in 10,5 secondi, risveglio in 16,4 secondi, esecuzione in 13-16 secondi e archiviazione in 33,8 secondi [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/measurements/box-gateway-v12-2026-09-07.json].
Il primo tentativo di viewer ha superato la scadenza di 60 secondi per limiti del provider, recuperando poi senza intervento manuale; l'obiettivo di avvio in pochi secondi resta esplicitamente non dimostrato [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/measurements/box-gateway-v12-2026-09-07.json].
Il prodotto distingue tre misure, cioè macchina disponibile, agente pronto e prima risposta del modello, con target discusso di meno di due secondi per accettare lavoro su Box già disponibile [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
Il client usa un event stream same-origin con ricarica dello snapshot, mentre il vecchio codice leggeva la chat ogni 3 secondi in attività e 8 a riposo [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
Tra le lamentele risultano crash dopo circa 24 ore con sessioni multiple [issue #103], loop di riavvio del CLI su disconnessioni WebSocket transienti [issue #492] con caso gemello ancora aperto [issue #480], e una richiesta chiusa di auto archiviazione delle sessioni inattive contro l'esaurimento di memoria [issue #275].

## Affidabilità e qualità

I file di test sono 80 in totale, di cui 45 nella suite del server e 9 in quella dell'agente, più test web con casi guidati da browser reale [codice: apps/server/test] [codice: packages/agent/test].
La verifica completa provisiona PostgreSQL e MinIO freschi, controlla i tipi, compila l'agente, esegue le suite server e Pi su Linux reale, poi testa e compila il web, con contenitori etichettati e rimossi solo se propri della run [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Le suite deterministiche coprono isolamento tra proprietari, ammissione durevole, riconnessione dello stream, confini di crash, lane indipendenti, domande, catch-up delle routine, trigger firmati, file, plugin, ciclo di vita, template, fatturazione e consegne [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Dodici test di fault mirati proteggono i confini di concorrenza tra run, con guardie contro effetti tardivi e checkpoint stantii [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Gli ID di richiesta sopravvivono al restart, un effetto ambiguo viene interrotto e mai ripetuto, e le migrazioni usano fingerprint di schema con lock opportunistico prima che ogni servizio diventi pronto [README].
La CI esegue la verifica su workflow dedicato [codice: .github/workflows/verify.yml].
Lo sviluppo locale usa un pannello di controllo con diagnostica dei prerequisiti, worktree isolati con porte, database e macchine propri, scenari nominati con orologio controllabile e guasti iniettabili, e ispezione per ID di task [codice: AGENTS.md].
Restano fuori prova carico hosted sostenuto, latenza di coda, deliverability email reale e attivazione commerciale Stripe [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].

## Sicurezza e privacy

L'autenticazione è con magic link email, token monouso con hash, sessioni in PostgreSQL e query sempre limitate al proprietario, senza bypass con token operatore [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
I segreti sono cifrati con chiave esadecimale a 64 caratteri e decifrati solo al momento dello staging verso l'executor; gli account OAuth e gli MCP personalizzati seguono lo stesso percorso [README] [codice: apps/server/src/plugins.ts].
Il gateway autorizza ogni richiesta su run, proprietario e modello selezionato, sanifica il body contro stato remoto condiviso e forza `store=false` sui provider che lo supportano [codice: apps/server/src/model-gateway.ts].
Il flusso beta privata limita l'accesso a una lista esatta di email e ricontrolla sessioni e ammissioni a runtime [README].
Le chiamate MCP vengono eseguite direttamente senza approvazione umana per chiamata, inclusi tool distruttivi o senza annotazioni, per scelta documentata [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Payload dei provider e credenziali sono vietati in log, errori, documenti e artefatti committati [codice: AGENTS.md].
I webhook Stripe accettano solo firme fresche e valide sul body intatto, con ID evento registrati per deduplicare i retry, e le mutazioni che avviano lavoro ricontrollano l'attivazione dell'abbonamento anche subito prima del lavoro su macchina e modello [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/billing-delivery.md].
Non risultano tracce di telemetria di prodotto nel server e nel web [non verificato].

## Estendibilità

Il `companion-control` espone una trentina di operazioni durevoli con ID di comando, da identità e modelli a routine, trigger, deleghe, repliche, template, desktop, consegne e manutenzione [codice: packages/control/agent.ts].
Il catalogo plugin include GitHub, Linear, Notion, Conductor, Sentry, Slack e Gmail, con distinzione tra connessione di un account e selezione dei tool per un Companion, più MCP personalizzati [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
Le skill sono pacchetti Pi locali con manifest validato, installati e verificati dall'agente, con esportazione portabile, hash di contenuto, rifiuto di path pericolosi e bundle immutabili [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
I trigger supportano webhook generici oltre ai provider gestiti, con filtri in codice isolato, consultazioni API dichiarate di sola lettura, test su evento, deduplicazione, raggruppamento per problema e storico delle consegne [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md].
La consegna a clienti crea copie indipendenti con template specialistici, attivazione con abbonamento del cliente e manutenzione esplicita, accettata e revocabile [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md].
Non risultano hook utente sul ciclo agente né skill picker con `$`, quest'ultimo è solo una proposta aperta [issue #631].

## Da prendere per Topics

1. Ammissione durevole con `202` e ID client stabili che deduplicano i retry e rifiutano contenuti cambiati, così un doppio invio non crea doppio lavoro [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Conterebbe perché Topics lancia agenti in parallelo dove i retry sono frequenti.
2. Divieto di replay cieco con journal degli ID di richiesta che sopravvive al restart: un effetto ambiguo si interrompe e si riconcilia, non si ripete [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Conterebbe perché riduce i danni peggiori, cioè merge e publish duplicati.
3. Trigger con filtro in codice isolato eseguito prima di svegliare l'agente e prima di ogni chiamata al modello, con pulsante di test su evento [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md]. Conterebbe perché la kanban di Topics potrebbe reagire a webhook CI senza bruciare token.
4. Gateway modelli con credenziali firmate a scadenza per singola run e chiavi globali isolate nel server, con uso rendicontato indipendente dal transcript [README]. Conterebbe perché Topics espone oggi la porta 3333 in LAN con credenziali degli agenti da proteggere meglio.
5. Broker desktop con journal fail-closed, azioni idempotenti a UUID e budget di ritenzione sui risultati [codice: packages/desktop/README.md]. Conterebbe perché il co-browse di Topics oggi non ha semantica di ripresa dopo crash.
6. Modalità di pubblicazione delle automazioni in tre livelli, cioè se utile, sempre e silenzioso, con nome e modo congelati all'ammissione [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Conterebbe perché la board di Topics notifica troppo o troppo poco senza una regola esplicita.
7. Rattrapage limitato all'ultima occorrenza mancata per routine, con le precedenti marcate e mai rieseguite [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md]. Conterebbe perché evita tempeste di run al riavvio del servizio launchd.
8. Verifica con servizi freschi e contenitori etichettati di proprietà, più canarini live separati dai test deterministici [README]. Conterebbe perché separa prove veloci da prove a pagamento con evidenza registrata.

## Da evitare

1. Avvio a freddo da 10 a 30 secondi con viewer oltre i 60 secondi al primo tentativo: il runtime su macchina remota resta lento e il target di pochi secondi è smentito dalle loro stesse misure [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/measurements/box-gateway-v12-2026-09-07.json]. Topics gira in locale e non deve importare questa latenza.
2. Esecuzione di tool MCP senza approvazione per chiamata, inclusi quelli distruttivi [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Con sessioni parallele in worktree il rischio di effetti incrociati è maggiore.
3. Loop di riavvio su disconnessioni transienti, con CLI rilanciato e continuità dell'agente spezzata [issue #492] [issue #480]. La regola è non far mai decidere a un watchdog di rete il ciclo di vita di un agente.
4. Notifiche non durevoli con riconciliazione solo da snapshot: se il client resta offline a lungo, il segnale di cosa è successo si perde e resta solo lo stato finale [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Per una board con review serve un log durevole degli eventi.
5. Fatturazione e attivazione commerciale mai esercitate dal vivo, con prezzi e meter solo dichiarati [doc: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md]. Qualsiasi idea di billing a uso va validata con webhook reali prima di copiarla.

## Fonti

- Repository: https://github.com/The-Vibe-Company/companion
- README: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/README.md
- Stato V0 e audit dei gap: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/v0.md
- Decisioni di prodotto: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/companions-build.md
- Misura Box e gateway V12: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/docs/measurements/box-gateway-v12-2026-09-07.json
- Broker desktop: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/packages/desktop/README.md
- MCP di controllo: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/packages/control/agent.ts
- Gateway modelli: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/apps/server/src/model-gateway.ts
- Pannello di lavoro web: https://github.com/The-Vibe-Company/companion/blob/c950f6f1019bbf7f670e1f069f4c58b21a0ad240/apps/web/src/components/discussions/Workbench.tsx
- Release v0.2.0: https://github.com/The-Vibe-Company/companion/releases/tag/v0.2.0
- Issue citate: #103, #275, #480, #489, #492, #587, #631 su https://github.com/The-Vibe-Company/companion/issues
