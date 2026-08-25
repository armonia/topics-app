## Purpose

Il sito pubblico e i due documenti che le macchine leggono. È l'unica superficie
di Topics che parla a chi non l'ha ancora installato, ed è l'unica in cui una
frase può restare vera per mesi dopo aver smesso di esserlo.

## Background

DUE AFFERMAZIONI SONO SOPRAVVISSUTE ALLA PROPRIA VERITÀ. Erano corrette il
giorno in cui sono state scritte, e nessuna delle due poteva fallire: non c'è
compilatore che accusi una frase.

La prima diceva che il server non ha nessuno strato di autenticazione. Era vera,
poi è arrivato l'accoppiamento dei dispositivi, e la frase è rimasta su quattro
superfici. Dire a chi legge che un server in ascolto su tutte le interfacce non
ha autenticazione non è un dettaglio vecchio: è un invito a esporlo.

La seconda consegnava il nome di un file di installazione scritto a mano, con
dentro il numero di versione. Ogni rilascio ne produce uno nuovo col proprio
numero, e i rilasci qui sono automatici a ogni fusione: il collegamento smette di
funzionare al rilascio successivo.

## Requirements

### Requirement: SITE-01 — Una frase sul sito è un'affermazione, e le affermazioni scadono

Il sito pubblico e i documenti destinati alle macchine NON SHALL affermare che il
server è privo di autenticazione. La verifica SHALL essere per SIGNIFICATO e non
per una formulazione sola: la stessa affermazione è già ricomparsa altrove con
parole diverse, su una pagina che nessuno aveva pensato di controllare.

I documenti che consegnano comandi di installazione NON SHALL contenere il nome
di un file di rilascio scritto a mano. Il nome SHALL essere risolto al momento
dell'uso dall'interfaccia dei rilasci: ogni file porta il proprio numero di
versione nel nome, e un nome ricordato smette di esistere al rilascio dopo.

La verifica SHALL leggere il TESTO EFFETTIVAMENTE PUBBLICATO, non una sua fonte
intermedia: le pagine sono servite così come sono, quindi il file è l'oggetto.

> Questi due documenti sono letti da un agente, che ripeterà ciò che c'è scritto
> come un fatto. È la ragione per cui la scadenza di una frase qui costa più che
> altrove.

#### Scenario: l'affermazione riformulata
- **GIVEN** la stessa affermazione scritta con parole diverse su una pagina qualsiasi
- **THEN** SHALL essere rilevata

#### Scenario: un nome di file ricordato
- **GIVEN** un documento che consegna un file di rilascio per nome
- **THEN** SHALL essere respinto
