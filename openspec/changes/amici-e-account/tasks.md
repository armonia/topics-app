# Tasks: amici-e-account

> Niente di tutto questo parte prima del sì sulla proposta e prima che i quattro
> bivi siano chiusi. I bivi 1 e 4 cambiano il server, i bivi 2 e 3 solo
> l'interfaccia.

## 1. Identità: la sezione Account (ACCOUNT-04)

- [ ] 1.1 `GET /api/auth/session` già risponde «chi sono»: verificare che porti
  nome, faccia, indirizzo, gruppo e dispositivo corrente, e aggiungere solo ciò
  che manca. **Verifica:** unit sul carico, con e senza gruppo.
- [ ] 1.2 Rotta per rinominare la persona proprietaria e darle un indirizzo, in
  locale, senza servizio degli account. Rifiuto con CODICE, mai con prosa
  (AUTHERR-02), e l'indirizzo già di un'altra riga è un rifiuto distinto
  (ACCOUNT-01 vale già per l'aggancio: qui la stessa regola sulla scrittura a mano).
  **Verifica:** unit sui rifiuti; nessuna `INSERT INTO people`.
- [ ] 1.3 `AccountSection` smette di nascondersi: sopra il collegamento remoto
  compare sempre l'identità locale, modificabile. Il blocco del servizio resta
  condizionato a `mostraSezione`. **Verifica:** test del componente sui due stati.
- [ ] 1.4 Voce `account` in `SETTINGS_SECTIONS`, prima di `profile`, con le due
  etichette nei dizionari. **Verifica:** il test che legge le sezioni come dati.
- [ ] 1.5 Il gesto di uscita nell'interfaccia, distinto dallo scollegare
  l'account, con conferma che dice cosa succede. **Verifica:** e2e sul giro.

## 2. Il legame (FRIEND-01..04)

- [ ] 2.1 Migrazione: `friends` (una riga per lato, stato, identità in cache) e
  `friend_invites` (segreto in HASH, mai il segreto; scadenza; consumo).
  Prefisso timestamp UTC, mai un contatore. **Verifica:** `check:migrations`,
  manifest embedded rigenerato.
- [ ] 2.2 `server/lib/friends.ts` puro: coniare un invito, riscattarlo,
  idempotenza sulla coppia, scioglimento, annullamento. **Verifica:** unit,
  compresi i tre modi di fallire che devono essere indistinguibili.
- [ ] 2.3 `server/routes/friends.ts`: emettere, riscattare, elencare, sciogliere,
  annullare. Fuori dall'allowlist degli ospiti (`isGuestAllowedPath`).
  **Verifica:** un ospite riceve lo stesso nulla su ognuna.
- [ ] 2.4 **La prova del confine (FRIEND-01):** una richiesta rifiutata dal
  cancello resta rifiutata dopo l'amicizia, e nessun `grant` nasce.
  **Verifica:** unit sul gate + una lettura del database dopo l'accettazione.
- [ ] 2.5 Il contatto verso l'altra installazione, con lo stato in attesa quando
  non risponde e il ritentativo. **Verifica:** unit con trasporto finto giù.

## 3. Superficie (FRIEND-05)

- [ ] 3.1 Chip e pagina: «Amici»/«Friends», conteggio degli amici accettati,
  inviti in arrivo distinti, stato vuoto che porta al gesto. **Verifica:**
  `check:ui-language`, nessuna chiave senza traduzione.
- [ ] 3.2 Il gesto: crea invito, mostra il codice, copia. E dall'altro lato:
  incolla, accetta, rifiuta. **Verifica:** e2e su una sola installazione con il
  riscatto simulato, poi la prova vera in 4.
- [ ] 3.3 La rubrica delle Impostazioni resta «Persone» (bivio 3, se resta (a)).

## 4. La prova a due macchine (FRIEND-06)

- [ ] 4.1 Scenario Gherkin sotto `tests/features/`, in italiano, agganciato alla
  spec `friends` dalla mappa di copertura. **Verifica:** `lint:gherkin`.
- [ ] 4.2 Regia di due server nella stessa run: due directory dati, due porte,
  il lock della porta di test rispettato (E2E-LOCK-01). **Verifica:** due run in
  parallelo non si uccidono a vicenda.
- [ ] 4.3 Lo spegnimento e il riavvio di entrambi fra accettazione e verifica.
  **Verifica:** il test fallisce se lo stato è tenuto in memoria.
- [ ] 4.4 Il video dello scenario come prova di consegna sulla card.

## 5. Chiusura

- [ ] 5.1 I sei cancelli verdi.
- [ ] 5.2 `openspec/specs/friends/spec.md` creata dalla delta, deltas archiviate.
- [ ] 5.3 Voce nel `CHANGELOG` e riga in `spec-flow.config.json`
  (`featureOrder` e `openspecGroups`: la capability nuova ha un gruppo).
