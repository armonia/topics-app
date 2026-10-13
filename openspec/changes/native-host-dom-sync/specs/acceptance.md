# Acceptance — native-host-dom-sync

Barra eseguibile (esce non-zero se rossa):

    bun test server/lib/native-dom-host.test.ts server/browser-host-mirror.test.ts
    (cd client && bun test src/lib/nativeDomHost.test.ts src/lib/domHostSupport.test.ts src/hooks/nativeExecutorSocket.test.ts)
    gh pr checks <pr>   # e2e browser-native-host-sync verde in CI

## Requirement: NATIVE-HOST-01 — Un host nativo vivo è la sorgente del mirror
- GIVEN un contesto con un delegato nativo che si dichiara host DOM
- WHEN uno spettatore chiede `set_render: dom`
- THEN riceve meta + snapshot dall'host, e il server NON crea un contesto Chromium

## Requirement: NATIVE-HOST-02 — L'input dello spettatore va all'host, una volta
- WHEN lo spettatore tocca il mirror
- THEN l'host riceve UN `host_input` click alle coordinate della pagina

## Requirement: NATIVE-HOST-03 — Il Mac resta nativo mentre l'iPad guarda
- GIVEN la pane nativa che fa da host
- THEN `auto` non la porta nella sessione condivisa

## Mutazione sul punto critico
Togli l'instradamento `host_input` → l'e2e del tap diventa rosso.
