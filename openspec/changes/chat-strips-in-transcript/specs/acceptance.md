# Acceptance: chat-strips-in-transcript

## Barra eseguibile

```bash
cd ~/Projects/topics-app
bun test client/src/components/Chat/launchedProcess.test.ts client/src/components/Chat/SubAgentsStrip.test.tsx \
  client/src/hooks/useBackgroundShell.test.ts
# Server isolato :13334, video in test-results/artifacts/
bunx playwright test tests/e2e/chat-strips-in-transcript.spec.ts --project=webkit --repeat-each=3
GITHUB_ACTIONS=true bunx playwright test tests/e2e/chat-strips-in-transcript.spec.ts --project=chromium
```

Exit 0 tutti e tre. Ciò che è verde resta verde: `bun test client/src/components/Chat
client/src/state client/src/hooks` non perde test, e le spec che toccano le strisce
(`chat-command-visible`, `chat-running-server`, `chat-changed-files`, `chat-accordion-no-shift`,
`chat-checkpoints`, `chat-live-work`, `chat-goal`, `subagent-strip-survives`) restano verdi
dove lo erano sul bundle di HEAD. Quelle che cambiano aspettativa di proposito (il clic sulla
riga apre il suo log lì, la striscia sta nel trascritto) si aggiornano nello stesso commit.

## Scenario 1: le strisce sono la fine del trascritto (CHAT-END-01)

- **GIVEN** una chat con 30 messaggi, letta in fondo
- **WHEN** parte un comando della chat, poi arriva il goal
- **THEN** la riga del comando e il goal stanno nel trascritto, dopo l'ultimo messaggio, sopra il
  blocco del composer e sulla sua colonna; il blocco del composer non li contiene
- **AND** la vista resta in fondo (distanza ≤ 1 px) a ogni striscia che compare
- **WHEN** chi legge sale di sei colpi di rotella, e sotto di lui arriva una riga e se ne va un'altra
- **THEN** il messaggio che legge non si sposta (≤ 1 px)

## Scenario 2: la riga apre il suo log lì, ad accordion (SUBSTRIP-02)

- **GIVEN** un turno vero (CLI finta) che lancia un comando con `run_command`, che stampa
  «CMDWATCH-TICK N» ogni 0,3 s, e finisce con 60 righe che portano la card fuori vista; altri
  cinque comandi, più righe di quante la striscia ne mostrasse prima di scorrere dentro di sé;
  chi legge è in fondo
- **WHEN** si clicca la riga del comando nella striscia
- **THEN** la riga è aperta (`data-open`, `aria-expanded`) con sopra di sé il log dal vivo della
  card (`shell-live-output`), che avanza, si legge senza codici colore (i tick escono in verde) e
  mostra l'ultima riga
- **AND** la riga resta dov'era e chi era in fondo resta in fondo (entro 1 px); `scrollTop` cresce
  esattamente quanto la striscia (entro 1 px): la trascrizione non va da nessuna parte
- **AND** la card d'origine resta chiusa e fuori vista
- **WHEN** parte un secondo comando (dalla sola route) mentre il log si apre
- **THEN** la sua riga arriva sotto chi legge in fondo, che resta in fondo (entro 1 px)
- **WHEN** si clicca la sua riga
- **THEN** si apre il suo log e si chiude il primo: al massimo una riga aperta, e la riga cliccata
  resta dov'era
- **WHEN** si clicca di nuovo la stessa riga
- **THEN** il log si chiude, nessuna riga è aperta, la riga resta dov'era e chi legge è in fondo
- **WHEN** il primo comando, riaperto, finisce
- **THEN** la sua riga resta aperta, dice com'è finito con le ultime righe («CMDWATCH-LAST 42») e
  non ha più Ferma
- **AND** il turno che la sua fine sveglia scrive sopra le strisce, e chi legge resta in fondo
- **WHEN** si clicca la riga finita
- **THEN** il log si chiude e la riga se ne va

## Mutazione (su una copia in scratch, mai sul file vero)

- In una copia di `client/` dove il clic sulla riga, oltre ad aprire il log, rimette il salto alla
  card d'origine (`findLaunchCard` e `revealToolCall` come in HEAD), lo scenario 2 FALLISCE.
- Col bundle di prima del fix della presa (che contava come movimento il mezzo pixel e non
  recuperava il pin respinto), lo scenario 2 FALLISCE: la riga del secondo comando resta 24 px
  sotto chi era in fondo.
- Con la presa minima portata a 2,5 s, così che quella riga arrivi dentro la presa, togliere il
  recupero del pin fa fallire lo scenario 2; col recupero passa.

## Prova

I `.webm` dei due scenari (Playwright `video: 'on'`), più una foto della chat Prince of Persia
vera in sola lettura: le strisce in fondo al trascritto, una riga comando aperta col suo log.
