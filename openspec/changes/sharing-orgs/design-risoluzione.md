`server/lib/principals.ts` — NUOVO. Una funzione pura di decisione, una cache, e nient'altro.

```ts
export type Principal = { type: 'device' | 'person' | 'org'; id: string };
export interface ResolvedIdentity {
  principals: Principal[];   // pre-costruito UNA volta per richiesta
  personId: string | null;
  confined: boolean;         // sostituisce role: 'owner' | 'guest'
  rev: number;               // il principals_rev con cui è stato calcolato
}

/** Il salto 1 e il salto 2. Nessun terzo salto esiste, per costruzione. */
export function resolvePrincipals(db, deviceRow, ownerCache): ResolvedIdentity
```

DA COOKIE A INSIEME DEI PRINCIPALI, otto passi, con l'innesto per ognuno.

1. **IP del peer** — `server.ts:1589`. Loopback ⇒ `sessionToken = null` (`server.ts:1600`) e il DB non si tocca per DECIDERE. INVARIATO, ed è l'invariante anti-lockout della 080: una `people` corrotta non deve poter chiudere fuori la macchina su cui gira il server. Chi lo «uniforma» un giorno per pulizia si porta via la rete di sicurezza senza sapere di averla toccata — va scritto lì.

2. **Cookie → dispositivo** — `server.ts:1605`. La query `SELECT * FROM devices WHERE token_hash = ?` diventa
   `SELECT d.*, p.revoked_at AS person_revoked_at FROM devices d LEFT JOIN people p ON p.id = d.person_id WHERE d.token_hash = ?`.
   **Zero query in più**: il primo salto è una colonna della riga che si legge già, e `people.revoked_at` viene con lei.

3. **Salto 2, UNA query, e solo se serve** — dentro `resolvePrincipals`:
   ```sql
   SELECT m.org_id FROM org_members m JOIN orgs o ON o.id = m.org_id
    WHERE m.person_id = ? AND m.revoked_at IS NULL AND m.local_blocked_at IS NULL
      AND o.revoked_at IS NULL
   ```
   Su `idx_org_members_person` + PK di `orgs`. Salta del tutto se `person_id IS NULL` o se la persona è revocata. **Tutte e tre le colonne di revoca sono LETTE qui**, e ognuna ha il suo test: una colonna che sembra un interruttore e non è cablata è peggio della sua assenza.

4. **Confinamento derivato** — `device-auth.ts:173-194`. `IdentityInput` guadagna `orgIds: string[]`, `personId`, `personRevoked`, `installationOwnerIds: string[]`; `evaluateIdentity` resta PURA e testabile senza server. `role` sparisce come dato e diventa:
   ```
   confined = personId === null || personRevoked || !installationOwnerIds.includes(personId)
   ```
   **`org_members` non compare in questa formula.** È il punto in cui i tre difetti di lockout/escalation cadono: il fornitore non decide chi è padrone della macchina. Loopback e daemon (`device-auth.ts:176, 190`) restano `confined: false` per TRASPORTO, prima di qualunque lettura.

5. **Deposito** — `server.ts:1633`. La WeakMap passa da `{role, deviceId}` a `{principals, personId, confined, deviceId, rev}`, e `ctx.requestIdentity` (`server/types.ts:251`) cambia forma UNA volta sola. Il commento a `types.ts:248-250` («`null` = proprietario») va riscritto: `null` significa tre cose diverse (percorso esente, identità negata, percorso non gated) e un ramo nuovo che se lo dimentica apre o chiude tutto.

6. **Confinamento nel gate** — `server.ts:1638-1680`, struttura invariata, DUE cose nuove:
   - **il cancello di METODO, che oggi non esiste ed è il buco più grave del presente**: un confinato può fare solo `GET`/`HEAD`, salvo una allowlist ENUMERATA (oggi: `POST /api/auth/logout`). Verificato: l'unico controllo di metodo del server è `server/routes/tasks.ts:599` e vale solo per `/api/tasks/`, `/api/boards/`, `/api/all-boards/`; `server/routes/topics.ts` non legge mai l'identità, quindi oggi un ospite con una grant su un topic può fare `PATCH /api/topics/:id`, `DELETE`, il rollback di un checkpoint, `auto-name` (che spende l'abbonamento del proprietario) e `POST /api/topics/:id/browser/open-pane` — che apre una pane di browser nativo sulla macchina altrui. `level='read'` è oggi una colonna che nessuna query legge. La regola va nel GATE e non nei router, per la stessa ragione già pagata: col filtro nel solo router dei task un ospite leggeva `/api/topics` per intero;
   - le tre SELECT letterali diventano `hasGrant(db, ident.principals, tipo, id)`.

7. **LA DOMANDA CALDA, in un posto solo** — `server/lib/grants-query.ts`, NUOVO, unica porta:
   ```sql
   SELECT level FROM grants
    WHERE resource_type=? AND resource_id=?
      AND ( (subject_type='device' AND subject_id=?)
         OR (subject_type='person' AND subject_id=?)
         OR (subject_type='org'    AND subject_id IN (?,?,…)) )
    ORDER BY (level='deny') DESC LIMIT 1
   ```
   Piano: `SEARCH grants USING INDEX idx_grants_resource`. **OR di uguaglianze per tipo, `IN` solo sugli id dello STESSO tipo**: misurato 1,4-2,0 µs. NON `(subject_type||':'||subject_id) IN (…)` (10-15 µs, espressione non indicizzabile) né row-value `IN (VALUES …)` (13 µs). Costo totale per richiesta remota: 0,83 → ~4,2 µs.
   La funzione interna è `grantRowFor()` e **restituisce la RIGA vincente**, non un booleano: `hasGrant()` è un wrapper. Serve perché «perché la vede?» deve avere una risposta anche nell'audit log, non solo un `autorizzato`.
   Le altre quattro porte: `grantedResourceIds(principals, type)` — **una query PER PRINCIPALE unita in JS**, mai un OR (misurato: 119 µs contro 3.408 µs dell'OR ingenuo, che degrada a scansione; mille volte, e non fa diventare rosso niente); `reasonsFor(principals, type, id)` senza `LIMIT 1`, per l'audit e per la UI; `subjectsOf(db, type, id)` (vedi 8); `holdsGrantOnTaskPreview(db, principals, mediaRelPath)`.

8. **LA DOMANDA INVERSA, che è metà della lente e che `risolvi` non aveva misurato.** `subjectsOf()` restituisce DUE livelli e la UI li mostra entrambi:
   - i soggetti CONCESSI (le righe: `Armonia` (org), `Marco` (persona), `Mac di Anna` (dispositivo));
   - l'insieme EFFETTIVO espanso: per ogni soggetto `org` → `SELECT person_id FROM org_members …` (le stesse tre condizioni di revoca del punto 3) → `SELECT id, name FROM devices WHERE person_id IN (…) AND revoked_at IS NULL`. Due seek, profondità 2, sugli stessi indici.
   La card dice «Condiviso con Armonia (4 persone, 11 dispositivi)» e l'elenco si può espandere. Senza questo, la lente 1 ha ragione: la risposta diventerebbe esatta su un piano e la domanda si farebbe su un altro.

9. **/media** — `server.ts:1671-1676`. Due bug veri, chiusi qui: `t.preview_image LIKE '%'||richiesto` usa una stringa dell'utente coi metacaratteri INTATTI (`GET /media/%25` fa passare il predicato contro qualunque anteprima concessa), e gate e handler derivano il path in due modi diversi (il gate `slice("/media".length)` + `decodeURIComponent`, l'handler `slice("/media/".length)` sul pathname grezzo con `!includes("..")`). Fix: una funzione sola `mediaRelPath(pathname)` usata da entrambi, e `LIKE ? ESCAPE '\'` con `%`/`_`/`\` escapati.

10. **IL WEBSOCKET** — `server.ts:1754-1765` e `server/utils.ts:565-660`. Oggi il codice è già più avanti del rilievo: `isGuestSocketData` (`grants.ts:141`) decide sul RUOLO e non sulla presenza dell'id, ed è consultata da TRE fan-out (`broadcastToAll`, `broadcastToTopic`, `broadcastToTopicSubscribers`) via `mayReceiveFrame`/`mayReadTopic`. Quella forma si CONSERVA — cambia solo cosa c'è dentro:
   - l'upgrade timbra `WSData.principal: ResolvedIdentity | null` (con `deviceId` invariato: il VALORE non cambia, quindi nessun client vede una differenza) e passa dallo STESSO `resolvePrincipals`: oggi l'upgrade rifà cookie→hash→SELECT per conto suo, senza `evaluateIdentity` e senza ruolo, ed è la strada in cui persona e org resterebbero indietro in silenzio. È il SECONDO dei tre punti che traducono cookie→identità; il terzo è `/api/auth/session` (`auth.ts:129`), esente e con una forma di risposta già diversa. **Tutti e tre chiamano `resolvePrincipals`, o il numero torna a tre verità.**
   - `isGuestSocketData(data)` diventa `data.principal?.confined === true` — con lo STESSO verso prudente («un ruolo che non riconosciamo vale ospite») e gli stessi sei test di `grants.test.ts:121-140` riscritti;
   - **l'invalidazione**: il filtro, all'ingresso, confronta `ws.data.principal.rev` con `principals_rev` (una seek su una tabella da una riga, ricontrollata al massimo una volta al secondo) e RI-RISOLVE quel socket se diverge. Non è una cache: è un valore versionato dal DB. Chiude la contraddizione di `risolvi` fra «timbro `confined` all'upgrade» e «un ambito memorizzato è un permesso che sopravvive alla propria revoca»;
   - **`ctx.closeDeviceSockets(deviceId)`**, tre righe accanto a `sendToDevice` (`utils.ts:614`), chiamata da `auth.ts:277` (revoca) e da ogni cambio di `devices.person_id`. Chiude il buco che esiste già oggi: `devices.revoked_at` si legge solo all'upgrade, quindi una socket aperta sopravvive alla revoca — e con i principali quella socket porterebbe l'insieme più largo, non il più stretto.