## Da decidere

Niente: sono tutte scelte tecniche, reversibili con una variabile (`TOPICS_NATIVE_DETACHED=0` torna al turno dentro il server).

# Riavvii del server senza perdere niente

**Perché.** Il 07/11 il deploy dell'hub è rimasto fermo per ore: `topics-riavvio-a-zero-turni` aspettava una finestra senza turni, e una chat ferma dal 06/11 su un parziale vuoto non la lasciava mai arrivare. La causa vera è un'altra: chat e card girano sul runtime nativo `topics` (133 topic su 147), e un turno nativo vive **dentro** il processo del server. Ogni riavvio lo taglia: la chat mostra «Turno interrotto da un riavvio» e riparte da capo, la card rifà il turno, il testo già scritto si rigenera e si ripaga. Il broker staccato (`ai-bridge.mjs`) che fa sopravvivere i turni della CLI esiste da luglio, ma il runtime nativo non lo usa.

**Stato dell'arte.** systemd socket activation e FDSTORE, SO_REUSEPORT, hot upgrade di nginx (USR2) ed Envoy, reload di HAProxy con `-x`, tableflip: tutti tengono **la porta** durante il cambio, nessuno tiene il lavoro lungo che sta dentro il processo. Quello lo risolve il modello di tmux/screen/dtach: il lavoro vive in un processo che non si riavvia, il server è un cliente che si stacca e si riattacca. Topics lo fa già per i terminali (`pty-bridge.mjs`) e per la CLI (`ai-bridge.mjs`). Il buco del listener (2-6 s misurati) non perde niente se i turni sopravvivono: il client riprova da solo. Quindi niente passaggio di socket.

**Cosa cambia.**
- Il turno nativo gira in un processo suo, `server/providers/native/turn-host.ts`, lanciato dal broker con id `native:<sessionKey>`. Scrive ogni evento (delta di testo, pensiero, tool, domanda, uso, fine) come riga del diario del broker, che è append-only e indirizzabile per offset.
- `NativeProvider` diventa cliente di quel processo: `stop()` si stacca invece di annullare, `reattach()` rilegge il diario dall'inizio del turno e segue il resto dal vivo. Con `reattach` il provider «sopravvive al riavvio» per tutto il resto del server (setaccio dei parziali, riadozione delle chat, ramo `live` del dispatcher), che oggi lo chiede solo a `claude-code`.
- La stessa riga di chat continua, senza Riprova: il testo parziale arriva dal diario, nessun giro del modello si ripete.
- Una domanda aperta (`ask_user_question`) resta: il pannello si ridisegna dal diario, e la richiesta di risposta del processo staccato riprova sul server nuovo.
- Il riavvio non aspetta più i turni: `restart-when-idle` aspetta solo ciò che davvero non si riadotta (CLI non in broker, codex, acp, un land in corso). Gli script `topics-riavvio-*` e `topics-pubblica-client` smettono di cercare la finestra a zero turni.
- Un parziale orfano (riga `partial=1` senza nessun processo dietro) si chiude al boot e allo sfratto, invece di restare per giorni.

**Barra.** `specs/acceptance.md`: un e2e che riavvia il server con in volo un turno di card, uno di chat in streaming e una domanda aperta, e li ritrova tutti intatti nella stessa riga senza Riprova, con il server nuovo su in pochi secondi; più una mutazione sul punto critico.

**Fuori.** Codex, ACP e la CLI senza broker: restano come sono, e il riavvio li aspetta (sono 50 topic su 147). Il passaggio della porta (SO_REUSEPORT, fd passing): non serve. L'aggiornamento della app desktop (`topics-app-aggiorna`).

**Deciso da me.**
- Un processo per **turno**, non per sessione: la memoria la paga solo chi sta lavorando, e un turno nuovo parte sempre col codice nuovo.
- Il diario sta nello store del broker che c'è già, non in un file nuovo: la riadozione, la ritenzione di 6 ore e l'orfano con 90 s di grazia sono già provati.
- La storia resta del server: il processo riceve la storia all'avvio e restituisce i messaggi nuovi alla fine. Dopo un riavvio la storia si ricostruisce dal DB come oggi.
- Le chiamate ai server MCP della macchina restano nel server (`/api/native/mcp-call`), con riprova durante il riavvio: avviare la flotta in ogni turno costerebbe una stretta di mano a ogni messaggio.
- Leva di ritorno: `TOPICS_NATIVE_DETACHED=0`.

## Non ancora specificato

- Il turno nativo lanciato sul nodo PC (`pc-nodo`): oggi gira nel server del PC, e lì il broker non è acceso.
