# Accettazione: chiamate vocali in Topics

## Barra eseguibile
```
bun test server/services/voice-call                       # T1-T5, esce 0
cargo test --release --features voce --lib voice::        # T6 (in jarvis-channels), esce 0
bun run tests/voice/scenari.ts --giri 2                   # T7, almeno 16/18
```
Mutazioni che devono fare rosso: senza `generationComplete` (T2), senza «passo pronto mentre parla si butta» o senza `repeatedQuestion` (T4), col prompt del riconoscimento di 048cb6fc (T3, «gli avvoli»).

## Scenario: Attilio chiama Jarvis
Dato il motore `topics` acceso
Quando Attilio chiama il numero di Jarvis e chiede le ultime mail
Allora sente un riconoscimento a tono entro ~1,2 s, i passi del lavoro senza parlargli sopra, e il risultato in due o tre frasi
E nel registro c'è `inizio` → `chiesto` → `voce_veloce_detta` → `affidato` → `passo_detto` → `risultato_a_gemini` → `fine`

## Scenario: Jarvis chiama Attilio
Quando parte `jarvis-channels chiama "motivo"`
Allora il saluto dice il motivo com'è scritto e la chiamata prosegue come sopra

## Scenario: si torna indietro
Quando `voce.motore = "locale"`
Allora la chiamata gira nel Rust di oggi, senza Topics

## Prova
Registro e registrazione dell'ultima chiamata vera pulita, e l'ok di Attilio a orecchio.
