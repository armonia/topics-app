## Purpose

Il comando da terminale: cosa risponde quando il servizio c'è, e cosa risponde —
soprattutto — quando non c'è.

## Background

UN COMANDO CHE PARLA CON UN SERVIZIO PASSA LA MAGGIOR PARTE DELLA SUA VITA A NON
TROVARLO. Il servizio non è avviato, è stato riavviato, il file di stato è vecchio
di due giorni. Ognuna di quelle è una frase diversa da scrivere a chi ha appena
premuto invio.

## Requirements

### Requirement: CLI-01 — Ogni esito ha il proprio codice, e l'assenza del servizio ha la propria frase

L'aiuto SHALL uscire con successo ed elencare i comandi disponibili. Un comando
SCONOSCIUTO SHALL uscire con un codice PROPRIO, distinto dal fallimento di un
comando valido.

Senza il file di stato, la richiesta di stato SHALL dire che il servizio NON È
AVVIATO, e la richiesta di fermarlo SHALL dire che non c'è niente da fermare —
non un errore.

Con un file di stato VECCHIO e nessun servizio vivo SHALL essere dichiarato
IRRAGGIUNGIBILE: è un terzo caso, diverso da «non avviato» e da «funziona».

Un percorso che NON ESISTE SHALL uscire con un errore che dice cosa manca.

Le forme abbreviate SHALL fare la stessa cosa di quelle per esteso.

Lo scollegamento SHALL togliere ciò che aveva scritto ed essere IDEMPOTENTE.

Il banco SHALL girare su una cartella personale ISOLATA: non deve poter toccare la
configurazione di chi lo esegue.

#### Scenario: un file di stato vecchio
- **GIVEN** nessun servizio vivo e uno stato rimasto
- **THEN** SHALL essere dichiarato irraggiungibile, non «non avviato»

#### Scenario: un comando sconosciuto
- **GIVEN** una parola che non è un comando
- **THEN** SHALL uscire con il proprio codice

### Requirement: CLITRANS-01 — La CLI prova il cifrato per primo, e ripiega SOLO se il trasporto tace

Il server accende il cifrato da sé appena trova i certificati. Una CLI che scrive
il protocollo in chiaro a mano muore sul PRIMO scambio contro un'installazione
reale: non degradata, non funzionante.

Lo schema SHALL essere provato CIFRATO per primo, e il ripiego in chiaro SHALL
avvenire SOLO quando il trasporto non ha risposto. Un errore di protocollo È una
risposta: ripeterlo in chiaro non lo cura, lo nasconde.

Se NESSUNO dei due risponde SHALL essere dichiarato, non scelto uno a caso.

Una dichiarazione esplicita dello schema SHALL forzare la mano e NON SHALL
ripiegare: chi lo dice sa cosa vuole.

La destinazione SHALL restare il ciclo interno: MAI un host che non sia
l'indirizzo locale.

#### Scenario: un errore del server
- **GIVEN** una risposta di errore sul canale cifrato
- **THEN** NON SHALL essere ritentato in chiaro

#### Scenario: schema forzato
- **GIVEN** lo schema dichiarato esplicitamente
- **THEN** NON SHALL esserci nessun ripiego
