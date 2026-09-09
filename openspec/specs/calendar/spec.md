## Purpose

Il calendario dentro Topics: cosa succede quando si FISSA la pagina di un
calendario, da dove arrivano gli eventi, e quanto di questa cosa è configurabile
senza aprire un file.

La domanda a cui risponde è una sola, ed è la stessa che rende utile un
calendario fissato in Arc o in Dia: **cosa ho adesso e cosa ho dopo**, senza
cambiare finestra e senza aspettare che una pagina web si carichi.

## Background

Fissare una tab è già una dichiarazione: quella cosa la guardo tutti i giorni.
Per un calendario, «guardarla» vuol dire leggere due righe — la prossima
riunione e il link per entrarci — e per quelle due righe si apriva una pagina
intera.

L'integrazione con un account Google via OAuth avrebbe voluto un client id (e un
segreto) dentro un repository pubblico e una verifica del fornitore prima che la
schermata di consenso smetta di chiamare questa app «non sicura». Gli stessi
eventi il fornitore li pubblica già come feed iCalendar — l'«indirizzo segreto
in formato iCal» — che funziona identico su Google, Apple, Outlook, Proton e
Fastmail. Una colonna nel database invece di un deposito di credenziali, e
l'integrazione non è legata a un fornitore solo.

## Requirements

### Requirement: CAL-01 — Il feed è un indirizzo, e quell'indirizzo è un segreto

La sorgente degli eventi SHALL essere un feed iCalendar indicato da chi usa
l'app. Lo schema `webcal://` SHALL essere accettato e normalizzato in `https`;
uno schema che non sia `http` o `https` SHALL essere RIFIUTATO alla scrittura e
mai passato alla rete.

L'indirizzo SHALL restare sulla macchina: nessuna risposta dell'agenda SHALL
contenerlo.

Finché nessuno ha configurato il feed, NIENTE SHALL essere richiesto alla rete.

#### Scenario: un indirizzo che non è http
- **GIVEN** un indirizzo `file:///etc/passwd` scritto nel campo del feed
- **THEN** la scrittura SHALL essere rifiutata
- **AND** nessuna lettura SHALL essere tentata

### Requirement: CAL-02 — Si tira, non si sonda; e un errore non cancella l'agenda

La sincronizzazione SHALL essere a RICHIESTA: l'intervallo configurato SHALL
essere l'ETÀ MASSIMA dell'agenda in cache, non il periodo di un timer. Un'app che
nessuno sta guardando NON SHALL fare richieste.

Una richiesta ENTRO l'età massima SHALL essere servita dalla cache; oltre, SHALL
rileggere il feed. Un aggiornamento FORZATO SHALL saltare il controllo di
freschezza e nient'altro.

Una lettura FALLITA SHALL conservare gli eventi già letti, SHALL riportare il
motivo in una riga, e SHALL lasciare il momento dell'ultima lettura RIUSCITA
dov'era: un errore di rete non è «oggi non hai niente».

#### Scenario: il feed cade dopo una lettura riuscita
- **GIVEN** un'agenda già letta
- **WHEN** la lettura successiva fallisce
- **THEN** gli eventi SHALL restare
- **AND** il motivo SHALL essere dichiarato

### Requirement: CAL-03 — Gli eventi ricorrenti si espandono davvero

Le regole di ricorrenza SHALL essere espanse in OCCORRENZE: giornaliera,
settimanale, mensile e annuale, con INTERVAL, COUNT, UNTIL, BYDAY e BYMONTHDAY.
Le date escluse (EXDATE) NON SHALL comparire, e una singola occorrenza
MODIFICATA (RECURRENCE-ID) SHALL sostituire quella della serie invece di
aggiungersi.

Un evento SHALL comparire se SI SOVRAPPONE alla finestra, non solo se comincia
dentro: una riunione cominciata venti minuti fa è quella in cui sei.

L'orario di un'occorrenza SHALL seguire l'OROLOGIO DA PARETE del fuso dell'evento
attraverso i cambi d'ora.

L'espansione SHALL essere LIMITATA: una regola malformata SHALL costare un lavoro
finito, non un blocco.

#### Scenario: la ricorrenza attraversa il cambio d'ora
- **GIVEN** un evento alle 9:00 di un fuso con ora legale
- **THEN** le occorrenze dopo il cambio SHALL essere ancora alle 9:00 di quel fuso

### Requirement: CAL-04 — Fissare il calendario dà una piccola anteprima al hover, non un pannello al click

La tessera FISSATA di una pagina di calendario SHALL mostrare una piccola
anteprima al passaggio del mouse o al focus da tastiera: uno screenshot della
sessione browser GIÀ aperta per quel fissaggio, mai un nuovo browser e mai il
feed ICS configurato in Settings (quel sottosistema resta per CAL-01..CAL-03,
ma non è più la fonte di questa anteprima).

Il click SHALL continuare ad attivare/aprire la tab, come per ogni altra
tessera fissata — non ad espandere un pannello.

Su un dispositivo senza puntatore ad hover (touch), il tap SHALL attivare
direttamente la tessera: l'anteprima non SHALL comparire prima.

Una pagina che non è un calendario NON SHALL avere questa anteprima.

#### Scenario: hover mostra l'anteprima, il click apre comunque la tab
- **GIVEN** la pagina di un calendario fissata con una sessione browser già aperta per quel fissaggio
- **WHEN** si passa il mouse sulla tessera
- **THEN** SHALL comparire una piccola anteprima presa da quella sessione
- **WHEN** si clicca la tessera
- **THEN** la tab SHALL attivarsi, come per ogni altra tessera fissata

#### Scenario: touch salta l'anteprima
- **GIVEN** la stessa tessera su un dispositivo senza hover
- **WHEN** si tocca la tessera
- **THEN** SHALL attivarsi direttamente, senza che l'anteprima compaia prima

### Requirement: CAL-05 — Le manopole sono chiuse, e spegnere non cancella

Frequenza di aggiornamento e orizzonte dell'agenda SHALL essere insiemi CHIUSI
di valori: un valore fuori insieme SHALL essere rifiutato alla scrittura invece
di essere scritto e poi disatteso.

L'interruttore e l'indirizzo SHALL essere due impostazioni distinte: spegnere la
sincronizzazione NON SHALL cancellare l'indirizzo.

Un cambio di configurazione SHALL invalidare l'agenda in cache: dopo aver
cambiato indirizzo nessuna risposta SHALL venire dal calendario precedente.

#### Scenario: si spegne e si riaccende
- **GIVEN** un feed configurato e la sincronizzazione accesa
- **WHEN** la si spegne
- **THEN** l'indirizzo SHALL restare scritto
