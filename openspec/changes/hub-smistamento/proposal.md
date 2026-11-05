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
Tutto ciò che viene dall'hub si vede solo se l'hub c'è: senza hub Topics resta com'è oggi, senza righe vuote.

| Sezione dell'hub | Destino | Dove va in Topics | Perché |
|---|---|---|---|
| Panoramica | unire | Si scompone nelle righe sotto; la pagina d'insieme diventa la sidebar | È la porta d'ingresso; ogni suo riquadro ha già un posto in Topics |
| Ti aspetta | rifare | Campanella > Ora, primo gruppo «Decidi tu», insieme alle attese di Topics (domande, permessi, review); scadenze in cima, poi le prime cinque e «altre N»; «Fatto» sulla riga | Un solo posto per ciò che tocca a te; oggi le voci aperte sono 27 |
| Diario | unire | Campanella > Cronologia, filtro «Automazioni e agenti»: giri falliti, «Risolvi tu», lavori di agenti e workflow, tue azioni; i giri riusciti di routine restano sulla scheda dell'automazione | 1.615 delle 1.781 righe di 7 giorni sono giri automatici riusciti: tutti insieme coprirebbero il resto |
| Lavori | rifare | Riga col nome > Sistema > nuovo livello «Agenti e lavori», che prende l'elenco di chi lavora oggi dentro Prestazioni; filtri In corso / In attesa / Finiti: sessioni di Topics e del proxy, coda dell'hub, workflow; i lavori notturni della board restano card della Board; «In calendario» va in Automazioni > Calendario | Topics non ha una vista Agenti a parte: chi lavora sta già in Sistema. Coda e workflow non sono card della Board: senza un posto loro perderebbero l'unica vista |
| Progetti | unire | Riga del progetto (fermo o in coda col motivo, % della settimana al passaggio, avviso di budget come pallino, priorità nel menu) + Consumi > Per progetto | La stessa tabella compare tre volte; il progetto ha già la sua riga |
| Account | rifare | Riga col nome > livello «Account e quote», le quote del piano in un posto solo. Account Claude (dal proxy): barre 5h e settimana, usa questo, priorità, tetti, aggiorna token, togli, acceso/spento. Codex e Muse: barre in sola lettura e «Sblocca il freno per 2 ore». Sotto, le chiavi API Anthropic di riserva con priorità e disattiva. In fondo «Come funziona il freno»: per ogni classe di lavoro i provider in ordine, e il ritmo (quota usata contro settimana passata). «Provider e chiavi» resta il livello di Topics, e Account e quote ci rimanda | Oggi le quote stanno in quattro posti. Provider e chiavi configura Topics anche per chi non ha l'hub. L'avviso di limite nella chat resta, ma legge lo stesso dato |
| Consumi | unire | La Dashboard di Topics, aperta da riga col nome > Consumi: ai suoi grafici di token e costo si aggiungono per modello e per account (Claude, dal proxy), per progetto (Claude, Codex, Muse in % della settimana), risparmio contro il listino API (solo Claude), lavori dati a Muse; importi in euro col cambio del proxy. «Consumo per progetto» esce da Sistema e diventa la sezione Per progetto | La Dashboard disegna già token e costo nel tempo; una seconda pagina di grafici sarebbe un doppione |
| Attività | unire | Account cambiato, limite raggiunto, token scaduto (account Claude) → campanella, gruppo «Quote e account»; il resto nel Log | Nessun link; è il Log già interpretato, e i fatti che contano devono arrivare da soli |
| Contesto | tenere | Riga col nome > Sistema > «Contesto degli agenti»: peso per harness (circa 15 mila token per Claude Code), file, doppioni, regole vecchie; «Cerca contraddizioni» chiede conferma perché fa lavorare un agente; le contraddizioni → campanella | Nessun link, ma deve aprirsi da Topics |
| Servizi | unire | Vista Processi > Servizi: stato (vivo, in attesa, fermo, spento), memoria, porta; in campanella solo un servizio con un problema o fermo; uno a richiesta che dorme è «in attesa», non giù | Oggi la regola conta giù anche i servizi spenti apposta: 6 su 18 |
| Automazioni | tenere | Riga sopra la Board → vista intera: voti (Va bene, Da cambiare con nota, Nota, Segnala, Non avvisarmi più), «Risolvi tu», giri, filtro per sistema (Jarvis, Mac, GitHub, PC, Workflow), tab Calendario. Sui lavori di Jarvis esegui, accendi e togli (passano da OpenClaw: col gateway spento i comandi si spengono); launchd e GitHub in sola lettura. Il pannello Cron di Topics esce | È la sezione con quasi tutti i link; il pannello Cron ne è un pezzo: due posti per gli stessi lavori no |
| Funzionalità | tenere | Vista «Funzionalità» da Cmd+K e da Sistema, mai nella sidebar: il confronto fra 16 sistemi di agenti, 172 voci, dove Jarvis è indietro (oggi 47) | Un link in 30 giorni: mappa di studio, a portata ma non in vista |
| Impostazioni | unire | Account e quote > «Rotazione e tetti»: proxy acceso, cambio automatico, strategia di rotazione, tetti 5h e settimana globali accanto a quelli per account, richieste in fila, dollaro-euro; l'interruttore «Notifiche» va nel livello Notifiche di Topics come «Avvisi del proxy degli account» | Nessun link; sono regole degli account, oggi divise su due pagine |
| Log | tenere | Vista Processi > Servizi > proxy degli account > log dal vivo (le richieste Claude che passano dal proxy) | Un log va col suo processo |
| Guscio del sito (menu, riga di stato, banda esempio) | togliere | Niente: lo sostituiscono sidebar e Cmd+K | Fa da indice a pagine che non esistono più |
| Comandi solo della tray (freni, pause, priorità di progetto) | unire | Priorità e budget: menu della riga del progetto; «Sblocca il freno per N ore»: Account e quote, sulla riga del provider; «Ferma i lavori in background per N ore» (vale per tutti): in cima ad Account e quote | Senza un posto in Topics resterebbero solo nella tray |
| Sistema piccolo + striscia | togliere | Niente: i suoi pezzi vanno nelle righe sopra | Deciso da te |
| (Topics) Sistema > Questo computer | unire | Server e gateway → Processi > Servizi; lavori di OpenClaw → Automazioni; tab aperte e archiviati restano in Prestazioni | Con Processi diventerebbe la seconda vista della stessa macchina |

**Processi.** La sezione «Processi» della colonna del progetto resta com'è: i processi avviati in quel progetto, con esito e stop. Si costruisce una vista nuova «Processi» per tutta la macchina, aperta da riga col nome > Sistema e da Cmd+K, con quattro gruppi. Mac: CPU, memoria, swap, GPU e rete della macchina con la storia di 24 ore; poi chi pesa, con memoria, GPU e rete per processo (la rete è solo il traffico verso fuori), e la CPU sui processi che l'hub misura (i più pesanti e gli alberi degli agenti), un trattino sugli altri. I numeri per processo sono di «adesso»: il censimento si rifà al più ogni 30 secondi, quando qualcuno lo legge. PC: dorme, acceso o lavora, con il perché, le misure di 24 ore, i programmi pesanti e quanti lavori gli ha mandato il Mac. Servizi. Log. «Ferma» c'è solo sugli script dei progetti, che Topics già sa fermare: l'hub legge e basta, e nessuno riavvia un servizio da qui. Un processo che è uno script di progetto porta alla sua sezione.

**Campanella.** Il pannello resta «Da guardare», con le sue tab Ora e Cronologia. Tab Ora, in quest'ordine: «Decidi tu» (pallino ambra); «Si è rotto» (automazioni fallite, servizi con un problema o fermi); «Quote e account» (limiti raggiunti, account cambiati, token scaduti); «Da guardare» (progetti sopra budget, contraddizioni del Contesto); «Finite», come oggi. Tab Cronologia: quella di oggi più il Diario filtrato. Un gruppo vuoto non si vede.

**Calendario.** La tessera fissata del calendario resta l'agenda degli appuntamenti; i promemoria e i compiti con data dell'hub sono lavori, e stanno in Automazioni > Calendario.

## Altre mosse
1. Automazioni sotto il titolo, sopra la Board; in coda «3 da sistemare» (le rotte più le da decidere), o niente se è tutto a posto. Si vede solo se l'hub c'è.
2. Il pallino della campanella è ambra solo per i «decidi tu»; per gli avvisi è grigio con la cifra.
3. La card col nome mostra ciò che mostra oggi e, sopra l'80%, la quota più calda: un segnale quando serve, niente riga fissa.
4. Cmd+K ha una voce per ogni posto nuovo: Account e quote, Consumi, Processi, Agenti e lavori, Contesto, Funzionalità, Log, Automazioni.
5. Nella barra della Board, un chip «Frenato» accanto al tetto di dispatch quando Topics tiene ferme le card di un provider (Claude o Codex sopra il 90% della finestra, o fermi su un limite), con il provider, la quota e l'ora in cui ripartono; il freno di ritmo dell'hub, che le card non le ferma, sta in Account e quote.
6. Dopo il merge, fuori da questo ramo: le voci della tray e del brief aprono Topics, e la pagina dell'hub rimanda a Topics e non serve più pagine.

## Barra
- Nessun file del client cita più il pannello Sistema piccolo o la striscia; typecheck e cancelli di lingua verdi.
- Un e2e con l'hub finto per ogni posto: campanella (i cinque gruppi nell'ordine detto), Processi (GPU e rete per processo presenti), Account e quote, Consumi nella Dashboard, Agenti e lavori (coda e workflow nei filtri), Automazioni (con i lavori di OpenClaw e senza pannello Cron), riga del progetto, Board (chip «Frenato»), Contesto, Funzionalità, Log, e Cmd+K (ogni voce apre il suo posto); video incluso. Uno con l'hub spento: nessuna riga dell'hub, niente errori.
- Mutazione: tolta la sorgente hub dalla campanella, l'e2e «decidi tu in cima» diventa rosso.
- Ogni posto consegnato è affiancato a uno screenshot della Topics di questo ramo e chiuso dal tuo ok a vista.

## Fuori
Il motore dell'hub (API, freno, scansioni, misura di GPU e rete) non cambia. Niente pagine nuove sull'hub, e le sue pagine e la tray si toccano dopo il merge. Niente app per il telefono a parte: stessi posti, nel cassetto in basso.

## Non ancora specificato
- Se la CPU di ogni processo serve davvero anche fuori dai più pesanti: aggiungerla vorrebbe dire cambiare il censimento dell'hub, che qui è fuori.

## Correzioni dopo il primo sguardo
- I mockup Campanella e Processi hanno la sidebar vecchia (GRUPPI, riga Agents, striscia in basso), e anche le foto «oggi» non sono la Topics di oggi: il confronto si rifà su screenshot di questo ramo, con la sidebar degli altri cinque.
- In quattro mockup su sei Automazioni sta sotto la Board: va sopra, come deciso; la sua coda non conta gli «ok».
- Non esiste una vista Agenti in Topics: «fra gli agenti» è il livello Agenti e lavori in Sistema, che prende l'elenco oggi in Prestazioni.
- La campanella si chiama «Da guardare» e le sue tab Ora e Cronologia: «Storico» e «Notifiche» erano nomi inventati; il gruppo è «Finite», non «Finiti».
- Campanella: i conteggi delle pastiglie non tornano con i gruppi (Decidi tu 2 contro 5, Si è rotto 3 contro 2, Quote 2 contro 3).
- Lo stesso lavoro racconta tre storie (Indice dei documenti riparato alle 22:10 e rotto alle 22:13; Backup del Mac riuscito, non partito e workflow fallito): i mockup sono una scena sola, e Backup del Mac è un job launchd.
- L'hub non ferma e non riavvia niente (il censimento è sola lettura): via «Ferma» su servizi, container e dev server altrui, «Riavvia», «Tienilo», «Lascia fermo»; resta «Ferma» sugli script dei progetti.
- Il router dei modelli gratis parte a richiesta: spento è «in attesa», non un guasto da decidere; il proxy degli account è su :3335, non :3360 (quella è l'hub).
- La CPU per processo il censimento non la dà: colonna piena solo dove l'hub la misura; niente selettore Ora / 5 min / 1 h né «media degli ultimi 5 min»: per processo c'è solo «adesso», la storia c'è per la macchina.
- PC: l'hub dà stato, perché, misure e programmi pesanti, non l'avanzamento dei lavori: via il «62%» della suite.
- I servizi «spenti» apposta non vanno in campanella: oggi la regola ne segnalerebbe 6 su 18.
- Il proxy degli account è solo Claude: nel log niente righe Codex o Muse, i comandi per account valgono per Claude, Codex e Muse hanno barre in sola lettura.
- La riserva API sono chiavi Anthropic con priorità e disattiva: niente OpenRouter né Groq, e nessun saldo o tetto in euro al mese.
- «Come funziona il freno» col 70/85/95% era inventato: il freno guarda il ritmo della settimana per classe di lavoro; Topics ferma le card al 90% della finestra.
- «Frena» non esiste come comando: esistono «Sblocca il freno per N ore» per provider e «Ferma i lavori in background» per tutti.
- Il chip «Frenato» della Board legge il fermo di Topics (Claude e Codex), che è ciò che tiene le card in Todo; «Togli il freno» non ha un comando e esce.
- I voti delle automazioni sono Va bene, Da cambiare (con nota), Nota, Segnala, Non avvisarmi più: non «Serve / Non serve».
- «Fallo ora» su un job launchd non esiste; esegui, accendi e togli valgono solo per i lavori di OpenClaw. «Board di notte» non è un sistema delle automazioni: quelle card restano sulla Board.
- Funzionalità non sono «24 accese»: è il confronto fra 16 sistemi, 172 voci, 47 dove Jarvis è indietro.
- Contesto: circa 15 mila token per Claude Code, non 38 mila né 18 mila; il controllo delle contraddizioni fa lavorare un agente e chiede conferma.
- Consumi: risparmio contro il listino solo per Claude (il proxy vede solo Claude), importi in euro; niente «Gemini 3», niente errori per modello; nomi degli account uguali in tutti i mockup.
- Il piano di Topics è Gratuito o Team, non «Topics Pro»; la riga col nome tiene Organizzazioni, Amici, Macchine e Dispositivi di oggi, e Sistema resta un livello (Prestazioni, Agenti e lavori, Processi, Contesto, Funzionalità).
- «Consumo per progetto» (non «Uso per progetto») esce da Sistema e va in Consumi: restando in tutti e due era il doppione che la mappa toglie.
- «Provider e chiavi» non si assorbe: è il livello di Topics anche senza hub, e Account e quote ci rimanda.
- «Questo computer» non aveva un destino: server e gateway vanno in Processi, i lavori di OpenClaw in Automazioni.
- Il Diario intero in Cronologia la seppellirebbe (1.615 giri riusciti su 1.781 in 7 giorni): entrano fallimenti, Risolvi tu, agenti, workflow e tue azioni.
- Nei mockup c'è un nome vero come autore e come utente: nei fixture solo segnaposto (Utente demo).
- Tray, brief e pagina dell'hub escono da questo ramo: si fanno dopo il merge, e la barra non li chiede più.
- Il ritmo della GPU non è più aperto: il censimento si rifà al più ogni 30 secondi, a vista aperta.
