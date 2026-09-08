# Conversazione, prestazioni e ciclo di sviluppo

8 settembre 2026. Seguito della [verifica generale](QUALITY-REVIEW.md), sul branch
`codex/senior-pass-20260908`. L'applicazione operativa e il suo database non sono
stati modificati. Le prove browser usano server e dati isolati.

## Conversazione del task

Il task indicato contiene due risposte di sessione con 43 chiamate a strumenti,
alternate a commenti, consegne e aggiornamenti di servizio. I nomi nativi dei
tool Topics non venivano riconosciuti dalla deduplicazione. Inoltre i turni
misti di testo e strumenti restavano tutti aperti.

Le risposte già rappresentate nella conversazione hanno ora un dettaglio della
sessione espandibile da tastiera. Il dettaglio chiuso non monta i renderer degli
strumenti. Le risposte prive di un commento corrispondente restano leggibili,
con i gruppi di lavoro concluso richiudibili nel loro ordine. Domande in attesa,
turni in corso, errori del turno e allegati restano visibili. Le note di servizio
conservano la posizione senza essere scambiate per la risposta dell'agente.

La verifica sui dati reali ha individuato anche gli allegati aggiunti solo al
campo `content`, dopo il salvataggio dei blocchi: devono restare visibili senza
costringere ad aprire tutto il lavoro della sessione. I dati privati letti per
questa diagnosi sono esclusi da Git; le regressioni usano contenuti sintetici.

## Costi eliminati

| Percorso e campione | Prima | Dopo |
|---|---:|---:|
| 20 eventi relativi ad altri progetti: callback nella board del progetto corrente | 40 | 0 |
| 20 frame identici della board: notifiche, serializzazioni e scritture della cache | 20 ciascuna | 0 |
| 20 aggiornamenti distinti ravvicinati: serializzazioni e scritture della cache | 20 | 1 |
| Apertura chat: richieste automatiche di analisi del contesto | 2 | 1 |
| Rilevamento processi: catene di timer attive dopo l'avvio | 2 | 1 |
| 8 richieste contemporanee di stato senza cache: processi `lsof` e `ps` avviati | 16 | 2 |
| 104 socket ospiti, 10 delta: query di autorizzazione | 2.080 | 80 |

Gli aggiornamenti distinti della board notificano immediatamente i lettori:
viene differita soltanto la copia persistente. La cache conserva gli ultimi 200
task e viene scaricata anche quando la pagina diventa nascosta o viene lasciata.
Il filtro degli interessi precede le query per gli ospiti, ma ogni invio effettivo
continua a verificare l'autorizzazione, comprese le revoche.

Le rilevazioni `ps` e `lsof` hanno un limite di 5 secondi. Alla scadenza viene
terminato soltanto il processo avviato dalla rilevazione e restituita la cache
disponibile. La richiesta condivisa viene liberata: un processo bloccato non
impedisce tutte le rilevazioni successive. La regressione verifica blocco,
scadenza e recupero con tempo virtuale.

I grandi snapshot iniziali WebSocket remoti applicano la stessa politica di
compressione già usata dai broadcast. Su uno snapshot sintetico: 76.411 byte
grezzi, 5.874 dopo deflate, mediana di compressione 0,17 ms. È una misura locale
del payload, non una misura del traffico reale o della latenza di rete.

## Sviluppo e testing

TypeScript conserva le informazioni incrementali in sei cache separate per
progetto e worktree. ESLint usa una cache basata sul contenuto, separata per
client e relay e invalidata anche dai lockfile. Le cache sono ignorate da Git.
Le prove hanno introdotto errori veri e verificato il successivo recupero,
inclusi file con dimensione e data invariate, import TypeScript e configurazione
ESLint modificati.

Due giri con cache: lint 5,005 e 5,201 secondi; tipi 41,907 e 22,708 secondi.
Il primo giro senza cache ha richiesto rispettivamente 100,413 e 65,288 secondi.
Il Mac era fortemente conteso (load average circa 50–63): questi tempi descrivono
le esecuzioni osservate e non consentono di attribuire alla patch un fattore
universale di accelerazione. Il lint precedente richiedeva circa 28 secondi
in condizioni di carico inferiori.

Le esecuzioni E2E hanno directory di output distinte e una prenotazione dei
processi che impedisce a una seconda esecuzione di usare le stesse porte o
cancellare i log della prima. Uscite, errori e interruzioni sono verificati con
processi reali e worker sintetici. Un'interruzione in coda non lascia una
prenotazione E2E bloccata.
Anche `SIGHUP` esegue la chiusura degli shard. Il runner rifiuta un `--output`
che farebbe condividere gli artifact; i lettori dei report richiedono la
directory della specifica esecuzione e non recuperano implicitamente prove
vecchie da una cartella globale.

Il runner unitario parallelo viene verificato contro quello seriale: stessa
selezione di file, ambiente ereditato, stesso timeout salvo richiesta esplicita.
Un fallimento iniziale deve restare tale, conservando i log: un secondo tentativo
automatico non può trasformarlo silenziosamente in successo.

## Evidenze

I log della conversazione e della board sono in
`test-results/conversation-performance/`; quelli runtime, cache e runner E2E
sono in `test-results/senior-pass/`. Le misure dei costi sopra sono riproduzioni
mirate. Non certificano un numero massimo di utenti simultanei o la latenza
su dispositivi remoti.

Browser: 44 test pertinenti verdi senza retry, poi 3 test verdi sulla gestione
finale degli allegati. Verificati anche i fotogrammi di dettaglio chiuso e aperto
e la registrazione della navigazione da tastiera. La proiezione dei dati del
task reale produce due dettagli chiusi (32 e 3 azioni non duplicate), ciascuno
con la propria immagine visibile. Il bundle finale misura 8.104.363 byte,
rispetto a 8.101.314 prima di questo seguito; budget invariato e rispettato.

**Verifica finale:** tutti i controlli statici, TypeScript, lint e sicurezza
verdi (`static-qa-verified.log`); tipi in 11 s e lint in 4 s in questa passata.
Build client e CLI riuscite; controllo di compilazione server riuscito con le
dipendenze esterne, come nel cancello di reload del progetto.

La suite completa termina con **PASS su 1.266 file**: 637 e 627 file nei due
shard, poi i due file della coda seriale. Tempo: **351,0 s**, senza retry
automatici (`unit-verified-shards.log`). La precedente esecuzione seriale della
verifica generale richiedeva 538 s; la nuova corsa è partita con load average
103,5 su 12 core. È un confronto fra esecuzioni osservate in condizioni diverse,
non un benchmark a carico controllato. Il comando seriale rimane disponibile;
il runner parallelo è esplicitamente selezionabile.

La prima corsa parallela conserva due rossi in `unit-final-shards.log`: la
fixture dei processi era nella cartella dei sorgenti server e il controllo relay
si aspettava il vecchio comando di lint. La fixture è stata spostata nei test,
mantenendola nel programma TypeScript; il controllo relay ora esegue il comando
reale anche su una violazione intenzionale. Entrambi sono stati riverificati
prima dell'ultima suite completa, senza eccezioni ai controlli.

I test che richiedono provider esterni o browser nativi reali conservano le
proprie condizioni di esecuzione: questa verifica non certifica quei servizi
o la matrice nativa multipiattaforma.

Il selettore `check:e2e-touched --list --base=3eefddc4c` individua 77 spec
correlate, oltre il limite di 8 del cancello automatico. Sono stati quindi
eseguiti esplicitamente gli otto file browser pertinenti ai flussi modificati
(44 casi), seguiti dalla riverifica dei tre casi di conversazione/contesto.
La suite browser completa resta assegnata alla verifica notturna.

## Seguito: conversazione al centro del dettaglio task

Il dettaglio apre una sola conversazione, con titolo e composer fissi. La
sessione rimane espandibile nel punto del turno; descrizione e metadati sono
disponibili dal comando Dettagli nello stesso scorrimento. Lo spazio di lavoro
si monta solo su richiesta: sostituisce la lettura nel drawer stretto e la
affianca in quello largo. Tornare alla conversazione conserva il suo stato.

La preview gia presente nei messaggi o nella consegna finale non viene ripetuta
in un pannello separato. Un allegato presente soltanto sulla card conserva un
comando compatto per aprirlo. Leggere o chiudere un task non apre o chiude piu
tab nel workspace condiviso. Eliminato anche il relativo modulo automatico.

Verifica del seguito: build client riuscita, 422 test
unitari della board verdi in 36 file e cancello QA veloce interamente verde.
Le sei spec browser pertinenti hanno prodotto 25 verdi e
un rosso per un test ancora legato ai pannelli precedenti. Adeguato il contratto
del test alla nuova interfaccia, il caso di durabilita RIGA 2 passa in una corsa
mirata senza retry. Una sola prova di conversazione viene poi eseguita con
video abilitato per registrare il comportamento; passa senza retry.

I log sono `test-results/conversation-performance/conversation-focus-*.log`.
Lo screenshot `conversation-focus.png` e i trace della corsa 13340 documentano
il layout; la corsa 13342 prova la durabilita dei dettagli e il `video.webm`
della corsa 13343 mostra apertura della sessione, allegato e ritorno alla
conversazione. Nel test con 36 tool,
il dettaglio chiuso contiene 141 nodi DOM e quello aperto 161: i componenti
tecnici si montano soltanto all'espansione. Non e un benchmark di latenza.

Il controllo sul task reale ha individuato anche le note di consegna successive
alla risposta dello stesso turno. Ora sono compatte ed espandibili, conservando
un'anteprima dell'esito visibile. Domande in prosa o strutturate, allegati e link
Markdown restano visibili per intero; la consegna fissata dei task conclusi
resta visibile. La revisione indipendente ha verificato questi casi, compresa
la differenza fra un commento di avanzamento e il successivo esito.
Build finale `index-DNa6C2ay.js`; QA finale verde (tipi 7 s, lint 2 s).
Le tre prove browser della conversazione passano dopo questa rifinitura,
senza retry e con video conservati nella corsa 13345. Log:
`conversation-focus-e2e-delivery-final.log` e
`conversation-focus-qa-delivery-final.log`.

## Azione di merge pertinente alla consegna

Il task `e1cdd61d-11d9-47a6-a1c2-2a194a8e02d3` mostrava Landa su main pur
avendo zero file modificati e nessun commit di consegna. La verifica Git del
ramo `topics/teal-magnolia` in GuidoAI conferma zero commit oltre main e diff
vuoto. Il drawer considerava sufficiente la presenza della sessione agente.

Card, dettaglio e risposte rapide ora condividono la disponibilita del merge,
derivata dai dati della consegna gia caricati. Una sessione o un ramo senza
modifiche non bastano. Le altre azioni della review restano disponibili; le
opzioni storiche con l'etichetta riservata di landing non possono reintrodurlo.
Nessuna sonda Git o richiesta per card aggiunta. Il controllo di disponibilita
usa lo snapshot registrato; il server continua a verificare lo stato effettivo
prima di qualsiasi integrazione.

Verifiche: 424 test unitari board verdi, QA veloce interamente verde e build
`index-Cu1weveH.js`. Log `task-land-*-verified.log` nella cartella delle evidenze.
Cinque test browser verdi senza retry, con video nella corsa 13347: incluso
analisi senza merge, consegna con merge e ritorno ad analisi, conservando le
altre azioni e filtrando l'opzione storica. La revisione indipendente conferma
le stesse regole per card, drawer e risposte rapide in italiano e inglese.
