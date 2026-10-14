# Acceptance — browser-own-layout

## Barra eseguibile

1. `bunx playwright test --project=webkit tests/e2e/browser-own-layout.spec.ts` esce 0. Host vero
   (`client/src/lib/nativeDomHost.ts` che pilota una pagina WebKit col registratore rrweb del
   server) a 1200×800; app del visore a 1280×800, pane del browser larga 1024.
2. Gli stessi scenari escono ROSSI col codice di main al posto di quello nuovo (la prova morde).
3. `bun test` sui file toccati verde; mutanti su copie: ancora non rimandata identica, host che
   torna a ridimensionarsi, tocco per coordinate invece che per elemento, bordo che non vince sulla
   linea di lettura → ciascuno rosso.
4. `scripts/qa-gate.sh --veloce` verde; su WebKit verdi anche `browser-mirror-scroll-lands`,
   `browser-native-host-sync`, `browser-dom-cobrowse`, `browser-dom-tap-once`, `browser-viewport-*`.
5. Il video `.webm` dello scenario «swipe» è la prova di comportamento.
6. Dal vivo, dopo il deploy: il server inoltra `layout: 'own'` e a un dispositivo che si impagina
   da sé non risponde con `host_viewport` con misura.

## Scenari (WebKit)

- **Il Mac resta suo**: dopo tap e swipe sull'iPad la pagina del Mac è ancora larga 1200.
- **Il mirror è dell'iPad**: l'iframe è largo come la pane, a scala 1, e mostra la variante stretta
  del CSS mentre il Mac mostra quella larga.
- **Il tocco trova l'elemento**: un bottone che nei due layout sta in punti diversi riceve il click
  sul Mac; quello che sul Mac sta a quelle coordinate no.
- **Solo sull'iPad**: un bottone nascosto sul Mac (media query) fa girare il suo handler sul Mac, e
  l'effetto si vede sull'iPad.
- **Swipe**: dopo uno swipe col dito sull'iPad, la riga alla linea di lettura dell'iPad è alla linea
  di lettura del Mac (±2 px), e il mirror non si muove più dopo il gesto.
- **Il Mac scorre**: uno scroll fatto sulla pagina del Mac porta il mirror alla stessa riga; in
  fondo alla pagina il mirror è in fondo.
- **Bordi**: Mac in cima → mirror in cima, anche se alle due linee di lettura ci sono card diverse.
- **Interruttore**: con «Misura: del Mac» il mirror mostra la pagina del Mac in scala e il Mac torna
  a prendere la misura della pane quando la si usa; la scelta sopravvive al ricaricamento; tornando
  a «Misura: questo schermo» il Mac riprende subito la sua.
