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
- [ ] 1.3 **`server/lib/grants-query.ts`**: `hasGrant`, `grantedResourceIds`,
  `reasonsFor`, `subjectsOf`, `holdsGrantOnTaskPreview`. Le 7 stringhe SQL
  letterali su `grants` (`server.ts:487,1658,1673`; `tasks.ts:603`;
  `auth.ts:293,345,355`) ci passano dentro. Oggi tutte chiavate su un principale
  di tipo `device`: **nessun cambio di comportamento**, solo un posto solo.
- [ ] 1.4 **`tests/unit/single-door.test.ts`**: fallisce se `subject_type` o
  `FROM grants` compaiono fuori da `grants-query.ts`. È un requisito e non una
  convenzione perché il guasto che previene è silenzioso *nella direzione
  sicura* — un lettore rimasto indietro legge di meno, e niente protesta.
- [ ] 1.5 **`mediaRelPath()` condivisa** fra gate e handler del file, e
  `LIKE ? ESCAPE '\'` con i metacaratteri neutralizzati. Oggi il gate ricostruisce
  il percorso a modo suo e confronta con un `LIKE` non escapato.
- [ ] 1.6 **`ctx.closeDeviceSockets(deviceId)`** alla revoca: oggi una socket già
  aperta conserva il suo `deviceId` dopo che il dispositivo è stato revocato.

## 2. La rete, prima di toccare lo schema

- [ ] 2.1 `server/lib/grants-query.test.ts`: precedenza `deny` su `read`, i tre
  tipi di soggetto, e il **piano** della query (`EXPLAIN QUERY PLAN` deve
  contenere `idx_grants_resource` e non `SCAN`).
- [ ] 2.2 `tests/e2e/guest-confinement.spec.ts` — **oggi questa superficie ha zero
  copertura E2E**: un ospite vede la scheda condivisa e non le altre, prende 403
  su ogni metodo diverso da GET, e non riceve i frame di una chat non condivisa.

## 3. La migration 084 — inerte

- [ ] 3.1 Backup del DB vivo, poi prova **su copia**: `PRAGMA integrity_check`,
  `foreign_key_check`, `COUNT(*)` su `grants` prima/dopo.
- [ ] 3.2 `tests/integration/migration-084-people-orgs.test.ts` su DB sintetico.
- [ ] 3.3 Creare il file **solo dopo** i due punti sopra — il watcher lo applica
  al DB VIVO in pochi secondi — e rigenerare il manifest.
- [ ] 3.4 Nessun codice legge ancora le tabelle nuove: la 084 non cambia niente.

## 4. Il risolutore condiviso

- [ ] 4.1 `server/lib/principals.ts` — `resolvePrincipals`, con la cache dei
  proprietari invalidata dal contatore di revisione.
- [ ] 4.2 Innestarlo nei **tre** punti che oggi traducono cookie→identità e non
  concordano: gate HTTP, upgrade WebSocket, `/api/auth/session`. Il secondo non
  passa da `evaluateIdentity` e non calcola il ruolo: è la strada su cui una
  novità resterebbe indietro in silenzio.
- [ ] 4.3 **Nessun consumatore decide ancora su questi valori.** Si logga il
  confronto «ruolo vecchio vs confinato nuovo» e si lascia girare un giorno in
  produzione: se divergono, lo si scopre adesso.

## 5. La porta passa dai principali

- [ ] 5.1 `hasGrant(db, principals, …)` al posto di `deviceId`; `ctx.requestIdentity`
  cambia forma.
- [ ] 5.2 `isGuestSocketData` diventa una lettura del principale; i casi esistenti
  si riscrivono.
- [ ] 5.3 Il filtro WS ri-risolve il socket quando il contatore diverge.
- [ ] 5.4 `devices.role` smette di essere letta da qualunque riga di codice.
- [ ] 5.5 `tests/unit/no-org-nesting.test.ts`: fallisce se `orgs.parent_id`
  compare in una migration. È **l'unico allarme** che la decisione sulla
  profondità due avrà.

## 6. Le rotte

- [ ] 6.1 `/api/people`, `/api/orgs`, `/api/orgs/:id/members` (scrittura riservata
  a chi amministra quell'org — l'unico uso del ruolo di membro).
- [ ] 6.2 `POST /api/orgs/:id/members/:pid/block` → la revoca locale che
  sopravvive al pull.
- [ ] 6.3 **`/api/auth/subjects`**, la rubrica dei destinatari: oggi non esiste, e
  al suo posto si usa l'elenco dei dispositivi.
- [ ] 6.4 `/api/auth/shares`: `subjectType` come parametro validato; `deviceId`
  resta accettato come alias legacy per una release; il GET restituisce i
  soggetti concessi **e** l'insieme espanso.

## 7. Il client — dove sta metà del lavoro

- [ ] 7.1 `ShareControl`: rubrica dai soggetti, dedup, conteggio per persona e non
  per dispositivo, e `via.id` finalmente **reso** (oggi dice «da progetto» senza
  dire quale, cioè non risponde alla domanda per cui la colonna esiste).
- [ ] 7.2 `PairingApproval`: «Di chi è questo dispositivo?» al posto della scelta
  di ruolo — il ruolo è derivato, chiederlo inviterebbe a contraddire il modello.
- [ ] 7.3 `DevicesSection`: raggruppamento per persona e l'azione «questo
  dispositivo è di un'altra persona». È **la leva di correzione del backfill**:
  senza, il passo 3 è una consegna a metà.
- [ ] 7.4 `SessionState` porta persona e organizzazione.
- [ ] 7.5 **`SessionRoot`: il default si inverte.** Oggi tutto ciò che non è
  esattamente `guest` cade sull'app intera, cioè un soggetto nuovo passa dalla
  parte permissiva per omissione.

## 8. La pulizia — 085, e non prima

- [ ] 8.1 `ALTER TABLE devices DROP COLUMN role` e `DROP TABLE task_shares`, dopo
  che un grep conferma che nessuno le nomina. Non prima: `devices.role` è il punto
  di atterraggio di un rollback al binario precedente.
