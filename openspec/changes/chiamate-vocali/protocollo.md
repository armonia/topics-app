# Ponte chiamate: protocollo fra un canale e Topics

`WS /ws/voice/bridge` — locale (loopback = proprietario); da remoto `Authorization: Bearer <token del daemon>`.
Una connessione = una chiamata. Testo = JSON con `type`; binario = audio PCM16 little-endian mono 16 kHz,
fotogrammi da 60 ms (960 campioni, 1920 byte: è il fotogramma della linea WhatsApp, `pcm.rs` FRAME), in tutte e due le direzioni.

## Canale → Topics
- `{"type":"start","id","name","direction":{"kind":"incoming"}|{"kind":"outgoing","reason"}|{"kind":"on_behalf","callee","message","callback"},"group":false,"speed":1.0,"record":true}` — prima cosa; Topics apre Gemini e la bocca subito (la chiamata può ancora squillare).
- `{"type":"answered"}` — l'altro ha risposto (in uscita). In entrata il canale lo manda insieme a `start`.
- binario — l'audio dell'altro, a ritmo reale.
- `{"type":"progress","steps":["Nome: dettaglio", …]}` — i passi del turno dell'agente nato da questa chiamata, lista intera del turno (cresce; più corta = turno nuovo).
- `{"type":"reply","text"}` — il risultato di un compito affidato.
- `{"type":"ended","why"}` — l'altro ha riattaccato / audio chiuso.

## Topics → canale
- binario — l'audio da far sentire, a ritmo reale (Topics fa da orologio: un fotogramma ogni 60 ms, silenzio o fondo compresi, come il `tick` di `call.rs`).
- `{"type":"handoff","id","text"}` — un compito per l'agente, da far entrare come messaggio della chat del proprietario (oggi «📞 (dalla telefonata con Jarvis) …»); il canale risponde `{"type":"handoff_ok","id"}` o `{"type":"handoff_err","id","error"}`.
- `{"type":"hangup","why"}` — chiudi la chiamata.
- `{"type":"outcome","report","heard","speed","turns","handoffs","usd","recording"}` — ultima cosa prima di chiudere il socket; `recording` = percorso del file su questa macchina o null.
- `{"type":"log","event","data"}` — il registro della chiamata (stessi eventi di oggi: `chiesto`, `pensato`, `voce_veloce_detta`, `passo_detto`, …): il canale lo scrive dove vuole, il banco lo legge.

## Regole
- Un compito entra solo con `handoff_ok`; senza risposta in 5 s vale errore (oggi `handoff()` è sincrono).
- Topics chiude da solo dopo `hangup` + `outcome`; il canale chiude da solo dopo `ended` aspettando `outcome` al più 3 s.
- Socket caduto a metà = chiamata finita per tutti e due (il canale riattacca, Topics chiude Gemini).
