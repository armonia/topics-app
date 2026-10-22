# D8 · Sicurezza del browser

Regole comuni: `tracks/_comuni.md`.

**GOAL.** I problemi di sicurezza del browser trovati dall'audit del 14/10, e quello trovato
dopo, sono chiusi in produzione, ognuno con un test che era rosso su main prima della correzione.

**Stato: chiusi tutti e cinque il 15/10**, in produzione e nell'app dalla versione 2.2.507. Un
sesto, trovato il 16/10 dopo l'audit, è chiuso dalla versione 2.3.2.

## Perché le descrizioni arrivano solo adesso

Il repository è pubblico. Descrivere un problema aperto vuol dire spiegare a chiunque come usarlo
prima che sia corretto: finché erano aperti, i dettagli sono rimasti in una nota privata del
proprietario. Ora che sono chiusi, la descrizione sta qui, al livello di un avviso di sicurezza:
cosa poteva succedere, a quali condizioni, come è stato chiuso e quale test lo tiene chiuso.

## I problemi

### S1 · Una pagina in una pane nativa poteva parlare a nome dell'esecutore (alta)

Sul Mac una pane nativa si rispecchia verso i dispositivi abbinati con uno script che gira dentro
la pagina. Il client spediva al server il testo prodotto da quello script senza rileggerlo, e dal
socket dell'esecutore il server accettava anche i comandi che spettano ai viewer. Mentre qualcuno
guardava quella pane da un altro dispositivo, una pagina ostile poteva far navigare e pilotare il
browser del server, che riceve i cookie della pane, e mostrare un indirizzo falso sul dispositivo
che guardava.

Chiusa da #330: il client rilegge e valida ogni evento prima di spedirlo, e dal socket
dell'esecutore il server accetta solo i tipi dell'esecutore (requisito NATDEL-04).

### S2 · Il risultato di un'operazione delegata valeva da qualunque socket del browser (media)

Un'operazione delegata alla pane del Mac si chiudeva con il primo risultato che portava il suo
identificativo, da qualunque socket del browser, e gli identificativi erano prevedibili. Insieme a
S1, una pagina poteva rispondere al posto della pane: risultati falsi agli strumenti di un agente,
o uno stato di login scelto da lei.

Chiusa da #330: un risultato vale solo dal socket registrato per quel contesto, e gli
identificativi sono casuali (NATDEL-04, scenario «un risultato da un altro socket»).

### S3 · Tre letture del browser avevano effetti (media)

Sul Mac le richieste da loopback valgono come proprietario, e il controllo d'origine riguarda le
scritture. Tre letture del browser però facevano qualcosa: aprire una pagina in Chromium, far fare
al server una richiesta verso un indirizzo dato, recuperare risorse anche dalla rete locale.
Qualunque pagina aperta sul Mac poteva farle partire alla cieca, come proprietario.

Chiusa da #332: la rotta che apriva le pagine non c'è più, la sonda `framable` vuole un POST con
corpo JSON, e le risorse del mirror vogliono un token legato al loro contesto.

### S4 · I dispositivi abbinati guardavano il browser del Mac senza segnale sul Mac (bassa)

Guardare e pilotare la pane del Mac da un dispositivo abbinato è voluto, ma sul Mac non si vedeva,
e il mirror mascherava solo le password: un dispositivo perso poteva guardare in silenzio, numeri
di carta compresi.

Chiusa da #353, con cui la pane del Mac dice da quanti dispositivi è guardata e la condivisione si
spegne, e da #334, con cui il mirror maschera anche i campi marcati come numero, codice di
sicurezza e scadenza della carta, o come codice monouso (requisito BROWSER-DOM-MASK-01).

### S5 · Una pagina poteva far salvare dati a nome di altri siti (media)

Lo stato di login che le pane condividono comprende il `localStorage`, catturato dalla pagina
stessa, e la cattura si fidava dell'origine che la pagina dichiarava. Una pagina poteva così far
salvare, e poi ripristinare, valori a nome di altri siti.

Chiusa da #332: un valore catturato vale solo per l'origine che l'app conosce della pane, non per
quella dichiarata dalla pagina, e si ripristina solo su quell'origine.

### S6 · La guardia sulla porta di debug del browser integrato non rispondeva nel server vero (media)

Il browser integrato del server ha una porta di debug fissa. Prima di pilotarlo, il server
controlla che quella porta sia tenuta dal browser che ha appena lanciato, e non da un altro
Chromium della macchina con il debug remoto acceso. Per saperlo chiedeva a `lsof`, chiamandolo per
nome. Il server avviato da launchd o dall'app non ha `/usr/sbin` nel PATH, dove macOS tiene
`lsof`: la domanda restava senza risposta e, per non bloccare l'avvio, la guardia lasciava passare.
Da un terminale e nei test funzionava, ed è per questo che non se n'era accorto nessuno, audit
compreso.

Chiusa da #387, dalla versione 2.3.2: `lsof` si chiama per percorso intero, e il test sulla porta
gira con il PATH che ha il server.

## Cosa era già a posto

Restano coperte dai loro test:
- il controllo dell'origine sui WebSocket;
- gli ospiti esclusi dal browser;
- gli schemi permessi alla navigazione;
- i file di stato con permessi 0600;
- il replayer senza script;
- `file://` servito solo da allowlist con `CSP: sandbox`.

## Barra

```bash
bun run check:security
bun test server/browser-delegate-frames.test.ts server/browser-native-delegate.test.ts \
  client/src/lib/nativeDomHost.page.test.ts server/routes/browser-effects.test.ts \
  server/lib/dom-resource-rewrite.test.ts client/src/lib/shell/tauriBrowserOps.test.ts \
  client/src/hooks/useTauriBrowser.origin.test.ts \
  server/browser-chromium-sidecar-port-owner.test.ts
```

Escono 0: il 18/10, `check:security` verde e 110 test verdi in 8 file.
