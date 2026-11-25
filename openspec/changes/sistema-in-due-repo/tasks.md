# Tracce in `topics-app`

Qui ci sono solo le due tracce che toccano questo repo; le altre stanno nel repo dei dati dell'installazione e sulla sua board. Lo stato lo danno git e la barra, non la casella.

- [ ] 1.1 **T1: il cancello e la pulizia.** Il test `check:instance-strings` cerca la lista cifrata dei nomi veri dell'installazione, dove c'è (in CI manca), più alcune classi che non hanno bisogno di lista:
  - la home di una persona;
  - la cartella d'istanza, con il pattern letto dalle impostazioni;
  - gli account;
  - telefoni di 10-13 cifre e id di 17-19;
  - gli IP.

  Funziona a cricchetto per percorso: il numero non sale. Copre le cartelle di codice e `deploy/`; `openspec/` ha una soglia sua; `services/**`, `scripts/ops/**` e `harness/**` partono da 0. È collegato al pre-push, non solo alla CI. Poi si ripulisce il debito: i file non di test che citano il percorso della cartella d'istanza (in `server/`, `shared/`, `client/src/`, `scripts/`, `deploy/`) e quelli con id di agenti scritti nel codice. Prima del primo import di ogni modulo, oltre al cancello, serve una lettura umana o d'agente di fixture e testi di regole.
  **Barra:** il test esce 0; le mutazioni del punto 4 di `acceptance.md` sono rosse; `bun run scripts/check-push-clean.ts --range HEAD --not origin/main` esce 0 (senza `--range` legge uno stdin vuoto ed esce 0, quindi non vale).
- [ ] 2.1 **T7: import senza storia.** Si va dal modulo meno delicato al più delicato: `harness/` → `scripts/ops/` → `services/mcp` → `services/mcp-gateway` → `services/hub` → `services/channels`. Ogni modulo è un commit «import di <modulo> alla revisione X»; la lista dei rami aperti del vecchio repo resta nel repo dei dati, mai nei commit pubblici. Vuole cancello e pre-push verdi e un job di CI con filtro di percorso; per i canali la build a freddo va misurata. Nessun modulo si ricompila nel flusso di rilascio di Topics, perché un fast-forward di `main` è anche un deploy.
  **Dipende da:** T1, e dalla preparazione del modulo fuori da qui.
  **Barra:** il cancello stampa 0 su `services/<modulo>`, la CI è verde, un test prova il flusso di rilascio.
