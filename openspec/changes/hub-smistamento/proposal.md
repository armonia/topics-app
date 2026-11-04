# Hub dentro Topics: dove va ogni pezzo

## Deciso da me
- Il pannello Sistema piccolo e la striscia in fondo alla sidebar escono («piccola e brutta»).
- «Ti aspetta» e gli avvisi vanno nella campanella, a gruppi chiari, i «decidi tu» per primi.
- Mac, processi e servizi vanno nei Processi di Topics, con GPU e rete per processo.
- Consumi e Account vanno nella riga col nome in fondo alla sidebar.
- Lavori e sessioni vanno fra gli agenti e nella Board.
- Automazioni diventa una riga della sidebar sopra la Board, che apre una vista intera.
- Su :3360 non resta niente che si veda solo lì: Contesto, Funzionalità, Log e Impostazioni compresi.

## Perché
Oggi l'hub è un secondo sito da aprire a parte, e lo stesso dato compare in più posti: le quote quattro volte, la quota per progetto tre, la storia dei giri due. Topics ha già quasi tutti i posti giusti: si sposta lì e si toglie il doppione.

Uso: nessuna fonte misura il tempo per sezione. Nel browser, 26 minuti di finestra attiva sull'hub in 30 giorni, in 13 giorni (non contato: l'hub aperto dalla tray o dentro Topics). Ingressi trovati: Panoramica è la pagina d'arrivo; Automazioni riceve quasi tutti i link (tray, brief del mattino, 35 link) ed è l'unica dove risultano tuoi voti e note (circa 9, dal 23 al 29/10); Lavori ha un link dalla tray, Funzionalità uno, Progetti solo da dentro l'hub; Diario, Account, Consumi, Attività, Contesto, Servizi, Impostazioni e Log non ne hanno nessuno. Nessuna voce «Ti aspetta» risulta chiusa dalla pagina.

## Cosa cambia
| Sezione dell'hub | Destino | Dove va in Topics | Perché |
|---|---|---|---|
| Panoramica | unire | Si scompone nelle righe sotto; la pagina d'insieme diventa la sidebar | È la porta d'ingresso; ogni suo riquadro ha già un posto in Topics |
| Ti aspetta | rifare | Campanella > Ora, primo gruppo «Decidi tu», insieme alle attese di Topics (domande, permessi, review); scadenze in cima; «Fatto» sulla riga | Un solo posto per ciò che tocca a te, che apri comunque |
| Diario | unire | Campanella > Storico, filtro «Automazioni e agenti»; l'esito di «Risolvi tu» arriva sulla scheda dell'automazione e nello Storico | Nessun link d'ingresso; ripete la storia dei giri della scheda di ogni automazione |
| Lavori | rifare | Nuovo livello «Agenti e lavori» (riga col nome > Sistema, dove oggi c'è l'elenco di chi lavora), filtri In corso / In attesa / Finiti: sessioni di Topics e del proxy, coda dell'hub, workflow; i lavori notturni della board restano card della Board; «In calendario» va in Automazioni > Calendario | Coda e workflow non sono card della Board: senza un posto loro perderebbero l'unica vista |
| Progetti | unire | Riga del progetto (freno o fermo in coda, % della settimana al passaggio, avviso di budget come pallino) + Consumi > Per progetto | La stessa tabella compare tre volte; il progetto ha già la sua riga |
| Account | rifare | Riga col nome > livello «Account e quote»: assorbe «Provider e chiavi» e le quote del piano; un riquadro per account con barre 5h/settimana e tutti i comandi (usa questo, priorità, tetti, aggiorna token, togli, acceso/spento); sotto, gli account API di riserva con priorità e disattiva; in fondo «Come funziona il freno» (classe di lavoro → provider) | Oggi account e chiavi stanno in due posti, le quote in quattro: qui ne resta uno solo. L'avviso di limite nella chat resta, ma legge lo stesso dato |
| Consumi | unire | La Dashboard di Topics, aperta da riga col nome > Consumi: ai suoi grafici di token e costo si aggiungono per modello, per account, per progetto, risparmio contro l'API, Muse | La Dashboard disegna già token e costo nel tempo; una seconda pagina di grafici sarebbe un doppione |
| Attività | unire | Account cambiato, limite raggiunto, token scaduto → campanella, gruppo «Quote e account»; il resto nel Log | Nessun link; è il Log già interpretato, e i fatti che contano devono arrivare da soli |
| Contesto | tenere | Riga col nome > Sistema > «Contesto degli agenti» (peso per harness, controlli, file); le contraddizioni → campanella | Nessun link, ma deve aprirsi da Topics; sta accanto a «Uso per progetto», anche lui in token |
| Servizi | unire | Vista Processi > Servizi (stato, memoria, porta); un servizio fermo → campanella | Nessun link; sono processi, e quelli fermi vanno avvisati |
| Automazioni | tenere | Riga sopra la Board → vista intera: voti, note, «Risolvi tu», giri, tab Calendario; assorbe il pannello Cron di Topics (avvia, accendi, togli sui lavori di OpenClaw), che esce | È la sezione con quasi tutti i link; il pannello Cron ne è un pezzo: due posti per gli stessi lavori no |
| Funzionalità | tenere | Vista «Funzionalità» da Cmd+K e da Sistema, mai nella sidebar | Un link in 30 giorni: mappa di studio, a portata ma non in vista |
| Impostazioni | unire | Account e quote > «Rotazione e tetti» (proxy, cambio automatico, tetti globali accanto a quelli per account, dollaro-euro, beta); l'interruttore «Notifiche» va nel livello Notifiche di Topics come «Avvisi del proxy degli account» | Nessun link; sono regole degli account, oggi divise su due pagine |
| Log | tenere | Vista Processi > Servizi > proxy degli account > log dal vivo | Un log va col suo processo |
| Guscio del sito (menu, riga di stato, banda esempio) | togliere | Niente: lo sostituiscono sidebar e Cmd+K | Fa da indice a pagine che non esistono più |
| Comandi solo della tray (freni, pause, priorità di progetto) | unire | Priorità: menu della riga del progetto; freni e pause: Account e quote, sulla riga del provider | Senza un posto in Topics resterebbero solo nella tray |
| Sistema piccolo + striscia | togliere | Niente: i suoi pezzi vanno nelle righe sopra | Deciso da te |

**Processi.** La sezione «Processi» della colonna del progetto resta com'è: i processi avviati in quel progetto, con esito e stop. Si costruisce una vista nuova «Processi» per tutta la macchina, aperta da riga col nome > Sistema e da Cmd+K, con quattro gruppi: Mac (chi pesa, con CPU, memoria, GPU e rete per processo e la finestra di misura), PC (dorme o acceso, lavori in corso), Servizi, Log. Un processo che è uno script di progetto porta alla sua sezione.

**Campanella.** Tab Ora, in quest'ordine: «Decidi tu» (pallino ambra); «Si è rotto» (automazioni fallite, servizi fermi); «Quote e account» (limiti raggiunti, account cambiati, token scaduti); «Da guardare» (progetti sopra budget, contraddizioni del Contesto); «Finiti», come oggi. Tab Storico: lo storico di oggi più il Diario. Un gruppo vuoto non si vede.

**Calendario.** La tessera fissata del calendario resta l'agenda degli appuntamenti; i promemoria e i compiti con data dell'hub sono lavori, e stanno in Automazioni > Calendario.

## Altre mosse
1. Automazioni sotto il titolo, sopra la Board; in coda «2 da sistemare», o niente se è tutto a posto. Si vede solo se l'hub c'è.
2. Il pallino della campanella è ambra solo per i «decidi tu»; per gli avvisi è grigio con la cifra.
3. La card col nome mostra la quota più calda solo sopra l'80%: un segnale quando serve, niente riga fissa.
4. Le voci della tray e del brief del mattino aprono Topics (Automazioni, Calendario, campanella), non :3360.
5. Cmd+K ha una voce per ogni posto nuovo: Account e quote, Consumi, Processi, Agenti e lavori, Contesto, Funzionalità, Log, Automazioni.
6. Nella barra della Board, un chip «Frenato» accanto al tetto di dispatch quando una classe di lavoro è ferma, con il motivo: spiega perché le card non partono.
7. A fine migrazione la pagina dell'hub rimanda a Topics e non serve più pagine: resta solo il servizio dati.

## Barra
- Nessun file del client cita più il pannello Sistema piccolo o la striscia; typecheck e cancelli di lingua verdi.
- Un e2e con l'hub finto per ogni posto: campanella (i cinque gruppi nell'ordine detto), Processi (GPU e rete per processo presenti), Account e quote, Consumi nella Dashboard, Agenti e lavori (coda e workflow nei filtri), Automazioni (con i lavori di OpenClaw e senza pannello Cron), Board (chip «Frenato»), Contesto, Funzionalità, Log, e Cmd+K (ogni voce apre il suo posto); video incluso. Uno con l'hub spento: nessuna riga dell'hub, niente errori.
- La pagina dell'hub risponde con un rimando a Topics e nessuna pagina; ogni link della tray e del brief apre Topics.
- Mutazione: tolta la sorgente hub dalla campanella, l'e2e «decidi tu in cima» diventa rosso.
- Ogni posto consegnato è affiancato alla foto di oggi e chiuso dal tuo ok a vista.

## Fuori
Il motore dell'hub (API, freno, scansioni, misura di GPU e rete) non cambia. Niente pagine nuove sull'hub. Niente app per il telefono a parte: stessi posti, nel cassetto in basso.

## Non ancora specificato
- Quanto spesso la vista Processi chiede GPU e rete: la misura c'è già nell'hub, ma per ora a ogni lettura; il ritmo si decide guardando il suo peso a vista aperta.
