# Accettazione: il sistema degli agenti in due repo, parte `topics-app`

Ogni riga è un comando che esce non-zero se fallisce. Quando un comando non esiste ancora, lo crea la traccia indicata. La barra della macchina di un'installazione sta nel suo repo dei dati, non qui.

1. **Cancello a cricchetto (T1).** `bun test tests/unit/no-instance-strings.test.ts` esce 0. Controlla due cose:
   - la lista dei nomi veri, dove c'è;
   - le classi: home di una persona, cartella d'istanza con il pattern preso dalle impostazioni, account, telefoni di 10-13 cifre, id di 17-19 cifre, IP.

   Il numero per percorso non sale. Il punto di partenza lo calcola il test alla prima esecuzione. `services/**`, `scripts/ops/**` e `harness/**` nascono con soglia 0. Lo stesso controllo gira nel pre-push.
2. **Zero occorrenze nel modulo importato (T7).** Per ogni modulo `M`, il cancello stampa 0 su `services/M`. Prima del push, `bun run scripts/check-push-clean.ts --range HEAD --not origin/main` esce 0.
3. **Un job di CI per modulo.** `cargo test --manifest-path services/channels/Cargo.toml` e `cargo test --manifest-path services/hub/Cargo.toml` escono 0; la durata a freddo si scrive qui dopo la prima esecuzione. Un test sul flusso di rilascio prova che un fast-forward di `main` non ricompila nessun modulo di `services/`.
4. **Mutazioni che devono fare rosso.** Sotto `services/` si reinseriscono:
   - un nome della lista, un telefono, un IP: rosso 3 su 3 sulla macchina che ha la lista;
   - un percorso di casa, un id lungo: rosso 2 su 2 anche in CI.

## Ciò che è verde resta verde
I test dei file toccati e di chi li importa (la suite intera la dà la CI della PR); i test delle change da cui questa dipende.
