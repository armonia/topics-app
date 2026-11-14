# Tracce

Ogni traccia ha la sua barra; lo stato lo dà il test, non la casella. Codice in inglese, commenti in italiano.
Fonte da portare: `~/.claude/jarvis/tools/jarvis-channels/src/voice/` (Rust, commit 80f1fd26) e `tests/voce.rs`.

## T1 · Audio (dipende da: niente)
`server/services/voice-call/audio/`: `Resampler` 24→16 kHz, `Vad`, `Playout`, `Rechunk`, `Stretch` (velocità), `Ambience` (fondo, niente tasti), `misheard`, `echoOf`, `wav16k`, registratore.
Barra: `bun test server/services/voice-call/audio` esce 0 con i casi portati da `pcm.rs` e `natural.rs`.

## T2 · Gemini Live (dipende da: niente)
`server/services/voice-call/gemini.ts`: setup (voce, trascrizione it-IT + vocabolario, strumenti), `parse` (audio, `generationComplete`, `turnComplete`, interruzioni, tool call, usage, handle di ripresa, frame binari), riaggancio con ripresa e 4 tentativi, `sayOnce` per gli intercalari.
Barra: `bun test server/services/voice-call/gemini.test.ts` esce 0 con i casi di `gemini.rs`; mutazione: senza `generationComplete` il test dedicato è rosso.

## T3 · Cervello e voce veloce (dipende da: niente)
`server/services/voice-call/brain.ts`: prompt, dialogo, `userTurn`, `parse` (primo oggetto JSON), `think` via `AIProvider.complete` (modello da impostazione, 14 s), `quick` su Groq (`GROQ_API_KEY`, modello da impostazione, 2,5 s), `ackPrompt`, `progressPrompt`, `cleanQuick`, prompt della bocca.
Barra: `bun test …/brain.test.ts` esce 0; `acks` (frasi vere, 18 su 18, solo con chiave) come test saltato senza chiave.

## T4 · Chiamata (dipende da: T1, T2, T3)
`server/services/voice-call/call.ts`: il ciclo di `call.rs` con tutte le regole (saluto, barge-in, verifica whisper, intercalari, cervello, riconoscimento a tono con attesa del momento libero, «ancora un secondo», passi con le tre guardie, `repeatedQuestion`, risultati in due o tre frasi, chiusura, velocità, gruppo, per conto) e `outcome`. Orologio a 60 ms (FRAME di `pcm.rs`).
Barra: unit test della chiamata col finto Gemini (`call.test.ts`) esce 0, compresi `repeatedQuestion` e «passo pronto mentre parla si butta» con le loro mutazioni.

## T5 · Ponte (dipende da: T4)
`/ws/voice/bridge` come in `protocollo.md`, intercalari in cache sotto `TOPICS_HOME/voice/`, configurazione dall'ambiente con default nel codice, niente migration: `TOPICS_VOICE_MODEL` (gemini-3.8-live), `TOPICS_VOICE_NAME` (Algenib), `TOPICS_VOICE_BRAIN_MODEL` (vuoto = Gemini da solo), `TOPICS_VOICE_QUICK_MODEL` (qwen/qwen3.8-27b), `TOPICS_VOICE_SCENARIOS` (cartella del banco); chiavi `GEMINI_API_KEY` e `GROQ_API_KEY` come le altre rotte voce.
Barra: test d'integrazione con un finto canale sul ponte (start → audio → handoff_ok → reply → hangup → outcome) esce 0.

## T6 · jarvis-channels filo (dipende da: protocollo; si prova con T5)
In `src/voice/`: con `voce.motore = "topics"` la chiamata apre il ponte e ci passa audio e messaggi; `handoff` → turno come oggi; `progress_ready`/`reply_ready` → ponte; esito e registro come oggi. `"locale"` = codice di oggi.
Barra: `cargo test --release --features voce --lib voice::` esce 0 e un test del filo contro un finto ponte.

## T7 · Banco su Topics (dipende da: T5)
Il banco scenari come finto canale sul ponte (`tests/voice/scenari.ts`, clip e `scenari.json` dalla cartella in impostazione), stessi controlli di `tests/voce.rs` (affida, chiude, riferisce, breve, racconta, passi_non_dicono, non_ripete, rilancia).
Barra: 2 giri, almeno 16/18 come il Rust del 14/11.

## T8 · Chiamate vere (dipende da: tutto)
Motore `topics` acceso; Attilio chiama Jarvis e Jarvis chiama Attilio; ogni difetto sentito diventa un caso del banco prima della correzione; si richiama finché una chiamata esce senza niente da correggere.
Barra: registro + registrazione dell'ultima chiamata pulita, e l'ok di Attilio.
