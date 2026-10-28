# Acceptance: card cloud (Fase 1)

## Barra eseguibile

    bun test server/providers/claude-cloud/
    bun run typecheck:server
    E2E_PORT=13451 E2E_EVIDENCE=1 npx playwright test tests/e2e/board-cloud-card.spec.ts --project=webkit

(Sul Mac Playwright gira solo WebKit, il motore della shell: la config rifiuta Chromium.)

Tutte e tre escono 0. Ciò che era verde resta verde: `bun test server/services/task-dispatcher*`
e `npx playwright test tests/e2e/board-remote-node.spec.ts`.

## Scenario (spec-flow, con video)

**Una card su «Cloud Claude» gira nel cloud e torna in review col suo ramo**
- Dato un progetto con origin e la macchina «Cloud Claude» registrata (finto cloud della suite)
- Quando nella scheda scelgo «dove gira» = Cloud Claude e metto la card in coda
- Allora la colonna dice «su Cloud Claude», il dispatcher apre UNA sessione col ramo
  `claude/card-<id8>-…` e il testo della card nel prompt
- E la card arriva in review con un commento che porta il riassunto e il link
  `https://claude.ai/code/<sessione>`
- E il ramo della sessione è nel checkout locale, col file che la sessione ha scritto

Video: `prova/card-cloud-review.webm` (copia del giro verde del 26/10).

## Mutazione sul punto critico

Tolto il controllo di silenzio in `node.ts`, il test «sessione muta oltre la soglia» diventa
rosso (provato il 26/10: 5 pass, 1 fail; ripristinato: verde).

Il polling che smette di ricevere eventi a metà sessione deve dare `stalled`, mai `done`
(`claude-cloud.test.ts`, «polling morto a metà»). Una sessione finita in errore va in review
senza ramo e con `cloud_session_failed` (`node.test.ts`).

## Casi coperti in `node.test.ts`

Riavvio (la sessione viva si riprende, nessuna seconda), checkout indietro rispetto a origin,
sessione in errore dopo il push (niente ramo), origin non GitHub (review col motivo), token
mai chiesto su un'API finta, origin muto alla fine (si riprova), domanda aperta ≠ stallo,
card rimandata indietro (la sessione finita non si archivia), host GitHub confrontato intero.
