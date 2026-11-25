# Delta: chat — la busta dispatchata dice cosa consegna, e quelle già scritte si marcano

## ADDED Requirements

### Requirement: CHAT-ENV-01 — La busta dispatchata porta i commenti che consegna, e le buste già scritte si marcano

Una riga `user` scritta dal dispatcher (kickoff, ripresa, sollecito, continuazione
dopo un'interruzione) SHALL portare il blocco `{ kind: 'dispatched-envelope' }`, e
una busta di ripresa SHALL poter portare `commentIds: string[]`, gli id dei
commenti umani che consegna. Il blocco SHALL essere scritto ALLA FONTE da chi
avvia il turno (`dispatchedFor` nel body di `/api/chat`), e NON SHALL essere
dedotto dal testo da nessun lettore: il client SHALL riconoscere una busta SOLO dal
blocco.

Le buste già scritte prima del marchio SHALL essere marcate da una migration che
riconosce le quattro aperture del dispatcher ANCORATE all'inizio della riga, su
righe `role='user'` con `blocks IS NULL`; una riga già marcata SHALL restare
com'è, e una riga di una persona che cita la busta a metà frase SHALL restare
`NULL`. La migration SHALL essere provata ESEGUENDO il file su un DB sintetico, e
il DB vivo SHALL essere salvato PRIMA che il file esista.

Una busta marcata SHALL essere disegnata dalla chat del topic come riga collassata
(`DispatchEnvelopeRow`), la stessa che usa la conversazione della card.

MISURA: `sqlite3 -readonly data/topics.db "select count(*) from messages where
role='user' and blocks is null and (content like 'You are the exclusive owner of
task%' or content like 'Human update on task%' or content like 'Your previous turn
on this task was interrupted%' or content like 'LAST TURN on%')"` → 0 (riferimento
prima della migration: 2301). `bun test tests/integration/migration-*-dispatched-envelopes.test.ts`
verde: quattro aperture marcate, la riga umana a metà frase `NULL`, la riga già
marcata invariata. `bun test server/lib/user-row-marks.test.ts` verde:
`commentIds` scritti solo con `dispatched` e con elenco non vuoto.

#### Scenario: la ripresa porta gli id
- **GIVEN** un turno avviato con `dispatched: true` e `dispatchedFor: ['c1']`
- **THEN** la riga `user` salvata ha `blocks = [{kind:'dispatched-envelope', commentIds:['c1']}]`

#### Scenario: il kickoff non porta id
- **GIVEN** un turno avviato con `dispatched: true` senza `dispatchedFor`
- **THEN** la riga ha `blocks = [{kind:'dispatched-envelope'}]`

#### Scenario: le buste vecchie si marcano, la citazione no
- **GIVEN** un DB sintetico con quattro righe `user` che aprono con le quattro buste,
  una riga `user` «come diceva: Human update on task…» e una riga già marcata
- **WHEN** il file di migration viene eseguito
- **THEN** le quattro righe hanno il blocco `dispatched-envelope`
- **AND** la riga che cita resta con `blocks IS NULL`
- **AND** la riga già marcata è identica a prima

#### Scenario: la chat non attribuisce la busta alla persona
- **GIVEN** una riga `user` marcata `dispatched-envelope`
- **THEN** la chat del topic la disegna come riga collassata, non come bolla della persona
