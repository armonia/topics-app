# Ponte chiamate: protocollo fra un canale e Topics

`WS /ws/voice/bridge` — locale (loopback = proprietario); da remoto `Authorization: Bearer <token del daemon>`.
Una connessione = una chiamata. Testo = JSON con `type`; binario = audio PCM16 little-endian mono 16 kHz,
fotogrammi da 60 ms (960 campioni, 1920 byte: è il fotogramma della linea WhatsApp, `pcm.rs` FRAME), in tutte e due le direzioni.

## Canale → Topics
- `{"type":"start","id","name","direction":{"kind":"incoming"}|{"kind":"outgoing","reason"}|{"kind":"on_behalf","callee","message","callback"},"group":false,"speed":1.0,"record":true,"channel":"WhatsApp"}` — prima cosa; Topics apre Gemini e la bocca subito (la chiamata può ancora squillare). `channel` (facoltativo, default «WhatsApp») è il nome del canale detto nei prompt («te lo scrive anche su WhatsApp»). `speed` è quella salvata dal canale (default 1,12); quella nuova torna in `outcome.speed` e la salva il canale.
- `{"type":"answered"}` — l'altro ha risposto (in uscita). In entrata il canale lo manda insieme a `start`.
- binario — l'audio dell'altro, a ritmo reale.
- `{"type":"progress","steps":["Nome: dettaglio", …]}` — i passi del turno dell'agente nato da questa chiamata, lista intera del turno (cresce; più corta = turno nuovo).
- `{"type":"reply","text"}` — il risultato di un compito affidato.
- `{"type":"ended","why"}` — l'altro ha riattaccato / audio chiuso.

## Topics → canale
- binario — l'audio da far sentire, a ritmo reale (Topics fa da orologio: un fotogramma ogni 60 ms, silenzio o fondo compresi, come il `tick` di `call.rs`; mentre una chiamata in uscita squilla non manda niente).
- `{"type":"handoff","id","text"}` — un compito per l'agente, da far entrare come messaggio della chat del proprietario; `text` è il compito nudo, il prefisso («📞 (dalla telefonata con Jarvis) …») lo mette il canale; `id` vale `<id della chiamata>:<n>`. Il canale risponde `{"type":"handoff_ok","id"}` o `{"type":"handoff_err","id","error"}`.
- `{"type":"hangup","why"}` — chiudi la chiamata.
- `{"type":"outcome","reason","ours","answered","talk_s","report","heard","speed","turns","handoffs","usd","recording"}` — ultima cosa prima di chiudere il socket; `recording` = percorso del file su questa macchina (m4a dove c'è `afconvert`, sennò WAV, sotto `TOPICS_HOME/voice/recordings/`, 30 giorni) o null. `reason`/`ours`/`answered`/`talk_s` servono al canale per l'esito per conto («non ha risposto», «ha rifiutato», durata) e per sapere se tocca a lui dire `terminate` a WhatsApp.
- `{"type":"error","error"}` — `start` non valido o messaggio prima di `start`; subito dopo Topics chiude il socket (1008).
- `{"type":"log","event","data"}` — il registro della chiamata (stessi eventi di oggi: `inizio`, `chiesto`, `pensato`, `voce_veloce_detta`, `passo_detto`, …, `fine`): il canale lo scrive dove vuole, il banco lo legge. `inizio` lo manda Topics (con `verso` e `modello`); il canale aggiunge `t` e `chiamata` quando lo scrive.

## Regole
- Il ponte è del proprietario: un ospite o un nodo delegato prende 403 all'upgrade.
- Un compito entra solo con `handoff_ok`; senza risposta in 5 s vale errore (oggi `handoff()` è sincrono).
- Topics chiude da solo dopo `hangup` + `outcome`; il canale chiude da solo dopo `ended` aspettando `outcome` al più 3 s.
- Socket caduto a metà = chiamata finita per tutti e due (il canale riattacca, Topics chiude Gemini).
