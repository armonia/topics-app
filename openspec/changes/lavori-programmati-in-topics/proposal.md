# Lavori programmati dentro Topics

## Deciso da me
«ma io lo farei dentro topics, refactorando il possibile per utilità e pulizia e potenza condivisa, e eventualmente separare i processi se ha senso» (il proprietario, 20/11/2026).

## Perché
Oggi un lavoro a orario (un comando o un turno di agente) lo fa partire un servizio esterno nato per i canali di messaggistica. Topics ne è il telecomando: elenca, mette in pausa, rilancia e cancella (`server/routes/cron.ts`, `server/routes/agent-config.ts`), ma non può crearne uno. In più Topics ha un secondo motore a orario, quello delle card programmate (`server/services/scheduled-cards.ts`), con un suo parser. Risultato: due motori, due calcoli degli orari, la storia dei giri fuori dal DB di Topics, nessun freno comune, e chi installa Topics senza quel servizio non ha lavori programmati.

## Cosa cambia
1. **Un motore solo**, in `server/schedule/` con `shared/schedule.ts`: un lavoro ha un orario (`cron`, `every`, `at`) e un'azione (`card`, `command`, `agent`). Le card programmate diventano il primo tipo di lavoro.
2. **Un giro è una riga con uno stato**, e si lancia una volta sola: niente doppi scatti a un riavvio, niente giri che restano «in corso» per sempre.
3. **I comandi usano il registro dei processi che c'è già** (staccati dal server, riagganciati al boot), con tempo massimo e uscita salvata.
4. **Un turno di agente a orario** ha regole sue: esito dal testo finale, ritento sui guasti passeggeri, chat nuova o conservata per scelta.
5. **Consegna fuori dall'app con un adattatore solo**, configurato e vuoto di default: lo stesso dell'avviso dei consumi per progetto.
6. **Si crea e si segue un lavoro da Topics**: API, strumenti per gli agenti, vista Automazioni.
7. **Passaggio dal motore esterno senza giri persi né doppi**, poi il ponte e il motore vecchio si tolgono.

Le regole, numerate, stanno in `design.md`. Sono passate da una verifica contro il codice (tre lettori, 36 rilievi, 5 bloccanti): ogni rilievo è una regola lì dentro.

## Barra
`specs/acceptance.md`: per ogni traccia un comando che esce non-zero, una mutazione sul punto critico, e lo scenario a vista con video per l'interfaccia. Ciò che è verde resta verde: i test delle card programmate e la prova a due server continuano a passare, riscritti sulle tabelle nuove dove serve.

## Fuori
- I canali di messaggistica: restano nel loro servizio, raggiunti dall'adattatore.
- L'unificazione del dispatch notturno delle card (card ec970c40).
- Le automazioni di altri sistemi mostrate nella stessa vista (launchd, GitHub, altre macchine).
- Espressioni cron a 6 campi o con nomi e simboli (`MON`, `L`, `#`): se un lavoro da importare ne usa una, si segnala.
- Più server che decidono insieme su DB diversi: decide il primario.

## Non ancora specificato
- Se la consegna di un lavoro su un canale rientra nella conferma umana di OUTBOUND-03 (oggi vale per posta e Google) o se basta il consenso dato alla creazione del lavoro: la traccia 3 lo scrive nella spec, dopo aver letto come il prodotto vuole trattare un invio ripetuto.
- Quanto contesto conviene dare a un lavoro con agente che tiene la chat: si misura sul primo lavoro importato (token per giro), poi si sceglie il default.
