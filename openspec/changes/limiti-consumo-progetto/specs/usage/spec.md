## ADDED Requirements

### Requirement: USAGE-28 — Il consumo di un progetto si legge in quota della settimana, dalla salita vera degli account

`GET /api/usage/projects/quota` SHALL dire, per progetto, quanti punti della settimana Claude (100 = un account intero per una settimana) ha speso nelle ultime 24 ore e negli ultimi 7 giorni. I punti SHALL venire dalla stessa regola di USAGE-27: la salita oraria della quota settimanale di ogni account Claude (un calo è un reset e conta il valore nuovo) divisa sulle chiamate di quell'ora per peso. Una chiamata SHALL appartenere al progetto della cartella in cui gira: chat del motore nativo, sottoagenti (la cartella del sottoagente, o del genitore se manca), card, transcript di Claude Code nella cartella di un progetto (anche aperti fuori da Topics) e `usage_records` con la sua sessione. Una worktree SHALL contare per il suo progetto. Ciò che non ha cartella o non appartiene a nessun progetto SHALL restare nel totale come «fuori dai progetti», mai sommato a un progetto a caso. Senza la storia della quota la risposta SHALL dirlo e dare solo i token pesati.

#### Scenario: due progetti nella stessa ora
- **GIVEN** un'ora in cui la quota di un account sale di 10 punti, con chiamate di peso 300 nel progetto A (chat nativa e un suo sottoagente) e 100 nel progetto B (transcript di Claude Code in una worktree di B)
- **WHEN** si legge `/api/usage/projects/quota`
- **THEN** A SHALL avere 7,5 punti e B 2,5, e la worktree SHALL contare per B

#### Scenario: senza storia della quota
- **GIVEN** nessun file di storia
- **THEN** la risposta SHALL dire `quotaHistory: false` e dare i token pesati, senza punti

### Requirement: USAGE-29 — Una soglia di consumo superata avvisa il proprietario una volta al giorno, anche fuori dall'app

Ogni progetto SHALL avere una soglia d'avviso sulle 24 ore (15 punti di default, cambiabile per progetto, 0 = spenta) e un budget della settimana opzionale. Superata la soglia delle 24 ore, l'80% del budget o il budget, il server SHALL scrivere una riga di sistema nella campanella (ATTN-10: non accende nessuna chat), mandare una spinta e, se l'ambiente ha `TOPICS_OWNER_ALERT_COMMAND` (argv JSON), eseguirlo per argv con il testo su stdin. Il testo SHALL dire progetto, punti, soglia, le due chat o card che pesano di più e il modello che usano. Ogni soglia SHALL avvisare una volta per progetto e giorno; un comando che fallisce SHALL lasciare la riga col motivo e riprovare al giro dopo, al massimo tre volte.

#### Scenario: il caso del 17/11
- **GIVEN** un progetto a 16 punti nelle 24 ore con soglia 15 e il comando d'avviso configurato
- **WHEN** gira il controllo, e poi gira di nuovo un'ora dopo a 20 punti
- **THEN** il comando SHALL ricevere una volta un testo con il nome del progetto, «16», «15» e la chat che pesa di più, e la seconda volta SHALL NOT partire niente

#### Scenario: nessun comando configurato
- **GIVEN** `TOPICS_OWNER_ALERT_COMMAND` vuoto
- **THEN** la riga e la spinta SHALL esserci e nessun processo SHALL partire

### Requirement: USAGE-30 — A budget pieno il progetto si frena, e una persona passa sempre

Con il budget della settimana raggiunto il dispatcher NON SHALL avviare card del progetto (restano in Todo con «Aspetta il budget del progetto», riprendono al reset o alzando il budget), `spawn_agent` in una sessione del progetto SHALL rispondere con il motivo invece di far nascere un figlio, e la spinta d'obiettivo NON SHALL ripartire da sola. Il messaggio scritto da una persona SHALL partire sempre, e un turno in corso SHALL finire. «Togli il freno» dal menu del progetto SHALL togliere il freno fino alla mezzanotte locale. Un errore di lettura SHALL lasciar passare (fail-open), come il freno di spesa.

#### Scenario: budget pieno
- **GIVEN** un progetto con budget 10 a 10,2 punti della settimana, una card in Todo e una chat viva
- **WHEN** gira il dispatcher, la chat chiede `spawn_agent`, e poi la persona scrive nella chat
- **THEN** la card SHALL restare in Todo col motivo, `spawn_agent` SHALL rispondere col freno, e il messaggio della persona SHALL avviare il turno

#### Scenario: freno tolto a mano
- **GIVEN** lo stesso progetto
- **WHEN** si sceglie «Togli il freno»
- **THEN** la card SHALL partire al giro dopo, e il freno SHALL tornare dopo la mezzanotte
