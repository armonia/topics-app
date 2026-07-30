## Why

La chat strutturata di Topics **non funziona out-of-the-box** e richiede di attivare un
toggle nascosto in Settings per creare nuove chat. Tre cause reali, verificate sul server
vivo (`GET /api/providers` → registry, `2.1.206`):

1. **Default provider morto.** Il registry ha `claude` (provider SDK/API Anthropic) come
   `default`, ma su questa macchina **non ha una API key usabile** (`ANTHROPIC_API_KEY`
   assente → `diagnose()` lo marca `unavailable`, `present:false`). Risulta comunque
   `connected:true` perché `ClaudeProvider.get connected()` ritorna `this.client !== null`
   e `new Anthropic({apiKey})` costruisce un client anche con key vuota. Quindi
   `recomputeDefault()` non lo declassa mai, e **ogni topic senza `provider` esplicito
   dispatcha su `claude` → 401 → "No response received"**. Il provider realmente pronto e
   coperto da subscription (`claude-code`, la CLI locale) non diventa mai il default.

2. **Gate `enableNewChat: false`.** Il default di `AppSettings.enableNewChat` è `false`,
   che nasconde/disattiva **ogni** affordance di creazione chat (sidebar +, ⌘⇧N, command
   palette, new-chat di progetto). Il gate era nato perché una nuova chat guidava turni
   "a pagamento" (`claude --print`). Ma — verificato luglio 2026 — lo split di billing del
   15 giugno è stato **messo in pausa e mai attivato**: `claude --print` con login
   subscription locale **attinge dalla subscription** (nessun costo metered). Il gate quindi
   nasconde una feature che oggi è inclusa. Fonte: docs Claude Code "Manage costs", report
   The New Stack sulla pausa dello split.

3. **Lista modelli datata.** `ClaudeCodeProvider.listModels()` ritorna
   `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5`. La CLI installata (2.1.206)
   accetta alias e nomi correnti: `fable`/`opus`/`sonnet`/`haiku`, `claude-fable-5`,
   `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`. Il picker mostra quindi
   versioni vecchie.

L'architettura chat (provider registry, snapshot manager, SSE, composer, ProviderModelPicker)
è **solida**: non va demolita, vanno tolti questi tre inceppi + un audit dei pulsanti del
composer perché ognuno sia sensato, cablato e aggiornato.

## What Changes

1. **Default provider onesto e subscription-first.**
   - `ClaudeProvider.get connected()` SHALL riflettere una key **usabile**
     (`this.client !== null && Boolean(this.config.apiKey)`), così un `claude` senza key non
     è più considerato connesso e `recomputeDefault()` lo declassa.
   - `recomputeDefault()` SHALL preferire il path **subscription** (`claude-code`, poi
     `codex`) rispetto ai path metered (`claude`/`openai`) quando il default corrente non è
     connesso, così l'app sceglie da sola il provider gratuito-in-subscription pronto.
     L'override esplicito via `AI_PROVIDER` e la scelta per-topic restano rispettati.

2. **Chat abilitata di default.** `enableNewChat` default → `true`. Il controllo resta in
   Settings → Features (senza badge "Paid", con nota "usa la tua subscription Claude"), ma
   non è più necessario toccarlo per usare la chat. Le entry-point di creazione tornano
   visibili di default.

3. **Modelli aggiornati.** `ClaudeCodeProvider.listModels()` SHALL elencare i modelli
   correnti supportati dalla CLI (Opus 4.8 / Sonnet / Haiku / Fable 5), con il modello
   configurato in testa (comportamento invariato per `models[0]`). `fast-models.ts` resta
   allineato (haiku per claude-code).

4. **Audit pulsanti composer.** Ogni controllo di `ChatInput` (attach, plan mode, fast
   mode, context ring, provider/model picker, mic, overflow con slash-command + voice, il
   pulsante unificato send/queue/stop) SHALL essere verificato cablato e sensato; le
   slash-command e la lista `/model` SHALL riflettere provider/modelli reali. Elementi
   morti o stantii vanno corretti o rimossi.

**Non-goal:** nessun ritorno al provider `claude` SDK come default quando privo di key;
nessun cambio all'auth della CLI o al proxy account-switcher; nessuna dipendenza da una key
API metered per far funzionare la chat; nessuna riscrittura dell'architettura chat; nessuna
autonomia auto-send che violi il "human-driven" (resta un umano che preme Invio/Send).
