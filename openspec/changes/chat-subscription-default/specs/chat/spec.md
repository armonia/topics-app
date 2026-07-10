## ADDED Requirements

### Requirement: CHAT-DEF-01 — La chat funziona senza toggle di Settings

Il sistema SHALL rendere la chat strutturata utilizzabile out-of-the-box: creare una nuova
chat e inviare un messaggio SHALL funzionare senza che l'utente attivi alcun toggle in
Settings, quando è disponibile almeno un provider chat `ready`.

#### Scenario: nuovo topic invia e riceve con provider subscription pronto
- **GIVEN** `claude-code` è `ready` e `claude` (SDK) non ha una API key usabile
- **WHEN** l'utente crea un nuovo topic e invia un messaggio senza scegliere un provider
- **THEN** il messaggio viene dispatchato a `claude-code` (non a `claude`)
- **AND** l'utente riceve una risposta assistita (nessun "No response received")

#### Scenario: le entry-point di creazione chat sono visibili di default
- **GIVEN** un'installazione con impostazioni di default
- **WHEN** l'utente apre l'app
- **THEN** le affordance di nuova chat (sidebar +, ⌘⇧N, command palette) sono disponibili
- **AND** non è necessario abilitare `enableNewChat` in Settings

### Requirement: CHAT-DEF-02 — Default provider onesto e subscription-first

Il sistema SHALL NON considerare connesso/usabile un provider `claude` (SDK) privo di API
key, e SHALL preferire come default automatico il path coperto da subscription
(`claude-code`, poi `codex`) rispetto ai path metered (`claude`, `openai`) quando il default
corrente non è connesso. L'override esplicito (`AI_PROVIDER`) e la scelta per-topic SHALL
avere sempre la precedenza.

#### Scenario: claude senza key non è il default
- **GIVEN** `claude` è registrato ma senza API key usabile, e `claude-code` è connesso
- **WHEN** il registro ricalcola il default
- **THEN** `claude` non è riportato connesso
- **AND** il default risolto è `claude-code`

#### Scenario: override esplicito rispettato
- **GIVEN** `AI_PROVIDER=claude` o un topic con `provider` esplicito
- **WHEN** si risolve il provider
- **THEN** viene usato il provider richiesto, non il default subscription-first

### Requirement: CHAT-DEF-03 — Lista modelli aggiornata nel picker

Il sistema SHALL esporre per `claude-code` la lista dei modelli correnti supportati dalla
CLI installata, con il modello configurato in testa (così `models[0]` resta il default
effettivo). Il ProviderModelPicker SHALL mostrare questi modelli come selezionabili.

#### Scenario: il picker mostra modelli correnti
- **GIVEN** il provider `claude-code` è `ready`
- **WHEN** l'utente apre il ProviderModelPicker
- **THEN** vede i modelli correnti (Opus 4.8 / Sonnet / Haiku / Fable 5), non versioni datate
- **AND** selezionandone uno, i turni successivi usano quel modello

### Requirement: CHAT-DEF-04 — Controlli del composer sensati e cablati

Ogni controllo interattivo del composer chat SHALL essere cablato a un handler funzionante,
avere label/tooltip sensati, e riflettere lo stato reale. Le slash-command e la voce
`/model` SHALL riferirsi a funzionalità e modelli realmente disponibili.

#### Scenario: i pulsanti del composer rispondono
- **GIVEN** un topic chat aperto
- **WHEN** l'utente usa attach, plan mode, fast mode, context ring, provider/model picker,
  mic, overflow (slash-command + voice) e il pulsante unificato send/queue/stop
- **THEN** ciascuno esegue la sua azione senza errori
- **AND** nessuna slash-command punta a una feature rimossa
