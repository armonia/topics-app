# Tasks: subagent-tool-standard

Niente codice finché `.openspec.yaml` non dice `status: approved`.

L'ordine è questo: prima i test rossi, poi il codice. Nessun test lancia una CLI
claude o codex vera. Per le rotte si usa il bridge PTY finto di
`server/routes/terminal.agent-spawn.test.ts`, che registra i frame `create` con
i loro argomenti. Per l'esito si usano fixture di transcript JSONL sotto
`tests/fixtures/subagent/`, ricavate dai casi di produzione citati nella
proposta e ripulite dei segreti.

## 0. Prerequisiti (correzioni sullo stesso ramo, fatte da un altro agente)

- [ ] 0.1 Controllare che siano sul ramo `fix/subagent-tool-standard-0929` prima
      di iniziare il §1:
      - `cwd` preso dal topic quando manca (SUBAGENT-17, `terminal.ts:3395`);
      - prompt incollato **una** volta sola, con il segnaposto `[Pasted text`
        riconosciuto (`terminal.ts:2383-2402`);
      - prompt dichiarato accettato solo quando esiste un record `user` con lo
        snippet (`terminal.ts:2441`, `claude-subagent-transcript.ts:159`);
      - nome scelto dal padre non sovrascritto dall'auto-naming
        (`terminal.ts:2096-2115`).

      Se ne manca una, va fatta qui e il test che la prova va scritto per primo.

## 1. Lancio: modello, profilo, effort (SUBAGENT-08, 09, 10)

- [ ] 1.1 Nuovo `server/lib/subagent-launch.test.ts`, rosso: una tabella di
      casi per `resolveSubagentLaunch({call, profile, parent})` con i campi
      `{model, modelSource, effort, agent, args}`:
      - chiamata `sonnet`;
      - `inherit` da `claude-sonnet-5-5[1m]`;
      - `inherit` da `gpt-…`, che dà nessun `--model` e un motivo;
      - profilo `scout` (sonnet, low);
      - `opus` esplicito che vince sul profilo;
      - override `medium` del topic del padre;
      - valori sconosciuti, che vengono rifiutati.
- [ ] 1.2 Nuovo `server/lib/agent-profiles.test.ts`, rosso: il parsing del
      frontmatter su una home finta con `~/.claude/agents` e
      `<cwd>/.claude/agents`, in cui il progetto vince; la descrizione tagliata
      a 120 caratteri; un file senza frontmatter ignorato senza errori.
- [ ] 1.3 Implementare `subagent-launch.ts` e `agent-profiles.ts`, entrambi
      puri. Il default di `inherit` è la scelta 1.
- [ ] 1.4 Collegarli alla rotta:
      - `createSession` riceve un parametro `launch` e aggiunge `--model`,
        `--agent` ed `--effort` accanto a `--effort` in
        `terminal.ts:1764-1810`;
      - la rotta spawn a `terminal.ts:3357` chiama il risolutore, passa l'id del
        topic del padre per l'effort e risponde con
        `{model, modelSource, agentType, effort, cwd, branch}`.
- [ ] 1.5 Estendere `server/routes/terminal.agent-spawn.test.ts`: il frame
      `create` contiene i flag attesi per `model:"sonnet"` e per
      `agent_type:"scout"`; con un modello o un profilo sconosciuto la risposta
      è 400 e **nessun** frame `create` arriva al bridge.
- [ ] 1.6 Schema di `spawn_agent` in `server/mcp/topics-mcp-server.ts:621-640`,
      con `model`, `agent_type`, `effort` e `run_in_background`:
      - l'elenco dei profili è costruito quando si serve la lista dei tool, e
        vale anche per `topicsToolSpecs` del runtime nativo;
      - la descrizione dice di non scegliere `haiku` da solo;
      - il cast dell'handler (`:2775`) include tutti i campi.

      Test in `topics-mcp-server.test.ts`.
- [ ] 1.7 Verifica a mano, senza turni: `claude agents` elenca `scout`,
      `verifier` e `oracle`. Una PTY aperta con `--agent scout --model sonnet`
      mostra nell'intestazione il modello atteso. Si chiude senza inviare un
      prompt.

## 2. Esito per turno (SUBAGENT-11, SUBAGENT-04 modificato)

- [ ] 2.1 Fixture in `tests/fixtures/subagent/`:
      - `completed.jsonl`;
      - `startup-only.jsonl`: solo mode, permission-mode e system, il caso
        d6158ec6 e c82359c1;
      - `stopped-midturn.jsonl`: «Sto mappando…»;
      - `spend-limit.jsonl`, con il record `<synthetic>`;
      - `two-turns.jsonl`.
- [ ] 2.2 Nuovo `server/lib/subagent-result.test.ts`, rosso: un caso per ogni
      stato e il deduplicato per `(agentId, turn)`.
- [ ] 2.3 Implementare `classifyChildTurn` in `server/lib/subagent-result.ts`.
- [ ] 2.4 Riscrivere `server/routes/subagent-exit.ts` sull'esito e togliere
      l'emoji. Aggiornare `subagent-exit.test.ts` con gli scenari di
      SUBAGENT-04 modificato.
- [ ] 2.5 Terminal.ts:
      - riconoscere la fine turno dal transcript, con l'hook `Stop` via
        `claude-hooks.ts` come acceleratore;
      - consegnare l'esito senza aspettare l'uscita;
      - classificare `stopped`, `lost` e `undelivered` sui percorsi di stop,
        chiusura tab, «Ricarica» (`:3305`) e spazzata delle orfane.
- [ ] 2.6 `subagent-watch.ts` `deliverExit`:
      - deduplicato per turno;
      - blocco `subagent-result` nella riga;
      - nome scelto dal padre.

## 3. Notifica, risveglio, primo piano (SUBAGENT-12, 13)

- [ ] 3.1 Test rosso in `server/services/subagent-wake.test.ts`, costruito come
      `goal-loop.test.ts`, con la rotta chat finta:
      - un padre inattivo riceve un solo POST;
      - con un 409 l'esito attende la fine del turno;
      - due esiti a 1 s di distanza producono un solo risveglio;
      - un tag di controllo imitato arriva neutralizzato.
- [ ] 3.2 Implementare `server/services/subagent-wake.ts`, sul modello di
      `goal-continuation.ts`.
- [ ] 3.3 `run_in_background:false`:
      - attesa fino a 10 minuti con un battito di progresso ogni 30 s;
      - timeout della fetch in `callSpawnAgent` portato a 11 minuti;
      - nessun risveglio doppio per lo stesso turno.

      Test con il bridge finto e i timer finti.

## 4. Ripresa e tetti (SUBAGENT-14, 15)

- [ ] 4.1 Migration `server/db/migrations/NNN-subagents.sql`, con la tabella
      `subagents`:
      - **prima** il backup di `data/topics.db`, `-wal` compreso;
      - un test che esegue il file contro un DB sintetico, come
        `tests/integration/migration-074-*.test.ts`;
      - il manifest embedded rigenerato.
- [ ] 4.2 Test rossi sulla rotta con il bridge finto:
      - figlio `retired`, poi `send_to_agent`, che produce un frame `create` con
        `--resume <id>` e gli stessi flag;
      - un riavvio simulato, cioè le mappe svuotate e la riga nel DB, dopo cui
        la ripresa funziona;
      - 404 con il motivo per un id `a` + 16 hex;
      - 410 oltre le 24 h.
- [ ] 4.3 Ritiro dopo 15 minuti di inattività dopo l'esito (scelta 5). Il
      parcheggio a `terminal.ts:2689` ammette i figli **solo** in questo caso.
- [ ] 4.4 Contare i tetti dalla tabella (`terminal.ts:2262-2264`) e aggiungere
      il tetto globale di 6 (scelta 4), con il 429 che elenca chi occupa i
      posti. Test con 6 figli vivi sotto 3 padri.

## 5. UI (SUBAGENT-16)

- [ ] 5.1 `client/src/components/Chat/toolDetail.ts` e
      `server/providers/claude/tool-detail.ts:431`: `spawn_agent`, nudo o
      `mcp__topics__`, finisce sulla card del sotto-agente invece che su quella
      MCP generica. Test in `toolCardBody.test.ts`.
- [ ] 5.2 Nuovo `Chat/SubAgentResultCard.tsx`, usato per la card della chiamata
      e per la riga dell'esito. Icone lucide, niente emoji.
- [ ] 5.3 `SubAgentsStrip.tsx`:
      - lo stato viene dall'esito e dal seed, non dai byte della PTY;
      - «Sotto-agenti» e gli stati passano da i18n.
- [ ] 5.4 Chiavi in `client/src/i18n-chat-it.ts` e `i18n-chat-en.ts`.
- [ ] 5.5 E2E sul server isolato :13334, con una chat seminata con una chiamata
      `spawn_agent` e i blocchi `subagent-result` di tre stati (`completed`,
      `undelivered`, `stopped` parziale):
      - ogni card mostra il suo stato;
      - la generica MCP non compare;
      - il video resta come prova.

      Prima di lanciarlo, `memory_pressure | tail -1` deve dare free ≥ 20 %.

## 6. Prova

- [ ] 6.1 `bunx --bun @fission-ai/openspec@latest validate subagent-tool-standard`
      esce 0.
- [ ] 6.2 Esecuzione dei soli test toccati: `bun test` su
      `server/lib/subagent-*.test.ts`, `server/lib/agent-profiles.test.ts`,
      `server/routes/subagent-exit.test.ts`,
      `server/routes/terminal.agent-spawn.test.ts`,
      `server/services/subagent-wake.test.ts` e
      `server/mcp/topics-mcp-server.test.ts`. Poi typecheck.
- [ ] 6.3 `docs/board-protocol.md` e il testo di `buildKickoff`: allinearli se
      il kickoff parla di `spawn_agent`. Oggi a `task-dispatcher.ts:2769` chiede
      `cwd=<this working directory>`, che con SUBAGENT-17 diventa superfluo ma
      resta innocuo.
