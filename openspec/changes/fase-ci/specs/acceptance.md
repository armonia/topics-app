# Barra di fase-ci

Comando unico, uguale ogni volta (exit 0 = verde):

    bun test server/services/red-bounce.test.ts server/routes/tasks.red-bounce.test.ts \
      server/services/auto-land.test.ts server/routes/tasks.autoland.test.ts \
      server/services/integration-queue.test.ts server/routes/tasks.integration.test.ts \
      shared/workflow.test.ts && bun run typecheck:server

Scenari che la barra copre:
1. card in review rossa sul commit consegnato → in_progress con il log, senza persone; rosso di un commit vecchio → ferma; 3 giri → resta e chiede.
2. `server/lib/x.ts` atterra da solo; `client/src`, push, auth, `package.json`, `scripts/`, `auto-land.ts` no.
3. due card chieste insieme → UN commit di integrazione misurato, poi due land; lotto rosso di due → si dimezza, la colpevole torna all'agente, l'altra atterra.
4. conflitto nel lotto → solo quella card torna all'agente; le altre proseguono.
5. card con intenzione rimandata e riconsegnata verde → rientra in fase CI senza human review; con `human_ask` → human review.
6. stage `ci` non conta in `awaitsHuman`.

Mutazione sul punto critico: togliere il rimando nella spazzata fa fallire `tasks.red-bounce.test.ts` (provato: 2 fail).
Misura dopo il deploy, a 7 giorni: mediana review→done delle card chiuse da `system` contro 4,8 h di quelle chiuse a mano.
