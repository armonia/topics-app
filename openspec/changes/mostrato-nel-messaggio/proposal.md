# Ciò che un agente mostra resta nel messaggio

Richiesta della persona che usa Topics (20/11): «la sessione dice: ti sto facendo vedere questo, ma non vedo nessun browser o cosa visiva e dobbiamo capire come vengono fatti al top di solito queste cose sugli altri client».

## Da decidere
Niente. Le scelte sono tecniche e sono prese qui sotto. La scheda della domanda con le immagini (traccia M2) arriva a vista.

## Perché
Il 19/11 alle 22:44Z, nel topic 288559de, l'agente apre un'immagine nel pannello (`open_browser_pane`, esito `visible:true`) e chiede «Nel pannello ci sono le 4 proposte affiancate… quale?». La persona non vede niente. La risposta arriva tre ore dopo, per un'altra strada.

Verificato nel codice:
1. `visible` vuol dire «qualche socket è agganciato» (`hasAttachedPane`, `server/browser-viewer-count.ts:91-101`): conta un pannello nascosto e un altro dispositivo.
2. Ogni apertura lascia già un segno nel messaggio che riporta la pagina a schermo (CHAT-BROWSER-01, `client/src/components/Chat/BrowserOpenMarker.tsx`), ma per scelta senza immagine. Senza pannello davanti la persona non ha niente.
3. Un'immagine entra nel messaggio come media solo a fine turno (`server/routes/chat-finalize.ts:666`), e una domanda tiene fermo il turno: «apro e chiedo» lascia la persona senza immagine fino alla risposta. La raccolta guarda solo `~/.topics/media` e `media/browser`, non le sottocartelle (`server/utils.ts:1267`).
4. L'agente ha passato un URL assoluto con la porta dell'app desktop (`http://127.0.0.1:13333/api/media?path=…`): solo il riferimento relativo è trattato come file locale (`server/browser-tools-handler.ts:149`).
5. Con due aperture di fila sulla stessa origine il pannello nativo prende per caricata la pagina di prima (`waitForPaneLoad`, `client/src/lib/shell/tauriBrowserOps.ts:132-160`): la risposta riporta l'URL vecchio e l'annuncio lo ritrasmette ai client (`server/routes/browser-open-pane-flow.ts:159`). Nel topic: 5 risposte su 13.
6. `ask_user_question` porta solo testo. Lo schema ha `label`, `description`, `recommended` (`server/mcp/tool-catalog.ts:492-535`) e `sanitiseQuestion` butta via tutto tranne i primi due, `recommended` compreso (`server/providers/ask-user-detector.ts:127`).

## Come lo fanno gli altri
Nei client migliori ciò che l'agente mostra è un oggetto con un indirizzo e un segno che resta nel messaggio: l'artifact di Claude (URL che si aggiorna sul posto, chip nella conversazione), il video di Devin allegato al messaggio, gli screenshot di Copilot e Cursor nella PR. Il pannello è un modo di guardarlo, non il posto dove vive. Nessuno documenta un segnale «la persona ha visto»: il ritorno passa da una scelta o da un commento riportati alla sessione. Le scelte visive si fanno con varianti affiancate e un controllo che riporta la scelta. Guasti noti da non rifare: il visivo che non arriva sul telefono, l'allegato col link rotto, il pannello che funziona solo in primo piano. Fonti e dettagli: `../mostrato-nel-messaggio-ricerca/stato-dell-arte.md`.

## Cosa cambia
- **R1 Il segno dell'apertura porta ciò che è stato mostrato.** Il segno che c'è già per ogni `open_browser_pane` mostra anche la cosa: il file (immagine, video, PDF) oppure una foto della pagina scattata all'apertura. Nasce dal risultato dello strumento: c'è subito, anche mentre il turno è fermo su una domanda. Sta nel messaggio salvato: si vede su ogni dispositivo, col pannello chiuso e dopo un riavvio. Si rovescia la scelta «nessuna immagine» di CHAT-BROWSER-01 perché senza pannello la persona restava senza niente. Un solo modo di rendere il media (quello di `client/src/components/messageMedia.ts`), percorsi con spazi compresi, e nessun doppione se l'agente scrive anche `MEDIA:`.
- **R2 Indirizzi giusti.** Un URL assoluto verso un'origine di questo server (la sua porta, o quella dell'app desktop che il server conosce) che punta a `/api/media` vale come il riferimento relativo; un'altra porta resta com'è. Il pannello nativo prende per caricata solo la pagina chiesta, non quella di prima sulla stessa origine; dopo un reindirizzamento l'URL raggiunto resta quello vero. L'annuncio ai client porta l'URL chiesto.
- **R3 La domanda porta ciò di cui parla.** `ask_user_question` accetta immagini per la domanda e un'immagine per opzione. Arrivano fino alla scheda da tutti e tre i motori (oggi `sanitiseQuestion` le butterebbe, come butta `recommended`). La scheda le mostra, si aprono nel visore che c'è già, e si sceglie toccando l'immagine. La domanda di una sessione di card, che finisce nel thread, porta le immagini come allegati del commento.
- **R4 Chi non scrive dove la persona legge lo sa.** In un topic di sottoagente o di card la risposta dello strumento lo dice, qualunque cosa dica `visible`: il sottoagente restituisce il percorso a chi l'ha lanciato, la card lo allega (`preview_image`, `comment_task media`). In una sessione di terminale non c'è messaggio: la risposta dice che resta solo il pannello.
- **R5 Le parole date all'agente.** Mostrare è lasciare nel messaggio, il pannello è in più. Per un file locale si passa il percorso; un file fuori dalle cartelle servite va prima copiato sotto `~/.topics/media`. Non si dice alla persona di guardare il pannello: si indica l'anteprima nel messaggio. Sparisce «Do not mention the tool to the user». Il golden della superficie degli strumenti e il testo fissato in `server/context/regression.test.ts` si rigenerano di proposito.

## Barra
In `specs/acceptance.md`, una per traccia: test che escono non-zero, uno scenario con video su desktop e telefono, una mutazione sul punto critico.

## Fuori
Artifact con versioni, galleria e condivisione; presa di controllo del browser; link pubblici; un visore nuovo.

## Non ancora specificato
- **«A schermo» vero.** Oggi `set_watching` vuol dire «spettatore della sessione condivisa»: il pannello nativo non lo manda e quello in iframe manda `false` mentre la persona guarda. Per sapere se qualcuno ha il pannello davanti serve un segnale nuovo, esplicito, da web e da nativo. Con R1 non serve per vedere: servirà solo se l'agente deve sapere se qualcuno guarda dal vivo.
- **Perché la domanda delle 22:44 non ha lasciato notifica.** La causa non è letta. La regola ATTN-07 vuole che la stessa domanda ripresentata dopo un riavvio non rinotifichi; qui la domanda era nuova. La traccia M2 trova prima la causa, con la prova.
- **Il giudizio ancorato a un punto dell'immagine** (la persona indica dove, l'agente riceve ritaglio e coordinate): prima si guarda come viene usata R3.

## Deciso da me
- Il segno esistente si arricchisce, non se ne aggiunge un secondo.
- Niente segnale «a schermo» adesso: quello che c'è non regge, e con R1 la persona vede comunque.
- Due tracce in fila: M1 (R1, R2, R4, R5), poi M2 (R3): rigenerano lo stesso golden.

## Verifica del disegno
Un verificatore su un modello diverso ha smontato la prima stesura (20/11). Ne è uscito: il segno esiste già (R1 lo arricchisce), l'immagine a fine turno non cura «apro e chiedo» (ora nasce dal risultato dello strumento), l'URL vecchio nasce nel pannello nativo e non nel server (R2 corretta), il segnale «a schermo» non copriva nativo e iframe (tolto), `openspec validate` vuole un delta in `specs/<capability>/spec.md`.
