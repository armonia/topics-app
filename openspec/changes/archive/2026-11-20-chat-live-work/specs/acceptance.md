# Acceptance: chat-live-work

## Barra eseguibile

```bash
cd ~/Projects/topics-app
bun test server/lib/command-redirect.test.ts server/lib/file-tail.test.ts server/lib/live-work.test.ts \
  tests/integration/process-stdout-file.test.ts client/src/components/Chat/SubAgentsStrip.test.tsx \
  client/src/components/Project/ProcessLogPane.test.tsx
# Su questo Mac il config accetta solo WebKit; server isolato :13334, video in test-results/artifacts/
bunx playwright test tests/e2e/chat-live-work.spec.ts --project=webkit
```

Exit 0 tutti e due. Ciò che è verde resta verde: `bun test server/lib client/src/state
client/src/components/Chat client/src/components/Project` non perde test rispetto a prima della
change. Un test che cambia aspettativa di proposito (le righe finite che restavano) si aggiorna
nello stesso commit, e il messaggio lo dice.

## Scenario 1: solo ciò che è vivo

- **GIVEN** una chat con 3 sotto-agenti finiti da ore, 1 sotto-agente al lavoro, 1 comando
  `run_command` in corso che stampa «tick N» ogni secondo e 1 comando lanciato con la sveglia
- **WHEN** la chat è aperta
- **THEN** la striscia ha 3 righe, il sotto-agente e i due comandi, e nessuna riga finita
- **AND** solo la riga del comando con la sveglia dice «sveglia la chat», e il suo nome è una
  volta sola sulla pagina (la riga del lavoro in background non lo ripete)
- **AND** l'anteprima del comando mostra un «tick N» più recente entro 3 s dalla stampa
- **AND** quando il sotto-agente finisce, la sua riga resta con la spunta e sparisce entro 70 s

## Scenario 2: l'output rediretto si vede

- **GIVEN** un comando `run_command` che stampa «tick N» ogni secondo per 30 s con lo stdout
  rediretto su un file a percorso assoluto (`… > /tmp/topics-e2e-<id>.log`)
- **WHEN** si clicca la sua riga
- **THEN** il log mostra «tick 1» entro 3 s e poi le righe successive, mai «Waiting for output...»

## Scenario 3: il server locale

- **GIVEN** un comando `python3 -m http.server <porta libera> --bind 127.0.0.1`
- **THEN** la sua riga mostra la porta, una volta sola sulla pagina, e «apri» porta a
  `http://127.0.0.1:<porta>`
- **WHEN** si clicca «Ferma»
- **THEN** il server non risponde più e la sua riga sparisce

## Mutazioni (su una copia in scratch, mai sul file vero)

- Senza il seguito del file rediretto, lo scenario 2 FALLISCE.
- Con le righe finite tenute per sempre (TTL infinito), lo scenario 1 FALLISCE.

## Prova

I `.webm` dei tre scenari (Playwright `video: 'on'`), più una foto della chat Prince of Persia
vera con Muse e il server delle clip nella striscia, e il log di Muse aperto e pieno.
