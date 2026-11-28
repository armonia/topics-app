# Acceptance: posta-per-gli-agenti

Ogni barra è un comando che esce non-zero se la regola non vale. I test usano un adattatore finto (nessuna rete, nessuna casella vera), un orologio finto e, dove serve, due connessioni sullo stesso file SQLite.

## E5 Invio una volta sola (P8)
`bun test` dei file toccati dell'invio esce 0 e copre:
- Corretto: riavvio fra invio e registrazione → nessun secondo invio; `sending` trovato al riavvio → `unknown`, non rilanciato, detto alla persona; conferma data dopo un riavvio → un solo invio, fatto dal server dalla riga; esito `failed` → definitivo per quella chiave.
- Efficace: due chiamate con lo stesso contenuto → due domande e due invii; una chiamata coi suoi tentativi → una domanda e un invio.
- DRY: un solo registro delle consegne: la posta scrive in `deliveries` (`kind = 'mail'`) e nessuna migrazione della traccia crea una tabella nuova (`git diff origin/main --name-only -- server/db/migrations` mostra solo la ricostruzione di `deliveries`, che SQLite chiede per cambiare il CHECK degli stati). Il conteggio con `grep -c` della prima stesura conta anche i nomi dei file e le tabelle di altri lavori (`pending_deliveries`, `webhook_deliveries`): già 4 su main, non misura la regola.
- `send_mail` restituisce l'id del messaggio quando l'adattatore lo dà.
Mutazioni: tolto lo stato `sending` il test del riavvio è rosso; con la chiave uguale al digest il test «stesso contenuto due volte» è rosso.
Ciò che è verde resta verde: i test del cancello di conferma e quelli della consegna dei lavori.
Migrazione provata su un DB sintetico; backup di `data/topics.db` prima di creare il file.

## E1 Ricezione (P1, P2)
`bun test server/mail/inbox` esce 0 e copre:
- Corretto: lo stesso messaggio due volte → una riga; arresto a metà della transazione → niente scritto, cursore fermo, al giro dopo nessun buco e nessun doppione; cursore scaduto → finestra riletta, nessun messaggio saltato; adattatore che esce non-zero, risponde JSON non valido o supera 30 s → errore sul giro, cursore fermo; un messaggio con mittente uguale a un indirizzo della casella è marcato come proprio.
- Completo: nessuna casella → nessun processo lanciato; casella con i due interruttori spenti → non letta; casella nelle impostazioni e stessa casella nelle variabili d'ambiente → valgono le impostazioni.
- Cadenza: 60 s; 15 s con un'attesa che scade entro 30 minuti (orologio finto, conta delle chiamate).
- Avvisi: tre errori di fila → un avviso; ultima lettura più vecchia di 10 minuti con attese aperte → un avviso; due giri → non due avvisi.
- Efficiente: una chiamata `list` per casella per giro; due server sullo stesso file → un solo giro alla volta.
- Performante: con 10.000 righe, scrivere un messaggio e abbinarlo sta sotto 5 ms (numero stampato dal test).
- DRY: una sola funzione scrive in `mail_messages` (`/usr/bin/grep -rn "INSERT INTO mail_messages" server --include='*.ts' | /usr/bin/grep -vc "\.test\."` → 1).
- Contratto: la stessa serie di prove passa sull'adattatore finto e su quello di riferimento per Gmail con risposte registrate.
Mutazioni: messaggi e cursore in due transazioni → il test dell'arresto è rosso; ripartenza «da adesso» → il test del cursore scaduto è rosso.
Migrazione provata su un DB sintetico; backup di `data/topics.db` prima di creare il file.

## E2 Attese (P3, P4, P5)
`bun test server/mail/waits` esce 0 e copre:
- Efficace: mail arrivata prima dell'attesa → trovata alla creazione; arrivata dopo → una sveglia; mail arrivata in ritardo con una data vecchia nell'intestazione → trovata (conta l'istante di ricezione).
- Corretto, una volta sola: due connessioni → una sveglia; arresto fra scrittura del messaggio e abbinamento → impossibile (stessa transazione), e il test lo prova fermando a metà; riavvio fra turno aperto e consegna segnata → un solo turno (chiave); un messaggio già consegnato a un proprietario non abbina un'altra sua attesa; un messaggio che abbina due attese dello stesso proprietario completa la più vecchia.
- Corretto, criteri: mail di un altro mittente → nessun abbinamento; oggetto, conversazione e «risposta a» provati uno per uno; mittente giusto con `dmarc` non passato o `Authentication-Results` di un altro `authserv-id` → nessun abbinamento e motivo scritto.
- Corretto, rifiuti: senza mittente, senza scadenza, oltre 30 giorni, casella sconosciuta, interruttore spento.
- Scadenza: `expired` e una sveglia anche con la ricezione ferma; mail arrivata dopo la scadenza → nessuna seconda sveglia; annullata → nessuna sveglia; proprietario chiuso → attesa annullata.
- Card: parcheggiata fino alla scadenza dell'attesa; col giro di controllo vero e l'orologio portato a 72 ore, turni aperti = 0. Chat: un turno, segnato come non scritto da una persona.
- Sicurezza: la sveglia non contiene il corpo; un oggetto con dentro istruzioni e la chiusura della cornice resta dentro la cornice; lunghezze limitate.
- Istantaneo: `wait_for_mail` risponde sotto 100 ms (misurato). La ricezione è a cadenza: a sessione libera la sveglia arriva entro la cadenza più 5 s.
Mutazioni: tolto `AND status='open'` → il test delle due connessioni è rosso; tolta la ricerca alla creazione → «arrivata prima» è rosso; rinvio col tetto di 24 ore → il test dei turni a 72 ore è rosso; abbinamento senza controllo del mittente → «altro mittente» è rosso.
`wait_for_condition` e il risveglio a fine comando restano verdi dai loro test.

## E3 Si vede (P6)
Scenario con video `tests/e2e/mail-wait.spec.ts`, a 375 e 1440 px: una card e una chat che aspettano mostrano mittente, casella, da quando e scadenza; «annulla» toglie l'attesa; l'elenco delle attese aperte; stati: nessuna casella, ultima lettura fallita, scaduta. Accessibilità (axe). A vista: foto a 375, 768 e 1440 px.

## E4 Leggere (P7)
`bun test server/mail/read` esce 0 e copre: `read_mail` passa dall'adattatore; casella con l'interruttore spento o sconosciuta → rifiuto che la nomina; un corpo che contiene la chiusura della cornice non la chiude; `search_mail` non lancia processi.
Mutazione: cornice fissa al posto di quella calcolata sul testo → il test della chiusura è rosso.

## E6 Regole (P9)
`bun test server/mail/rules` esce 0 e copre: una mail e due giri → le azioni una volta; arresto a metà delle azioni → al riavvio le mancanti una volta, le fatte no; ordine rispettato; un proprio invio non fa scattare regole; mittente non verificato → la regola sul mittente non scatta; la card nata da una mail non contiene oggetto né corpo e nasce senza avvio; condizione di classe senza modello configurato → rifiutata al salvataggio; azione bozza su un adattatore senza `draft` → rifiutata; un test di tipo fallisce se qualcuno aggiunge un'azione di invio; il modello riceve solo intestazioni ed estratto.
Mutazione: oggetto nel titolo della card → il test del testo fisso è rosso.
Scenario a vista per l'elenco delle regole e la storia delle azioni, a 375 e 1440 px.

## Tutte
Ciò che è verde resta verde.
`openspec validate posta-per-gli-agenti` esce 0.
