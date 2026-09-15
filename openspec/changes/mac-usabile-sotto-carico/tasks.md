# Tasks: mac-usabile-sotto-carico

Ogni tornata è una PR a sé, con test che vanno rossi senza la correzione,
verifica avversaria e CI verde prima del merge. I test pesanti (suite unit,
e2e, typecheck completo) girano in CI o sul PC, mai sul Mac mentre è in swap.

## Tornata 1: coda senza tempesta
- [x] Un resume trattenuto riscrive `dispatch_state`/`dispatch_error` e trasmette `task:updated` solo quando il motivo cambia (tipo di blocco, testo a numeri esclusi, e per il pavimento la sola risorsa Memoria/Disco), con un rinfresco al massimo ogni 60 s dei numeri
- [x] Test: 7 card trattenute per 2 minuti di retry con il compositore vero e letture a cavallo di 6,0 GB producono al massimo 2 frame per card, e un cambio di tipo di blocco o di risorsa arriva subito

## Tornata 2: e2e degli agenti in CI
- [ ] Envelope (`buildKickoff`, `CODE_GATES_RULE`) e `docs/board-protocol.md`: niente `check:e2e-touched`, `playwright test` o build del client per gli e2e sul Mac; l'agente scrive lo spec e la prova arriva dalla CI
- [ ] Il check `e2e-touched` della board prende l'esito dalla CI del commit consegnato, mai verde senza una corsa verde di quella testa
- [ ] Nessun Chromium scaricato o avviato sul Mac da questo percorso (`nochrome`)

## Tornata 3: segnale di memoria e freno sul lavoro in volo
- [ ] Pavimento riaperto solo con la memoria sopra la riga (pavimento + prezzo) per una finestra di tempo; finestra piena anche al boot; prenotazione per la vita del turno
- [ ] Attesa dei check: rilascio con il prezzo del comando, uno per finestra, `e2e-touched` sotto slot
- [ ] Con swap sostenuto Topics interrompe il giro di check più giovane (interrotto, riparte da solo), al massimo 1 ogni 2 min e 2 per giro
- [ ] Barra di esito: stalli [LAG], swap-in/s e load prima e dopo, non il conteggio delle righe di log

## Tornata 4: pannelli browser pesanti
- [ ] Consumo misurato per pannello nativo
- [ ] Sopra soglia: segnale nella tab, vivo solo col fuoco, fermo immagine con UI chiara, ritorno senza ricaricare
- [ ] Semantica di fuoco corretta su macOS, Windows e finestre staccate

## Tornata 5: browser remoto degli agenti su WebKit
- [ ] Card separata sulla board
