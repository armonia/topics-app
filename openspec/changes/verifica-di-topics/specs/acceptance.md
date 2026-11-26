# Barra della Verifica di Topics

Ogni barra si esegue così com'è scritta. Exit diverso da zero = non fatto.

## T1 · Giro dei 5 minuti
- `bun test server/services/topics-check.test.ts`. Ogni caso del 21/11 dà la sua voce rossa con il suo numero:
  - nodo con posti 4→0 per 9 ore su 12 → voce 2 rossa, «9 h»;
  - 27 spostamenti verso una macchina spenta in 24 h → voce 1 rossa, «27 rimbalzi»;
  - card in corso in attesa di una persona da 2 giorni, senza turno → voce 1 rossa, con la causa «in attesa di una persona»;
  - 11 corse in 35 minuti sulla stessa card → voce 1 rossa, «rimbalzi».
- Ogni soglia ha una mutazione: spostata di uno, fa fallire il suo test.
- Un comando di `checks` che esce 1 o supera il tetto d'orologio rende rossa la voce 3. Senza `checks` la voce 3 è verde e dice «nessuna prova dichiarata».
- Contatore nel test: zero chiamate a modelli in 288 giri (24 ore).
- Tempo: un giro sotto i 50 ms su una copia in sola lettura del DB vero (misura nel resoconto).
- Migration provata su un DB sintetico.
- e2e con video: la riga «Verifica di Topics» nella vista Automazioni, verde e poi rossa con il suo dettaglio. Screenshot a 375, 768, 1440 e 3440 px.
- Restano verdi: `bun run typecheck:server`, `bun run gates:fast`.

## T2 · Cure delle cause note
- `bun test server/services/topics-check-cures.test.ts`, con una coppia di casi per ogni cura: la causa c'è → la cura la toglie e scrive la riga; la causa non c'è → nessuna scrittura.
- Una cura che non toglie il rosso al giro dopo apre una sola card d'indagine per chiave. Al quarto problema nello stesso giorno, con tetto 3, la card non si apre e la riga lo dice.
- Senza board scelta: nessuna card, nessun errore.
- Mutazione sulla chiave del problema: due problemi diversi non si fondono in una card.

## T3 · Giro giornaliero
- `bun test server/services/topics-check-daily.test.ts`, con modello finto. Una sola chiamata al giorno, anche se il giro viene chiamato due volte. L'input contiene solo firme d'errore mai viste nei 7 giorni prima: il test semina una firma vecchia e una nuova.
- Il verdetto rosso del modello apre una card; uno verde non scrive niente oltre la riga.
- Modello non raggiungibile: la riga dice «lettura non fatta» con il motivo, e il giro dei 5 minuti non ne risente.

## T4 · Meno sentinelle
- Un elenco «prima → dopo» delle sentinelle esterne toccate, con il comando che prova che ognuna tolta non segnalava nulla che la Verifica non segnali.
- Diff netto negativo sulle righe delle sentinelle esterne.
