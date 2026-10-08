# Acceptance: chat-strips-in-transcript

## Barra eseguibile

```bash
cd ~/Projects/topics-app
bun test client/src/components/Chat/liveWorkCard.test.ts client/src/components/Chat/SubAgentsStrip.test.tsx \
  client/src/hooks/useBackgroundShell.test.ts
# Su questo Mac il config accetta solo WebKit; server isolato :13334, video in test-results/artifacts/
bunx playwright test tests/e2e/chat-strips-in-transcript.spec.ts --project=webkit
```

Exit 0 tutti e due. Ciò che è verde resta verde: `bun test client/src/components/Chat
client/src/state client/src/hooks` non perde test, e le spec che toccano le strisce
(`chat-command-visible`, `chat-running-server`, `chat-changed-files`, `chat-accordion-no-shift`,
`chat-checkpoints`, `chat-live-work`, `chat-goal`, `subagent-strip-survives`) restano verdi
dove lo erano sul bundle di HEAD. Quelle che cambiano aspettativa di proposito (il clic sulla
riga apre la card, la striscia sta nel trascritto) si aggiornano nello stesso commit.

## Scenario 1: le strisce sono la fine del trascritto (CHAT-END-01)

- **GIVEN** una chat con 30 messaggi, letta in fondo
- **WHEN** parte un comando della chat, poi arriva il goal
- **THEN** la riga del comando e il goal stanno nel trascritto, dopo l'ultimo messaggio, sopra il
  blocco del composer e sulla sua colonna; il blocco del composer non li contiene
- **AND** la vista resta in fondo (distanza ≤ 1 px) a ogni striscia che compare
- **WHEN** chi legge sale di sei colpi di rotella, e sotto di lui arriva una riga e se ne va un'altra
- **THEN** il messaggio che legge non si sposta (≤ 1 px)

## Scenario 2: la riga apre la card che ha lanciato il comando (SUBSTRIP-02)

- **GIVEN** un turno vero (CLI finta) che lancia un comando con `run_command`, che stampa
  «CMDWATCH-TICK N» ogni 0,3 s, e finisce con 60 righe che portano la card fuori vista
- **WHEN** si clicca la riga del comando nella striscia
- **THEN** la card `tool-call-row-toolu_cmdwatch` è in vista fra la barra delle tab e il composer,
  aperta, con il log dal vivo che avanza e si legge senza codici colore (i tick escono in verde),
  e il suo riquadro mostra l'ultima riga come faceva il log agganciato; nessun log agganciato
- **AND** dopo un reload (la storia arriva senza risposta) lo stesso clic trova la stessa card
- **AND** un comando lanciato dalla sola route, senza card, apre il log agganciato sopra le righe
- **WHEN** il comando finisce
- **THEN** la sua riga se ne va e la card dice com'è finito, con le ultime righe
- **AND** il turno che la sua fine sveglia scrive sotto, ma la vista resta sulla card (mai a meno
  di 300 px dal fondo, frame per frame) e la freccia per il fondo conta i messaggi nuovi

## Mutazione (su una copia in scratch, mai sul file vero)

- In una copia di `client/` dove `openCommand` non cerca la card (sempre il log agganciato), lo
  scenario 2 FALLISCE.

## Prova

I `.webm` dei due scenari (Playwright `video: 'on'`), più una foto della chat Prince of Persia
vera in sola lettura: le strisce in fondo al trascritto, la card di Muse aperta dalla sua riga.
