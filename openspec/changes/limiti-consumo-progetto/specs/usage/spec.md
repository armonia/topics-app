## ADDED Requirements

### Requirement: USAGE-28 — Il consumo di un progetto si legge in quota della settimana, dalla salita vera degli account

`GET /api/usage/projects/quota` SHALL dire, per progetto, quanti punti della settimana Claude (100 = un account intero per una settimana) ha speso nelle ultime 24 ore e negli ultimi 7 giorni. I punti SHALL venire dalla regola di USAGE-27: la salita oraria della quota settimanale di ogni account Claude (un calo è un reset e conta il valore nuovo) divisa sulle chiamate di quell'ora per peso. Una chiamata SHALL appartenere al progetto della cartella in cui gira (chat native, sottoagenti, card, transcript di Claude Code anche aperti fuori da Topics, `usage_records`); una worktree conta per il suo progetto; ciò che non è di nessun progetto resta «fuori dai progetti». Il peso di una chiamata SHALL essere il suo prezzo di listino per il modello che l'ha servita. Una card SHALL restare sul progetto del suo task anche se la sua worktree non esiste più, e due scritture della stessa cartella SHALL essere un progetto solo. Ogni chiamata SHALL portare la sua superficie (card, chat, sottoagenti di card, sottoagenti di chat, fuori da Topics, chiamate singole) e la risposta SHALL dare per progetto punti 24h e 7gg, limite, divisione per superficie e le chat più pesanti. Il progetto SHALL mostrare «punti/limite» sulla sua riga nella sidebar (ambra dall'80% del limite, rosso sopra) e in una tabella nella Dashboard, senza nessuna pausa.

#### Scenario: due progetti nella stessa ora
- **GIVEN** un'ora in cui la quota di un account sale di 10 punti, con chiamate di peso 300 nel progetto A (chat nativa e un suo sottoagente) e 100 nel progetto B (transcript di Claude Code in una worktree di B)
- **WHEN** si legge `/api/usage/projects/quota`
- **THEN** A SHALL avere 7,5 punti e B 2,5, e la worktree SHALL contare per B

#### Scenario: senza storia della quota
- **GIVEN** nessun file di storia
- **THEN** la risposta SHALL dire `quotaHistory: false` e dare i token pesati, senza punti

### Requirement: USAGE-29 — Ogni progetto può avere un limite, e superarlo chiede una conferma esplicita

Il limite (nessuno per un progetto non configurato finché non arriva la formula della card 64b1f052; cambiabile per progetto dal suo menu, «Nessuno» per toglierlo) è della consegna 1 e si legge nel misuratore; la pausa che ne segue è della consegna 2.

Ogni progetto SHALL poter avere un limite in punti nelle ultime 24 ore (scelto dal suo menu, «Nessuno» per toglierlo); finché la card 64b1f052 non ne fissa il valore di partenza, un progetto non configurato non ha limite. Superato il limite, il progetto SHALL entrare in pausa: il dispatcher NON SHALL avviare card del progetto (restano in Todo con «In pausa: limite del progetto»), `spawn_agent` in una sessione del progetto SHALL rispondere col motivo invece di far nascere un figlio, la spinta d'obiettivo NON SHALL ripartire da sola. Il messaggio scritto da una persona SHALL partire sempre e un turno in corso SHALL finire. Un errore di lettura SHALL lasciar passare (fail-open).

#### Scenario: limite superato
- **GIVEN** un progetto senza impostazioni a 10,4 punti nelle 24 ore, con una card in Todo e una chat viva
- **WHEN** gira il dispatcher, la chat chiede `spawn_agent`, e poi la persona scrive nella chat
- **THEN** la card SHALL restare in Todo col motivo, `spawn_agent` SHALL rispondere con la pausa, e il messaggio della persona SHALL avviare il turno

### Requirement: USAGE-30 — La conferma è una sola per progetto, sincronizzata, e sblocca tutto il progetto

La pausa SHALL essere uno stato del server per progetto, mostrato uguale ovunque: in ogni chat aperta del progetto (una striscia sopra il compositore), sulla board del progetto, nella campanella, in una spinta con i tasti, e con una riga sul canale del proprietario se l'ambiente ha `TOPICS_OWNER_ALERT_COMMAND` (argv JSON, testo su stdin, con il link al progetto). Il testo SHALL dire punti, limite e le due chat o card che pesano di più col loro modello. Le scelte SHALL essere «Continua» e «Pausa fino a domani». «Continua», premuto in un posto qualsiasi, SHALL sbloccare tutto il progetto insieme (card, sottoagenti, spinte d'obiettivo) e far sparire la striscia in tutte le finestre e su tutti i dispositivi; vale per altri 10 punti, poi la conferma torna. «Pausa fino a domani» SHALL chiudere la richiesta ovunque e tenere la pausa fino alla mezzanotte locale. Ogni pausa SHALL avvisare fuori dall'app una volta sola.

#### Scenario: un ok in una chat sblocca tutto
- **GIVEN** un progetto in pausa, aperto in due chat su due finestre, con una card in Todo e il comando d'avviso configurato
- **WHEN** si preme «Continua» nella prima chat
- **THEN** la striscia SHALL sparire anche nella seconda finestra senza ricaricare, la card SHALL partire al giro dopo, un `spawn_agent` nella seconda chat SHALL far nascere il figlio, e il comando d'avviso SHALL essere partito una volta sola

#### Scenario: la conferma torna dopo altri 10 punti
- **GIVEN** lo stesso progetto sbloccato a 10,4 punti
- **WHEN** arriva a 20,4
- **THEN** il progetto SHALL tornare in pausa e chiedere di nuovo
