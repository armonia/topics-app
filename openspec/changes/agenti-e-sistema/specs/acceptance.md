# Accettazione: agenti e sistema

## Barra eseguibile
```
bun test server/agents/registry.test.ts                 # T1: agenti dalla configurazione, nessuno cablato, vuoto = stato vuoto
bun test server/agents/persona.test.ts                  # T2: base → regole dell'utente → agente, in quest'ordine, una volta sola
bun test server/agents/tool-filter.test.ts              # T5: «solo questi» arriva al turno come elenco consentito
bun test server/memory/stores.test.ts                   # T6: depositi, indice, chi li riceve
bun test server/system/health.test.ts                   # T7: ogni problema ha tipo, frase e posto dove si sistema
bunx playwright test tests/e2e/agents-navigation.spec.ts  # T3: video in videos/agents/AGENTS-01..03.webm
bunx playwright test tests/e2e/system-page.spec.ts        # T4-T7: video in videos/system/SYSTEM-01..04.webm
bun run check:deadcode && bun run check:bloat           # i popover sostituiti non restano come codice morto
```
Mutazioni che devono fare rosso:
- T1: rimettere un agente scritto nel codice → il test con una configurazione di tre agenti ne trova quattro.
- T2: saltare lo strato base nell'assemblaggio → l'agente nuovo non ha l'anima comune.
- T5: ignorare il filtro nel turno → l'agente limitato riceve uno strumento escluso.
- T7: togliere il link di un tipo di problema → il test che chiede «dove si sistema» per ogni tipo fallisce.

## Scenario: panoramica degli agenti (AGENTS-01)
Dati tre agenti nella configurazione, uno con chat WhatsApp e Discord, uno solo Discord, uno senza canali
Quando apro Agenti dalla barra laterale
Allora vedo una scheda per agente con nome, mestiere, le icone di marca dei suoi canali e il numero di chat
E l'agente senza canali dice «nessun canale» con il link per aggiungerne uno
E c'è la scheda «Nuovo agente»
E a 375 px le schede sono una colonna, senza scorrimento orizzontale

## Scenario: configurare senza perdersi (AGENTS-02)
Dato un agente con il SOUL vuoto
Quando apro la sua pagina
Allora la vista di default è Attività, e la configurazione non c'è
Quando premo Configura
Allora si apre la pagina di configurazione con la colonna delle sezioni e l'Identità aperta
E l'Anima mostra lo strato della base segnato «dalla base del sistema» e le aggiunte dell'agente vuote
E ogni sezione ha un indirizzo suo: ricaricando resto sulla stessa sezione

## Scenario: creare un agente (AGENTS-03)
Quando premo «Nuovo agente», scrivo nome e mestiere e salvo
Allora nella cartella dell'agente esiste solo IDENTITY.md
E il contesto ricevuto dall'agente nuovo contiene la base e le regole dell'utente, e il suo nome
E l'agente compare nella panoramica senza riavviare il server

## Scenario: canali come albero, ereditato senza ripetizioni (AGENTS-04)
Dato un agente con un canale Discord (un server, una categoria, due canali, un thread) e un gruppo WhatsApp
Quando apro Configura › Canali e chat
Allora vedo l'albero canale → server → categoria → canale → thread, con il marchio del canale in testa
E un canale che non cambia nulla mostra «come il server» accanto a ogni valore, non una copia del valore
Quando cambio «se citato» sul canale
Allora solo quel canale e i suoi thread cambiano, e il valore dice «suo»
E in Configura › Identità l'ereditato è una riga per cosa (anima, regole, strumenti, memoria) con «Vedi» e «Sovrascrivi» o «Filtra»

## Scenario: memorie spiegate e cercabili (SYSTEM-05)
Dati due depositi con una scheda che contiene la stessa parola
Quando apro Sistema › Memorie e cerco quella parola
Allora i risultati mostrano le due schede col loro deposito, e aprendone una vedo tipo, data, collegamenti e il testo
E in cima la pagina spiega in tre frasi indice, schede e dove vale una memoria

## Scenario: harness e contraddizioni (SYSTEM-01)
Dati la base, le regole dell'utente e due agenti
Quando apro Sistema › Harness
Allora vedo i quattro strati con il loro peso in token e, per lo strato agente, un chip per agente che apre la sua pagina
E se due fonti si contraddicono, la contraddizione dice le due fonti e porta a scegliere quale vale
E senza hub esterno la sezione «Peso per harness» dice che il dato manca e da dove arriverebbe

## Scenario: strumenti limitati (SYSTEM-02)
Dato un catalogo con due server MCP
Quando in Configura › Strumenti di un agente scelgo «solo questi» e tengo un server
Allora Sistema › Strumenti mostra quell'agente solo accanto al server tenuto
E il turno successivo dell'agente riceve solo gli strumenti di quel server

## Scenario: una memoria che nessuno riceve (SYSTEM-03)
Dato un agente con una cartella di memoria piena ma senza indice collegato
Quando apro Sistema › Memorie
Allora la riga di quel deposito dice in ambra «l'agente non la riceve» e porta alla sua sezione Memoria
E lo stesso problema compare in Sistema › Salute e nel numero accanto a «Sistema» nella barra

## Scenario: tutto ciò che è rotto in un posto (SYSTEM-04)
Dati: lavori a orario senza agente, chat senza nome, una contraddizione, una memoria non ricevuta
Quando apro Sistema › Salute
Allora c'è una riga per problema, con la frase e il bottone che apre il posto dove si sistema
E sistemato un problema, al giro dopo la riga sparisce e il numero scende

## Prova
- I video degli scenari, e gli screenshot a 375, 768, 1440 e 3440 px accanto ai mockup, nel task di Topics.
- Per T2, il contesto ricevuto da due agenti prima e dopo, con la differenza.
