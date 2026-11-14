# fase-ci: il tuo «fatto» atterra da solo, la CI misura a lotti, il rosso torna all'agente

## Deciso da Attilio (14/11)

«Se per me una cosa è fatta, se la CI si rompe torna indietro solo se ha bisogno di un mio parere,
altrimenti si sistema da sola». Una fase CI fra review e done, con i test accorpati in coda.
Le card tecniche verdi atterrano da sole (regola del 09/11).

## Perché

Misurato il 14/11 sulla board topics-app, ultimi 14 giorni: 104 card chiuse a mano, mediana 4,8 ore
in review, 45 oltre le 8 ore; ogni card entra in review 3,1 volte in media. Tre buchi:
1. una consegna dal nodo entra in review prima della barra: se poi è rossa nessuno la rimanda (7d229fbf, 20 ore);
2. l'atterraggio automatico prende solo testi e test: il codice server verde aspetta sempre una persona;
3. un land che va in conflitto o rompe la CI dopo il tuo ok torna all'agente e poi di nuovo da te; e
   la fusione che atterra (main + ramo) non la misura nessuno (`tasks.ts`, «NOT a merge queue»).

## Cosa cambia

- **Rosso → agente, da solo** (`server/services/red-bounce.ts`): una card in review con la barra rossa
  sul commit consegnato torna all'agente col log; dopo 3 giri senza una parola umana resta e chiede.
- **Card tecniche** (`personPlace` in `auto-land.ts`): restano a una persona interfaccia, sito pubblico,
  ciò che raggiunge persone, sicurezza e soldi, dipendenze e il giudice; il resto atterra da solo.
- **Fase CI** (stage `ci`, base `review`, fuori da «Ti aspetta»): ogni land chiesto (il tuo Approva/Landa
  o l'atterraggio automatico) entra in una coda per progetto. La coda fonde fino a 6 rami su `origin/main`
  in un commit di integrazione deterministico, lo misura con le righe CI della board una volta sola e,
  se verde, li atterra uno dopo l'altro. Rosso con più card: il lotto si dimezza finché resta la colpevole.
  Conflitto o rosso della colpevole: torna all'agente con l'intenzione di atterrare conservata
  (`tasks.land_intent`); quando la riconsegna è verde rientra in fase CI senza passare da te, salvo `human_ask`.
- Un tuo rifiuto con commento cancella l'intenzione.

## Barra

Vedi `specs/acceptance.md`.

## Fuori

Push di main su origin (resta «Pubblica»), deploy, la CI dei singoli rami prima della review (resta),
board senza righe CI (atterrano come oggi), la grafica della board oltre la colonna CI.

## Non ancora specificato

Quanto tenere aperta una PR di integrazione rossa per chi la vuole guardare (oggi si chiude subito).
