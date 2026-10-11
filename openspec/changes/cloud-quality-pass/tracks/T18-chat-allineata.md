# T18 — una chat in corso non resta indietro: niente «aggiorna» per vedere il vero progresso

**GOAL.** Attilio, 08/10: «ogni tanto la sessione è lenta e devo fare aggiorna per vedere il vero progresso».
Una chat con un turno in corso (provider `claude-code`, via il demone `ai-bridge`) deve tornare allineata
DA SOLA a ciò che la CLI ha già scritto, entro 15 s da un distacco dello stream, senza ricaricare la pagina.
Oggi il recupero automatico parte dopo 3 minuti di silenzio, e può non fare niente senza dirlo.

- **Base:** `cloud/quality-pass-integrata` @ `5eb857502` più questo brief: ramo `cloud/t18-base`.

## Cosa si sa già (dal coordinatore, log di produzione sul Mac)

- **Il recupero di oggi.** `server/lib/stale-stream-sweep.ts`: dopo `STALE_STREAM_TIMEOUT_MS` (3 min) di
  silenzio con il figlio vivo, verdetto `rescue` → `deps.resyncStream(sk)` UNA volta, poi solo proroghe.
  In `server.ts` (~riga 4998) il resync va al proprietario della sessione e il valore di ritorno non è letto.
  `ClaudeCodeProvider.resyncStream` (`server/providers/claude-code.ts`, ~riga 3275) torna `false` SENZA
  scrivere niente se `this.processes` non ha un `pp` vivo per la sessione; il «figlio vivo» del verdetto
  viene invece da `childAliveForSweep`. Se le due fonti non concordano il soccorso è una no-op muta.
- **I numeri.** Log di stdout: `Stream resync for …: re-attached from offset X, recovered N byte(s)` 103 volte
  in tutto, **l'ultima il 03/10**; delle ultime 60, 54 con 0 byte (figlio solo zitto) e **6 con byte persi:
  media 3,8 MB, massimo 15,9 MB** (distacchi veri, chat ferma fino al soccorso). Log degli errori (ultime
  20.000 righe, senza data): `silent for 3 min but its child is ALIVE — re-attaching` 53, `Stream resync
  failed … ack timeout` 8, `[AI Bridge] attach … ack timeout — riprovo` 11, `connessione al daemon caduta —
  riprovo` 5, `Broker socket reconnected — re-attaching N live session(s)` 5, `[StreamWS] Recovered from
  soft timeout` 43 oggi. Dopo il 03/10 i soccorsi continuano e nessun resync riuscito è scritto: da spiegare.
- **Client.** Oggi 125 connessioni WS e 122 disconnessioni (107 in una raffica di notte, 14 fra le 12 e le 15).
  Il client ha `stream:catchup` (`stream-catchup-v1` nell'handshake, `client/src/hooks/useChat.ts`).
- **Il Mac** in quelle ore era in swap (93% del file di swap, load 15-46): i timeout sono più probabili, il
  fix deve reggere sotto carico. Il demone `ai-bridge` vive a lungo (quello in produzione da ieri): un
  server nuovo deve parlare anche con un demone vecchio (il campo protocollo c'è già).

## Le domande a cui il REPORT risponde

1. In quali casi lo stream di un turno vivo si stacca: socket del broker, attach in ack timeout, WS del
   client che si riconnette a metà turno, server riavviato e turno riadottato, turno «woken».
2. Per ciascuno: il recupero di oggi riallinea il client? In quanto? Quale strada è una no-op muta?
3. Come accorgersi in pochi secondi che lo stream è INDIETRO senza tempestare di resync un figlio sano e
   zitto: per esempio chiedere al demone l'`endOffset` della sessione e confrontarlo col `consumedOffset`
   (un buco che resta > N s = indietro → resync subito). Scegli e scrivi il perché.

## Vincoli

- Nessun delta duplicato (il replay riparte dall'offset) e nessun cambio in cosa produce un turno.
- Un figlio vivo e zitto (pensiero lungo, tool di minuti) non genera resync a raffica: al massimo uno per buco.
- Un soccorso che non può agire lo DICE nel log, con il motivo.
- Compatibile con un demone `ai-bridge` già acceso di versione precedente.
- Le regole comuni di `_comuni.md` (setup, barra comune, Bun 1.3.8 per il codice server, consegna).

## Barra

- **B1 distacco del broker:** test (demone vero o finto + figlio finto che continua a scrivere) che fa
  cadere il socket del broker a metà turno: lo stato dello stream del server torna allineato entro 15 s;
  prima: 3 minuti, o mai. Numeri prima e dopo.
- **B2 no-op muta:** sessione viva per il demone ma assente da `processes`: prima il soccorso non fa niente
  (rosso), dopo si riaggancia o dice perché no (verde).
- **B3 WS del client:** riconnessione a metà turno, il client riceve tutto ciò che ha perso (e2e o
  integrazione); se è già verde prima, resta verde.
- **B4 figlio zitto:** 90 s di silenzio di un figlio sano: al massimo un resync, nessun duplicato.
- **B5 mutazione** (copia scratch): togliere il fix fa tornare rossi B1 e B2.
- **B6:** la barra comune di `_comuni.md`.

## Consegna

Ramo `cloud/t18-chat-allineata`, REPORT in `openspec/changes/cloud-quality-pass/reports/T18.md`.

**FUORI.** Il provider nativo (salvo che la causa sia condivisa), la board, il client fuori dal percorso
dello stream della chat, i workflow CI, `.bun-version`, le migrazioni.
