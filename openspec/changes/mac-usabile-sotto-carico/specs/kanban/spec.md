# Delta: kanban (mac-usabile-sotto-carico)

## MODIFIED Requirements

### Requirement: KANBAN-15 — Prima della review i comandi girano, e un rosso che non ha misurato niente non è un rosso

Una board SHALL poter dichiarare fino a `MAX_CHECKS` comandi che una consegna
deve far passare prima di entrare in review. I comandi SHALL essere DICHIARATI da
una persona nelle impostazioni della board: nessun default SHALL essere dedotto
dal progetto. SHALL girare nel worktree DELLA CONSEGNA, in sequenza e
nell'ordine dichiarato, e SHALL fermarsi al primo rosso.

Una riga dichiarata può essere un check di EVIDENZA invece di un comando: la riga
`github-ci:e2e` (`E2E_CI_CHECK`). Quella riga NON SHALL essere passata a una
shell, SHALL essere misurata DOPO tutti i comandi, qualunque sia la sua posizione
nell'elenco, e solo se sono tutti verdi, secondo KANBAN-84. Il suo esito entra nel
verdetto come quello di un comando: il suo «non misurato» è `unknown`, il suo
rosso è `fail`, e un elenco di esiti che non la contiene è più corto dei comandi
dichiarati.

Quando al worktree mancano le dipendenze, il sistema SHALL installarle PRIMA dei
comandi dichiarati. Senza, i cancelli morivano su un'uscita 127 indistinguibile
da un rosso vero — otto task in un giorno, il 13/08/2026.

Il verdetto SHALL avere TRE valori e mai due: `pass`, `fail`, `unknown`. Un
comando SCADUTO, uno che NON È PARTITO, e un elenco di esiti più corto dei
comandi dichiarati SHALL dare `unknown`. Misurato il 18/08/2026 sul database
vivo: sei card su quindici marcate `fail` erano soltanto scadute — il 40% dei
rossi accusava il codice per un guasto della macchina.

Un rosso VERO accanto a uno scaduto SHALL restare `fail`: il dubbio non
cancella una prova.

Il cancello NON SHALL vivere dentro la richiesta HTTP. Una suite può durare più
del tempo che una socket resta aperta, e quando quel tempo scadeva lo stato
restava «in corso» per sempre. Mentre i comandi girano la richiesta SHALL
rispondere «in corso» con un codice proprio, e la card SHALL restare dov'era.
Un rosso SHALL rifiutare la transizione con un codice proprio, e la card SHALL
tornare all'agente.

Le corse SHALL essere condivise per chiave: N richieste sullo stesso task
producono UN giro di comandi. Un commit diverso SHALL far rimisurare. Una corsa
che esplode SHALL liberare la chiave invece di avvelenare la successiva. Il
numero di corse simultanee SHALL avere un tetto, e il default SHALL essere UNO:
il 18/08/2026 sei barre in parallelo hanno portato il carico a 78,83 su dodici
core.

Il tetto conta le corse che eseguono COMANDI. Una corsa che, finiti i comandi,
aspetta soltanto la rete SHALL restituire il suo posto: la prima corsa in coda
SHALL partire subito, e la corsa restituita NON SHALL contare fra le corse che il
dispatcher somma al carico. SHALL restare viva per tutto il resto: le richieste
sulla sua chiave rispondono «in corso», e chi aspetta il suo verdetto lo riceve.

Il verdetto SHALL sopravvivere alla richiesta che l'ha chiesto per una finestra
dichiarata.

Il tetto di tempo di un comando SHALL contare dal momento in cui il comando
PARTE, non da quando è stato lanciato: i comandi passano da `scripts/slot.ts`,
che prima aspetta uno slot libero della macchina (core/4), e quell'attesa non
è tempo del comando. Fino al 05/09/2026 il board la contava: sotto una flotta
la sola coda superava i dieci minuti, `test:unit` veniva ucciso mentre ancora
aspettava di partire, e la card leggeva «timeout» di una suite che non aveva
eseguito un test. `slot.ts` SHALL scrivere su stderr una riga riconoscibile
quando ottiene lo slot, con i secondi di coda; il runner dei check SHALL
leggere stderr man mano e da quella riga far ripartire il tetto; il commento
sulla card SHALL dire il tempo di esecuzione e, a parte, quello di coda.

Il semaforo dei cancelli NON SHALL spegnersi per i check della board. I comandi
girano con `CI=1` (Playwright lo legge), e `CI` senza un conteggio esplicito
spegneva il semaforo: il 15/09/2026 due `test:unit:shards` di due card hanno
girato affiancati per 741 e 744 secondi, entrambi «0 s in coda». Il runner dei
check SHALL quindi passare il numero di slot in modo esplicito (quello
dell'ambiente del server se c'è, altrimenti il default della macchina), e un
valore esplicito, `0` compreso, SHALL arrivare intatto.

Un comando NUOVO NON SHALL partire con la memoria libera sotto il pavimento
(`DISPATCH_MEM_FLOOR_NATIVE_GB`, 6 GB). Nessun freno davanti a un check leggeva
la memoria, e l'ammissione non ne vede il costo: la card entra a memoria libera
e consegna decine di minuti dopo un albero unit da 4-11 GB. Il comando SHALL
aspettare PRIMA di partire, e l'attesa NON SHALL consumare il suo tetto. SHALL
fallire aperto: un giro aspetta al massimo 30 minuti IN TOTALE, poi i comandi
rimasti partono comunque; una lettura non disponibile non fa aspettare.

Uno spegnimento del server SHALL portarsi via gli alberi dei check in corso, e
NON SHALL scriverne un verdetto. `slot.ts` lancia il comando in un gruppo di
processi suo, e al riavvio l'albero restava vivo figlio di pid 1 mentre il
server nuovo rilanciava i check delle stesse card: il 15/09/2026 alle 02:04
quattro alberi unit vivi insieme, due orfani. Un comando ucciso dallo
spegnimento non ha misurato niente: il giro SHALL interrompersi senza esito e
nessun comando successivo SHALL partire. «Senza esito» NON è «nessun check»: il
cancello lo riportava come `null`, la stessa parola di una board senza comandi,
e la consegna passava in review con i check ancora «in corso» a ogni reload del
watcher. La consegna in attesa di quel giro SHALL rispondere come una gamba
ancora in volo (202 `review_checks_running`), NON con un errore, e la card NON
SHALL muoversi. L'agente non SHALL ritentare a mano: il client (`update_task`)
richiama da solo, trova il socket chiuso dall'uscita e ritenta quel silenzio
dentro la sua grazia di trasporto, e dopo il riavvio un giro nuovo rimisura la
consegna. Un 503 arrivava invece all'agente come errore, e l'agente richiamava
subito dentro il server morto. Una consegna che arriva mentre il server si sta
spegnendo SHALL aspettare la sua gamba prima della stessa risposta, senza
riallineare il ramo: risposta subito, il client richiamerebbe a raffica per
tutta l'uscita, spendendo una gamba a chiamata.

#### Scenario: con CI il semaforo resta acceso
- **GIVEN** due check della board sullo stesso cancello, con `CI=1` e nessun conteggio nell'ambiente del server
- **THEN** SHALL girare uno dopo l'altro, e uno dei due SHALL riportare il tempo di coda

#### Scenario: sotto il pavimento di memoria il comando aspetta
- **GIVEN** memoria libera sotto il pavimento per 1,5 s e un tetto di 1 s
- **THEN** il comando SHALL partire solo dopo, e finire verde e non scaduto
- **AND** con la memoria sempre sotto, il giro SHALL aspettare il suo limite UNA volta e poi far partire tutti i comandi

#### Scenario: lo spegnimento non inventa un rosso
- **GIVEN** un check in corso e un secondo in attesa
- **WHEN** il server si spegne
- **THEN** l'albero del primo SHALL essere ucciso, il secondo NON SHALL partire, e il giro SHALL finire senza verdetto

#### Scenario: lo spegnimento non manda in review una consegna senza check
- **GIVEN** una card in lavorazione che consegna con `PATCH status=review`, e la sua gamba in volo su un check `sleep 120` (oppure su un giro fermo nell'attesa di memoria)
- **WHEN** il server ferma i check
- **THEN** la risposta SHALL essere 202 `review_checks_running`, la stessa di una gamba in volo, e la card SHALL restare `in_progress`
- **AND** una consegna che arriva prima dell'uscita SHALL aspettare la sua gamba prima della stessa risposta, senza riallineare il ramo

#### Scenario: il client di update_task attraversa il riavvio da solo
- **GIVEN** una consegna con i check in corso e il client MCP `update_task` in attesa
- **WHEN** le gambe ricevono in fila 202, 202 interrotta dallo spegnimento, `ECONNREFUSED` e poi 200 dal server nuovo
- **THEN** `update_task` SHALL risolversi con la card in `review`, senza errori per l'agente

#### Scenario: la coda per lo slot non consuma il tetto
- **GIVEN** un comando che aspetta 1,5 s uno slot, stampa la riga di `slot.ts` e poi lavora 1,5 s, sotto un tetto di 2 s
- **THEN** il comando SHALL finire verde, non ucciso, e l'esito SHALL riportare il tempo di coda

#### Scenario: senza la riga il tetto conta dal lancio
- **GIVEN** lo stesso comando senza la riga di `slot.ts`
- **THEN** SHALL essere ucciso al tetto, come prima

Il tetto SHALL seguire anche un rallentamento che il comando DICHIARA prima di
cominciare. Sotto carico il runner della suite unit dimezza gli shard (4 → 2)
perché aggiungere processi a una macchina già piena li rallenta tutti: la stessa
suite ci mette circa il doppio, e quel doppio è la decisione, non un guasto. Il
comando SHALL poter scrivere su stderr una riga riconoscibile col fattore di
rallentamento; il runner dei check SHALL moltiplicare il tetto per quel fattore,
UNA volta, con un massimo dichiarato; il commento sulla card SHALL nominare il
piano ridotto, così che un verde da mezz'ora non sembri un tetto mai applicato.
Misurato sulla card `40dc7674` il 05/09/2026: verde in 7m59s a 4 shard, oltre i
20 minuti del tetto fisso a 2 shard con la flotta attiva, e una consegna
corretta rifiutata tre volte per una ragione che col suo codice non c'entrava.

Il massimo SHALL restare: oltre quello il comando non è lento, è appeso.

#### Scenario: il rallentamento dichiarato allunga il tetto
- **GIVEN** un comando che dichiara la riga di rallentamento e poi lavora più del tetto base
- **THEN** SHALL finire verde, e l'esito SHALL riportare il fattore dichiarato

#### Scenario: nessuna dichiarazione, nessuno sconto
- **GIVEN** lo stesso comando senza quella riga
- **THEN** SHALL essere ucciso al tetto base

Sulla card SHALL essere scritto lo stato, gli esiti parziali e il commit
misurato. Il commento del VERDE SHALL essere una riga sola e di specie servizio:
l'elenco completo su ogni consegna verde erano 92 copie identiche in sette
giorni. Il commento del ROSSO SHALL essere per esteso e di specie ordinaria — è
la sola cosa che l'agente deve leggere.

Il progresso SHALL essere «fatti su totale» fin dal primo istante, e numeri
incoerenti SHALL essere scartati invece che mostrati.

Una configurazione illeggibile SHALL spegnere il cancello, non sollevare un
errore.

#### Scenario: mentre i comandi girano, la chat dell'agente lo dice
- **GIVEN** una consegna a cui il cancello ha risposto «in corso» e un tool `update_task` ancora aperto nel turno dell'agente
- **WHEN** il client richiama e il cancello risponde di nuovo «in corso»
- **THEN** il tool in corso SHALL mostrare quanti comandi sono passati, quale gira, quali aspettano e da quanto, e SHALL dire che l'attesa è del cancello e non dell'agente
- **AND** in coda dietro un'altra card SHALL dirlo, senza inventare un comando in corso

#### Scenario: un comando che non è mai partito
- **GIVEN** un worktree in cui un comando non può nemmeno avviarsi
- **THEN** l'esito SHALL essere `unknown`, non `fail`
- **AND** il testo SHALL dire che non è partito, e NON SHALL parlare di tempo massimo

#### Scenario: dieci richieste sullo stesso task
- **GIVEN** dieci richieste concorrenti sulla stessa chiave
- **THEN** SHALL girare un solo giro di comandi

#### Scenario: la riga di evidenza non va a una shell e viene dopo i comandi
- **GIVEN** una board che dichiara `github-ci:e2e` PRIMA di `true`
- **WHEN** una card consegna e la CI risponde verde
- **THEN** `true` SHALL girare per primo, la riga `github-ci:e2e` NON SHALL essere eseguita da `sh`, e la consegna SHALL entrare in review con due esiti verdi

#### Scenario: una corsa che aspetta la rete restituisce il posto
- **GIVEN** un tetto di UNA corsa, la card A che ha finito i comandi e aspetta la CI, la card B in coda
- **THEN** B SHALL partire mentre A aspetta
- **AND** A SHALL contare zero fra le corse del dispatcher, e le richieste di A SHALL rispondere «in corso»

#### Scenario: la configurazione è rotta
- **GIVEN** impostazioni di board illeggibili
- **THEN** il cancello SHALL essere spento, e la consegna SHALL procedere come
  su una board che non ne dichiara


## ADDED Requirements

### Requirement: KANBAN-84 - L'e2e di una consegna lo misura la CI della PR sul commit consegnato, mai un browser su questa macchina

Una board SHALL poter dichiarare fra i suoi check la riga `github-ci:e2e`
(`E2E_CI_CHECK`). Fino al 15/09/2026 il check e2e della board era
`bun run check:e2e-touched`, che lancia Playwright con Chromium nel worktree
dell'agente: quella notte gli agenti hanno scaricato `chromium-1217` nella cache di
questo Mac per farlo girare, contro la regola della postazione. La stessa misura, e
di più, gira già nella CI di ogni pull request.

**Il commit.** La misura SHALL riguardare ESATTAMENTE il commit su cui la board ha
misurato i comandi (quello dopo il riallineamento su main). Il server, e mai
l'agente, SHALL spingere quel commit sul ramo della card
(`<sha>:refs/heads/<ramo>`, non `HEAD`) e SHALL aprire una pull request in bozza
verso main, o riusare quella aperta per quel ramo. Titolo e corpo NON SHALL
contenere il testo della card: ramo, id corto e commit corto bastano. Una spinta
rifiutata perché il ramo remoto non avanza SHALL forzare solo se la testa remota
compare nel reflog del ramo locale, con quella testa come lease; altrimenti
qualcun altro ha scritto sul ramo, il ramo remoto NON SHALL essere toccato e
l'esito SHALL essere «non misurato».

Una consegna senza commit propri oltre main NON SHALL spingere niente né aprire PR,
e SHALL essere verde con la nota «nessun commit proprio oltre main»: la domanda del
check è l'e2e di ciò che la consegna cambia, e fermarla fermerebbe le consegne che
non cambiano file (10 su 129 misurate col check di prima, che rispondeva verde).

**Il verdetto.** SHALL venire dalla run più recente (`id` più alto) del workflow
`.github/workflows/ci.yml`, evento `pull_request`, con `head_sha` uguale al commit,
e SOLO dai job `prepare-e2e` ed `e2e (N)`:
- VERDE solo se esiste almeno un job e2e e sono tutti conclusi `success`;
- ROSSO se sono tutti conclusi e almeno uno è `failure`: il referto SHALL nominare
  ogni job rosso e il comando che ne stampa il log
  (`gh run view --job <id> --log-failed -R <repo>`), insieme al link della PR e
  della run;
- NON MISURATO in ogni altro caso, con il motivo in testa al referto e l'uscita 97
  di KANBAN-15: nessuna run per quel commit, run annullata o superata,
  `prepare-e2e` non verde, un job e2e annullato, saltato o scaduto senza nessun
  `failure`, nessun job e2e nella run, una PR in conflitto con main, `git` o `gh`
  assenti o non autenticati, cinque letture di fila fallite, nessun verdetto entro
  60 minuti dalla spinta.

Un verdetto SHALL valere solo per il commit che ha misurato. Una gamba di consegna
arrivata con la testa del worktree su un altro commit, mentre la corsa del commit
precedente è ancora viva, NON SHALL portarsi via il verdetto (né il nulla) di quella
corsa: SHALL rispondere 202 `review_checks_running`, e la gamba dopo SHALL misurare la
testa attuale. L'attesa della CI arriva a 60 minuti, e senza questa regola una card
entrava in review, e poi landava, su un commit che nessun check aveva visto.

Un lettore della CI che lancia un'eccezione diversa dallo spegnimento SHALL dare
«non misurato» con il messaggio dell'eccezione: prima diventava il nulla di una corsa
esplosa, che la consegna legge come «nessun check», e la card entrava in review senza
verdetto e2e. Una risposta di GitHub che esce 0 senza l'elenco atteso
(`workflow_runs`, `jobs`) SHALL contare come lettura fallita.

La spinta SHALL passare dalla guardia `pre-push` del repository anche quando parte da
un worktree, con l'elenco dei nomi tolti dalla storia letto dal checkout principale
(il file non è tracciato, e un worktree non ne ha una copia): fino al 15/09/2026 da un
worktree la guardia non trovava l'elenco, usciva 0 e la consegna pubblicava i commit
intermedi prima della review. Una spinta fermata dalla guardia SHALL essere «non
misurato», e il ramo remoto NON SHALL riceverla.

Il testo di un «non misurato» della CI NON SHALL consigliare di installare le
dipendenze del worktree, e il testo di un rosso SHALL dire che sono rossi gli e2e
della CI invece di un codice di uscita.

**L'attesa.** Mentre aspetta la CI la corsa SHALL restituire la sua corsia (KANBAN-15),
NON SHALL avere un processo figlio vivo fra un sondaggio e l'altro, e il turno della
card NON SHALL prenotare memoria nell'ammissione del dispatcher. SHALL restare una
corsa viva: la consegna risponde 202 `review_checks_running`, il giudice del silenzio
e lo spazzino dei tool la leggono come attesa nostra, e uno spegnimento del server la
interrompe senza verdetto (fra un sondaggio e l'altro se ne accorge entro un secondo). Il client di `update_task` SHALL aspettare
più a lungo della scadenza della CI sommata al giro locale più lento misurato (29,2
minuti fra il 08/09 e il 15/09/2026). Il primo sondaggio SHALL essere immediato, così
che dopo un riavvio la run dello stesso commit si legga senza rispingere e senza
aspettare.

**I testi.** Quando la board dichiara la riga, l'envelope di kickoff SHALL dire
all'agente che: i comandi locali sono quelli elencati; l'e2e gira sulla CI dopo la
spinta del server, sul commit esatto; il ramo diventa pubblico in quel momento; su
questa macchina non si lancia Playwright né un browser e non se ne installa uno;
`bun run check:e2e-touched --list` mostra le spec toccate; un rosso torna col nome del
job e il comando del log; un «non misurato» non è un rosso ma tiene la card fuori dalla
review. La riga NON SHALL comparire fra i comandi da eseguire, né nel kickoff né in
quello di fan-out. `docs/board-protocol.md` SHALL portare la stessa regola.

**Anche senza la riga.** Ogni envelope di kickoff, di qualunque board, SHALL dire
all'agente che su questa macchina non lancia `check:e2e-touched` (tranne `--list`),
`playwright test`, build del client fatte per gli e2e, né installa o avvia un browser,
in primo piano o in background; che l'e2e lo scrive o lo cambia nella spec; e che
`bun test <file>` mirato resta ammesso. Il 15/09/2026, in 15 ore, gli agenti avevano
lanciato da sé 21 `check:e2e-touched`, 71 `playwright test` e 27 build del client, 99
su 119 in background con `&`, e la board li rifaceva alla consegna.

Chi misura quella spec SHALL dirlo una riga sola, secondo la board. Con la riga
`github-ci:e2e`: la CI del ramo, letta dalla board alla consegna. Senza: l'envelope
NON SHALL affermare che la board legge una CI, e SHALL dire che questa board non misura
l'e2e, che nessuno spinge il ramo alla consegna, e di scrivere nel commento di consegna
il percorso della spec cambiata (la misura la CI del progetto quando il ramo si
pubblica, o il PC). Il fan-out dice lo stesso nel suo resoconto finale. Il 15/09/2026
le board di quattro altri progetti non dichiaravano la riga, e la regola di
prima diceva a tutti che la board leggeva la CI del ramo.

Il ramo video della regola dell'anteprima NON SHALL nominare Playwright,
`recordVideo` o Chromium in nessuna forma, nemmeno per un'altra macchina. Una tab del
task che nessuna finestra mostra gira in un browser headless avviato su questa
macchina, e `screencapture -R` filmerebbe lo schermo di chi lavora: la clip SHALL
essere `screencapture` di una superficie già a schermo, per una pane browser solo dopo
`browser_focus_tab`; altrimenti la prova del comportamento SHALL essere la sua spec
e2e, nominata nel commento di consegna, con uno screenshot o un diagramma come
anteprima.

#### Scenario: tutti i job e2e verdi sul commit consegnato
- **GIVEN** una board con `true` e `github-ci:e2e`, e una run `pull_request` del commit consegnato con `prepare-e2e` ed `e2e (1)`..`e2e (4)` conclusi `success`
- **WHEN** la card consegna
- **THEN** la card SHALL entrare in review con `checksState: pass`
- **AND** il referto della riga SHALL portare il link della PR e della run

#### Scenario: una run verde di un altro commit non vale
- **GIVEN** una run verde il cui `head_sha` è un altro commit, oppure una run `push` verde dello stesso commit, e nessuna run `pull_request` del commit consegnato
- **THEN** l'esito NON SHALL essere verde

#### Scenario: la run più recente è annullata
- **GIVEN** due run `pull_request` dello stesso commit, la più vecchia verde e la più recente annullata
- **THEN** l'esito SHALL essere «non misurato»

#### Scenario: un job e2e rosso
- **GIVEN** `e2e (2)` concluso `failure` e gli altri `success`
- **THEN** l'esito SHALL essere `fail`, la risposta alla consegna SHALL essere 409 `review_needs_green_checks`
- **AND** il testo SHALL contenere `e2e (2)` e il comando `gh run view --job <id> --log-failed`

#### Scenario: gli shard non sono partiti
- **GIVEN** `prepare-e2e` concluso `failure` e i job e2e `skipped`
- **THEN** l'esito SHALL essere «non misurato», e il motivo SHALL nominare `prepare-e2e`

#### Scenario: GitHub non risponde o `gh` non è autenticato
- **GIVEN** `gh` che esce con un errore di autenticazione quando cerca la PR
- **THEN** l'esito SHALL essere «non misurato» subito, senza sondare le run

#### Scenario: la CI non finisce
- **GIVEN** job e2e ancora in corso per 60 minuti dalla spinta
- **THEN** l'esito SHALL essere «non misurato» con il link della run, e MAI verde

#### Scenario: la PR è in conflitto con main
- **GIVEN** nessuna run del commit dopo 5 minuti e la PR `CONFLICTING`
- **THEN** l'esito SHALL essere «non misurato» con il conflitto come motivo, prima della scadenza

#### Scenario: un ramo remoto scritto da qualcun altro
- **GIVEN** una spinta rifiutata e una testa remota che il reflog del ramo locale non contiene
- **THEN** il server NON SHALL forzare, e l'esito SHALL essere «non misurato»
- **AND** con una testa remota che il reflog contiene, il server SHALL forzare con quella testa come lease

#### Scenario: la testa cambia durante l'attesa della CI
- **GIVEN** una consegna su `abc1234` con la CI in attesa, e la testa del worktree passata a `def5678`
- **WHEN** arriva una seconda gamba e poi la CI di `abc1234` risponde verde
- **THEN** la seconda gamba SHALL rispondere 202 e la card SHALL restare `in_progress`
- **AND** la gamba dopo SHALL chiedere la CI di `def5678`, e la card SHALL entrare in review con `checksCommit` `def5678`

#### Scenario: il lettore della CI lancia un'eccezione
- **GIVEN** un lettore che lancia `TypeError`, oppure `gh api` che esce 0 con `{"total_count":0}`
- **THEN** l'esito SHALL essere «non misurato» e la consegna SHALL rispondere 409, con la card `in_progress`

#### Scenario: la guardia dei nomi ferma la spinta da un worktree
- **GIVEN** un worktree con un commit intermedio che contiene un nome dell'elenco del checkout principale, tolto dal commit dopo
- **THEN** la spinta SHALL fallire, l'esito SHALL essere «non misurato», nessuna PR SHALL essere aperta e il ramo remoto NON SHALL esistere

#### Scenario: una consegna senza commit propri
- **GIVEN** un ramo senza commit oltre main
- **THEN** il server NON SHALL spingere né aprire una PR, e la riga SHALL essere verde con la nota

#### Scenario: un rosso locale non spinge niente
- **GIVEN** un comando locale rosso
- **THEN** la CI NON SHALL essere letta e il commit NON SHALL essere spinto

#### Scenario: l'attesa non costa memoria all'ammissione
- **GIVEN** due card in attesa della CI e una terza in coda, con una prenotazione di memoria che per le prime due la terrebbe ferma
- **THEN** la terza SHALL partire

#### Scenario: lo spegnimento durante l'attesa
- **GIVEN** una consegna in attesa della CI
- **WHEN** il server ferma i check
- **THEN** la risposta SHALL essere 202 `review_checks_running`, la card SHALL restare `in_progress` e nessun verdetto SHALL essere scritto

#### Scenario: l'envelope non manda a lanciare l'e2e qui
- **GIVEN** una board che dichiara `bun run typecheck` e `github-ci:e2e`
- **THEN** il kickoff SHALL elencare `bun run typecheck` fra i comandi, NON SHALL elencare `github-ci:e2e`, e SHALL dire che l'e2e gira sulla CI e che qui non si lancia un browser

#### Scenario: l'envelope vieta l'e2e locale anche a una board senza la riga
- **GIVEN** una board che dichiara solo `bun run typecheck`
- **THEN** il kickoff SHALL dire di non lanciare `check:e2e-touched`, `playwright test` e le build del client per gli e2e su questa macchina, e che `bun test <file>` resta ammesso
- **AND** il kickoff SHALL dire che questa board non misura l'e2e e di nominare la spec nel commento di consegna, e NON SHALL dire che la board legge la CI
- **AND** il ramo video della regola dell'anteprima NON SHALL contenere `playwright`, `recordVideo` o `chromium` in nessuna forma, e SHALL legare `screencapture` a una superficie già a schermo e a `browser_focus_tab`
