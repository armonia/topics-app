## MODIFIED Requirements

### Requirement: AGCFG-01 — Anagrafica di Jarvis e Visione, come panoramica e pagina per agente

The Agents view SHALL open, where jarvis-channels is installed, on a panoramica with one card per always-on agent (Jarvis, Visione), each with its channel brand marks, chat count and context weight, a «Da sistemare» list and a «Nuovo agente» card. Opening a card SHALL go to that agent's own page, Attività by default; Configure SHALL open on a page of its own with one address per section and carry the channels' health (`jarvis-channels health`), the incoherences of its configuration, its personality (`IDENTITY.md`, its own `SOUL.md` additions) editable and saved explicitly, its model and accounts (tokens named by their Keychain entry, never shown), its chats — as a tree under their channel and server — with a switch for «Risponde» and one for «Solo se citato», and its scheduled jobs with a switch each. A switch SHALL write only that agent's rule (Visione's chat carries Visione's account). Without jarvis-channels the view SHALL stay the sessions list.

#### Scenario: Switches write to the right agent
- **GIVEN** Jarvis and Visione both with a rule for the same Discord chat
- **WHEN** Visione's «Solo se citato» is switched on, from her own Configure › Canali e chat, and Jarvis's morning brief switched off from his own Configure › Lavori a orario
- **THEN** `/api/agent-config/chat` SHALL receive Visione's account and `/api/agent-config/job` the job's id with `paused: true`, and the note SHALL say it is saved
