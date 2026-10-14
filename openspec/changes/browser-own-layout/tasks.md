# Tracce — browser-own-layout

Lo stato di una traccia lo dà il suo test, non una casella.

- **T1 protocollo e server.** `resize.layout` ('own' | 'page'); l'arbitro dell'host nativo non dà
  mai la guida a un dispositivo che si impagina da sé, e il suo uso restituisce la pagina al Mac.
  Barra: `bun test server/browser-host-viewport.test.ts server/browser-host-mirror.test.ts`.
- **T2 mirror alla sua misura.** `DomCoBrowse` con host nativo, mirror interrogabile e modalità
  propria: iframe grande come la pane, scala 1. Barra: e2e «Il Mac resta suo», «Il mirror è
  dell'iPad».
- **T3 tocchi per elemento.** Id rrweb + frazione nel rettangolo; l'host lo ritrova nel suo layout.
  Barra: e2e «Il tocco trova l'elemento», «Solo sull'iPad»; unitari `nativeDomHost.page.test.ts`,
  `browser-host-input-rest.test.ts`.
- **T4 scroll per ancora.** L'host allega l'ancora agli eventi di scroll e allo snapshot; il mirror
  la applica (plugin del replayer); l'inoltro porta l'ancora; l'eco si riconosce per ancora.
  Barra: e2e «Swipe», «Il Mac scorre», «Bordi»; unitari `mirrorLayout.test.ts`, `mirrorScroll.test.ts`.
  Dipende da T2.
- **T5 interruttore.** Per dispositivo, nel menu della pane; stato visibile. Barra: e2e
  «Interruttore». Dipende da T1, T2.
- **T6 spec e verifica.** TOPIC-BROWSER-05 e NATIVE-HOST-04 aggiornati, BROWSER-DOM-LAYOUT-01..04;
  un giro di verificatore. Barra: `check:spec-coverage` verde.
