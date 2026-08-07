# Tasks — sharing-orgs

L'ordine non è una preferenza: ogni passo è rilasciabile da solo, e i primi due
sono un guadagno **a schema fermo**. La migration arriva quando c'è già una rete
sotto, non prima.

## 1. La porta unica e il cancello di metodo — modello INVARIATO

- [x] 1.1 **Il metodo diventa il terzo asse.** Un confinato fa solo GET/HEAD, con
  eccezioni enumerate (oggi solo `POST /api/auth/logout`). Chiudeva un buco vero:
  un ospite poteva `PATCH`/`DELETE` una scheda condivisa, perché il gate
  autorizzava il percorso e l'entità e mai il verbo. → `isGuestAllowedMethod`
  (`lib/grants.ts`), requisito SHARE-06, 3 casi di test.
- [x] 1.2 **Il filtro dei broadcast guarda il RUOLO, non la presenza di un id**, e
  copre TUTTE le fan-out (prima solo `broadcastToAll`; `broadcastToTopic` e
  `broadcastToTopicSubscribers` non consultavano niente, ed è da lì che passa
  quasi sempre `stream:content_chunk`). → `isGuestSocketData`, `mayReadTopic`.
- [x] 1.3 **`server/lib/grants-query.ts`**: `hasGrant`, `grantedResourceIds`,
  `reasonsFor`, `subjectsOf`, `holdsGrantOnTaskPreview`. Le 7 stringhe SQL
  letterali su `grants` (`server.ts:487,1658,1673`; `tasks.ts:603`;
  `auth.ts:293,345,355`) ci passano dentro. Oggi tutte chiavate su un principale
  di tipo `device`: **nessun cambio di comportamento**, solo un posto solo.
- [x] 1.4 **`tests/unit/single-door.test.ts`**: fallisce se `subject_type` o
  `FROM grants` compaiono fuori da `grants-query.ts`. È un requisito e non una
  convenzione perché il guasto che previene è silenzioso *nella direzione
  sicura* — un lettore rimasto indietro legge di meno, e niente protesta.
- [x] 1.5 **`mediaRelPath()` condivisa** fra gate e handler del file, e
  `LIKE ? ESCAPE '\'` con i metacaratteri neutralizzati. Oggi il gate ricostruisce
  il percorso a modo suo e confronta con un `LIKE` non escapato.
- [x] 1.6 **`ctx.closeDeviceSockets(deviceId)`** alla revoca: oggi una socket già
  aperta conserva il suo `deviceId` dopo che il dispositivo è stato revocato.

## 2. La rete, prima di toccare lo schema

- [x] 2.1 `server/lib/grants-query.test.ts`: precedenza `deny` su `read`, i tre
  tipi di soggetto, e il **piano** della query (`EXPLAIN QUERY PLAN` deve
  contenere `idx_grants_resource` e non `SCAN`).
- [ ] 2.2 `tests/e2e/guest-confinement.spec.ts` — **oggi questa superficie ha zero
  copertura E2E**: un ospite vede la scheda condivisa e non le altre, prende 403
  su ogni metodo diverso da GET, e non riceve i frame di una chat non condivisa.

## 3. La migration 084 — inerte

- [x] 3.1 Backup del DB vivo, poi prova **su copia**: `PRAGMA integrity_check`,
  `foreign_key_check`, `COUNT(*)` su `grants` prima/dopo.
- [x] 3.2 `tests/integration/migration-084-people-orgs.test.ts` su DB sintetico.
- [x] 3.3 Creare il file **solo dopo** i due punti sopra — il watcher lo applica
  al DB VIVO in pochi secondi — e rigenerare il manifest.
- [x] 3.4 Nessun codice legge ancora le tabelle nuove: la 084 non cambia niente.

## 4. Il risolutore condiviso

- [x] 4.1 `server/lib/principals.ts` — `resolvePrincipals`, con la cache dei
  proprietari invalidata dal contatore di revisione.
- [x] 4.2 Innestato in tutti e **tre** i punti: `server/lib/identity.ts` è ora
  l'unico che traduce cookie→identità, e lo usano il gate HTTP, l'upgrade
  WebSocket e `/api/auth/session`. Erano tre query diverse — una filtrava la
  revoca in SQL, una dopo, la terza aveva una forma di risposta sua — e
  divergevano davvero: due volte in un giorno, e sempre sulla strada meno
  percorsa.
- [x] 4.3 **Nessun consumatore decide ancora su questi valori.** Si logga il
  confronto «ruolo vecchio vs confinato nuovo» e si lascia girare un giorno in
  produzione: se divergono, lo si scopre adesso.

## 5. La porta passa dai principali

- [x] 5.1 `hasGrant(db, principals, …)` al posto di `deviceId`; `ctx.requestIdentity`
  cambia forma.
- [ ] 5.2 `isGuestSocketData` diventa una lettura del principale; i casi esistenti
  si riscrivono.
- [ ] 5.3 Il filtro WS ri-risolve il socket quando il contatore diverge.
- [ ] 5.4 `devices.role` smette di essere letta da qualunque riga di codice.
- [x] 5.5 `tests/unit/no-org-nesting.test.ts`: fallisce se `orgs.parent_id`
  compare in una migration, e prova anche che il proprio setaccio riconosca ciò
  che cerca. È **l'unico allarme** che la decisione sulla profondità due avrà —
  quando suonerà, la risposta giusta non è zittirlo ma rifare il conto.

## 6. Le rotte

- [ ] 6.1 `/api/people`, `/api/orgs`, `/api/orgs/:id/members` (scrittura riservata
  a chi amministra quell'org — l'unico uso del ruolo di membro).
- [ ] 6.2 `POST /api/orgs/:id/members/:pid/block` → la revoca locale che
  sopravvive al pull.
- [x] 6.3 **`/api/auth/subjects`**, la rubrica dei destinatari: oggi non esiste, e
  al suo posto si usa l'elenco dei dispositivi.
- [x] 6.4 `/api/auth/shares`: `subjectType` come parametro validato; `deviceId`
  resta accettato come alias legacy per una release; il GET restituisce i
  soggetti concessi **e** l'insieme espanso.

## 7. Il client — dove sta metà del lavoro

- [x] 7.1 `ShareControl`: rubrica dai soggetti, dedup, conteggio per persona e non
  per dispositivo, e `via.id` finalmente **reso** (oggi dice «da progetto» senza
  dire quale, cioè non risponde alla domanda per cui la colonna esiste).
- [x] 7.2 `PairingApproval` chiede «È mio» / «È di un'altra persona» e NON manda
  più un ruolo: quello discende dall'essere proprietari dell'installazione. Una
  persona nuova non è proprietaria, quindi il suo dispositivo nasce confinato —
  il verso opposto trasformerebbe un errore di battitura in un accesso pieno.
  `role` resta accettato come alias legacy dove le persone non ci sono.
- [x] 7.3 `DevicesSection`: la riga dice DI CHI è (solo quando le persone sono
  più di una: a un utente solo sarebbe rumore) e offre «è di un'altra persona».
  `PATCH /api/auth/devices/:id` accetta `personId`, valida la persona, e chiude
  le socket perché il ruolo derivato può essere cambiato. È **la leva di
  correzione del backfill**, e senza il passo 3 restava una consegna a metà.
- [x] 7.4 `SessionState` porta la persona, e il confronto di `emit` la guarda:
  senza, spostare un dispositivo su un'altra persona non arriverebbe a nessuno.
- [x] 7.5 **`SessionRoot`: il default è invertito.** Si monta l'app solo a chi è
  riconosciuto `owner`; tutto il resto è confinato. Prima qualunque ruolo non
  previsto — un valore nuovo, un server più avanti del client — cadeva dalla
  parte permissiva per omissione. Sbagliare da questa parte si vede e si
  corregge; dall'altra non si vede affatto.

## 8. La pulizia — 085, e non prima

- [ ] 8.1 `ALTER TABLE devices DROP COLUMN role` e `DROP TABLE task_shares`, dopo
  che un grep conferma che nessuno le nomina. Non prima: `devices.role` è il punto
  di atterraggio di un rollback al binario precedente.
