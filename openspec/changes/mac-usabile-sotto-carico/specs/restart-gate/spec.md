# Delta: restart-gate (mac-usabile-sotto-carico)

## ADDED Requirements

### Requirement: RGATE-07 — Una consegna che sta solo ASPETTANDO non trattiene il riavvio

Un turno di card in volo il cui unico lavoro è ASPETTARE i nostri check
pre-review — l'attesa di memoria, la spaziatura fra i rilasci, lo swap
sostenuto, la coda del cancello dei check, il sondaggio fuori corsia della CI
della pull request — NON SHALL trattenere un riavvio pianificato. Non trattiene
neanche il suo stream: un turno di card passa da `/api/chat`, quindi la sua
sessione è anche una chiave degli stream vivi, e lasciata lì tratterrebbe il
riavvio una seconda volta come chat non riadottabile.

«Solo aspettando» si legge da due registri, mai dalla riga della card: il
cancello dei check dice che una corsa è VIVA, il registro del governatore dice
se un comando di quella corsa è stato davvero lanciato. Corsa viva e nessun
comando lanciato = sta aspettando. Una corsa con un comando IN CORSO trattiene
il riavvio come oggi: quei minuti sono una misura, e tagliarli la butta via. Il
dubbio — un registro che non risponde — SHALL trattenere, come ogni altro dubbio
di questo cancello.

Perché è lecito tagliarla: la consegna è RICORDATA e riemessa dal processo dopo
(vedi sotto). Perché è necessario: il 15/09/2026 le due attese si tenevano a
vicenda. La card cdc9f39b aveva consegnato, il suo `update_task` era fermo sui
nostri check, e i check erano fermi nell'attesa di memoria su un Mac in swap —
niente di nostro stava girando. Il cancello ha contato «1 turno/i di card della
board non tornerebbe se lo tagliassi» e ha rinviato il riavvio per 31 minuti
(«riavvio RINVIATO da 1924s»), mentre il drain teneva in coda sette altre card
su «Riavvio del server in arrivo». Il riavvio aspettava i check, i check
aspettavano memoria che un Mac in swap non restituiva, e al fallimento aperto
dell'attesa (30 minuti) sarebbero partiti comandi pesanti su quello stesso Mac.
A finirla è stato un SIGTERM a mano.

#### Scenario: una consegna ferma nell'attesa di memoria
- **GIVEN** un riavvio pianificato, una card in volo la cui corsa di check è viva senza nessun comando lanciato, e altre card in coda
- **THEN** il cancello NON SHALL contarla fra ciò che trattiene, né come card né come chat
- **AND** il riavvio SHALL procedere senza aspettare

#### Scenario: un comando dei check sta girando
- **GIVEN** la stessa card con un comando dei check effettivamente lanciato
- **THEN** il riavvio SHALL essere rinviato come oggi
- **AND** oltre il tetto lungo SHALL partire la notifica di riavvio trattenuto: un'attesa senza fine può essere accettabile, muta no

#### Scenario: una consegna ferma sul sondaggio della CI
- **GIVEN** una corsa che ha restituito la corsia e aspetta solo la CI della pull request
- **THEN** il riavvio NON SHALL essere trattenuto da quella card

### Requirement: RGATE-08 — La consegna tagliata da un riavvio torna da sola, ed è la STESSA consegna

Il server SHALL ricordare, fuori dalla memoria del processo, la consegna a cui
ha risposto «i check stanno ancora girando», con il corpo della richiesta come
l'agente l'ha mandata e il commit che la corsa stava misurando. Al boot SHALL
riemettere quella richiesta a se stesso per ogni card ancora in lavorazione.

«Ancora in lavorazione» SHALL voler dire `in_progress`, e nient'altro. Review e
done sono oltre la consegna; backlog e todo sono una card che qualcuno si è
ripreso — il bottone «Ferma» la parcheggia in backlog, il reconcile del boot
rimette in coda l'orfano del processo ucciso. Per quelle la riga SHALL essere
solo DIMENTICATA, senza lanciare niente: riemetterla faceva girare la barra
intera (tsc, eslint, `bun test`, vite) subito dopo un riavvio avvenuto perché la
memoria era sotto il pavimento, scriveva `checks_state = 'pass'` e il commento
di servizio su una card ferma, e si fermava solo alla transizione finale con un
409 — la suite era già girata e il badge verde era già lì. Lo stato SHALL essere
riletto anche al momento della riemissione, non solo quando la riga viene
caricata: il giro di ripresa gira mentre il router si costruisce, il reconcile
del dispatcher rimette in coda più tardi e in asincrono.

La consegna riemessa SHALL essere la STESSA: nessun riallineamento in più su
main (il worktree è già sull'albero che il primo riallineamento ha prodotto, e
un secondo `git merge main` scriverebbe un merge che nessuno ha chiesto),
nessun verdetto rosso, nessun tentativo consumato. Il commit ricordato SHALL
essere quello che QUESTO giro stava misurando — il checkout letto dopo il
riallineamento — e non l'ultima misura scritta sulla card: una consegna tagliata
prima di arrivare al checkout non ha riallineato niente, e prendendo in prestito
il commit vecchio (che su una riconsegna senza commit nuovo è proprio l'HEAD del
worktree) il boot la leggeva come «stessa consegna» e saltava l'unico
riallineamento che le serviva, misurando una base che main si era lasciata
indietro.

Senza questo, il taglio di RGATE-07 non sarebbe gratuito: il turno dell'agente
muore col processo e con lui il suo `update_task`, quindi nessuno tornerebbe a
chiedere e la card resterebbe `in_progress` con la spia dei check spenta al boot.

#### Scenario: il riavvio taglia una consegna in attesa
- **GIVEN** una consegna la cui corsa di check è stata interrotta dallo spegnimento
- **WHEN** il processo dopo riparte
- **THEN** la consegna SHALL essere riemessa dal server sullo stesso commit
- **AND** i check SHALL girare una volta sola in più, senza un secondo riallineamento
- **AND** la card SHALL entrare in review se sono verdi, senza righe rosse nel thread

#### Scenario: la card è stata fermata o rimessa in coda mentre il server era giù
- **GIVEN** una consegna ricordata la cui card è uscita da `in_progress` (parcheggiata in backlog dal bottone «Ferma», o rimessa in `todo` dal reconcile del boot)
- **WHEN** il processo dopo riparte
- **THEN** la riga SHALL essere cancellata senza riemettere niente
- **AND** nessun comando dei check SHALL partire, e `checks_state` SHALL restare quello che era

#### Scenario: il riavvio taglia la consegna prima del riallineamento
- **GIVEN** una consegna a cui il cancello ha risposto «ancora in corso» senza aver mai risolto un checkout, su una card che porta il commit di una misura precedente
- **WHEN** il processo dopo riparte
- **THEN** la consegna riemessa SHALL riallinearsi su main prima di misurare
