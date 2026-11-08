# hub-bridge Specification

## Purpose
Topics shows the usage hub (:3360) and switchboard (:3335) without copying their APIs: a proxy for requests and one server-side reader that pushes the live data on the Topics WebSocket. Plan: `~/.claude/jarvis/docs/hub-in-topics.md`, track 0.

## Requirements
### Requirement: HUBBR-01 — Proxy to the hub and to switchboard

The server SHALL forward `/api/hub/<rest>` to `<hub>/api/<rest>` and `/api/switchboard/<rest>` to `<switchboard>/api/<rest>`, query string included, forwarding only `content-type`, `accept` and `last-event-id`.

#### Scenario: A request reaches the configured host only
- **GIVEN** a path whose rest contains `%`, `//`, a leading `/` or a dot segment
- **WHEN** it reaches the bridge
- **THEN** the bridge SHALL answer 400 without any upstream request

#### Scenario: A failure never reads as data
- **GIVEN** the hub is down, slow past the headers timeout, or answers a redirect
- **WHEN** a panel asks through the bridge
- **THEN** the answer SHALL be 502 (down, redirect) or 504 (timeout) with the reason, never an empty 200

#### Scenario: No real hub under e2e
- **GIVEN** `TOPICS_E2E=1` and no `TOPICS_HUB_URL`
- **WHEN** a request reaches the bridge
- **THEN** it SHALL answer 503 and never call :3360

### Requirement: HUBBR-02 — Live hub data on the WebSocket

The server SHALL read `/api/pace`, `/api/mac`, `/api/services`, `/api/attesa`, `/api/alerts`, `/api/gates`, `/api/automations/summary` and `/api/live` (topics `pace`, `mac`, `services`, `attesa`, `alerts`, `gates`, `automations`, `projects`; of `/api/live` only the fields the project row reads: name, title, folder, state, why, until, cap, priority, share of the week) from the hub while at least one window is connected, and broadcast a `hub:live` frame per topic only when its answer changed, or once when the topic stops being readable. A write the hub accepts through the bridge SHALL trigger a fresh read, so the change reaches every window without waiting for the next tick.

#### Scenario: Unchanged data costs no frame
- **GIVEN** a tick already pushed the three topics
- **WHEN** the next tick reads the same answers
- **THEN** no frame SHALL be sent

#### Scenario: A write is visible at once
- **GIVEN** a "waiting for you" item closed with `POST /api/hub/attesa` and the hub answered 2xx
- **WHEN** the bridge returns
- **THEN** the reader SHALL read again after any read already in flight, push the list without the item, and the bridge SHALL answer only after that read (bounded), so a `GET /api/hub-live` right after already holds the new list

#### Scenario: A window opening after the hub came back
- **GIVEN** the last read of a topic failed
- **WHEN** a window asks `GET /api/hub-live`
- **THEN** the server SHALL read the hub again before answering, instead of serving the error until the next tick

#### Scenario: Hub down drops the old numbers
- **GIVEN** the hub stops answering
- **WHEN** the next tick runs
- **THEN** one `hub:live` frame with `error` and no `data` SHALL be sent per topic, and `GET /api/hub-live` SHALL report the error instead of the last numbers

### Requirement: HUBBR-03 — Live hub data in the client

The client SHALL keep the latest `hub:live` reading per topic, seed it from `GET /api/hub-live` on the first subscription, on every socket re-open and after a write of its own, and never let an older reading replace a newer one. Its readers of the hub's topics (waiting items, alerts, red gates, automations, services, quotas) SHALL drop what they do not recognise instead of throwing, and SHALL accept only http(s), `claude://` and the hub's own `#page` links, the last only where the window runs on the hub's machine.

#### Scenario: Seed after a frame
- **GIVEN** a frame at time 20 was adopted
- **WHEN** a seed reading at time 10 arrives
- **THEN** the store SHALL keep the reading at time 20

#### Scenario: A push missed while disconnected
- **GIVEN** the list changed while this window's socket was closed
- **WHEN** the socket opens again
- **THEN** the store SHALL read the snapshot again and hold the new list

### Requirement: HUBBR-04 — Without the hub, no trace

The client SHALL show nothing of the hub where the hub is absent or down: no status strip in the sidebar or above the phone's bottom row, no «Sistema» entry in the command palette, and no error in the console. The small System pane and the status strip are retired (HUBBR-05 is withdrawn): what they showed moves to the places listed in `openspec/changes/hub-smistamento/proposal.md`. A System pane (`__system__`) saved by an older version SHALL be dropped when the pane store loads, with every group reference to it.

#### Scenario: Hub down after it answered
- **GIVEN** the bell open with the hub's groups listed
- **WHEN** the hub stops answering
- **THEN** the hub's groups SHALL go, the band with «Riprova» SHALL show, and «Riprova» with the hub back SHALL bring the groups back

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the app opens on the desktop and on a 390px phone
- **THEN** no strip SHALL render, the palette SHALL have no «Sistema» entry, and the console SHALL hold no error

#### Scenario: Hub down after it answered
- **GIVEN** the hub answered once and then stopped
- **WHEN** the app is reloaded
- **THEN** the sidebar SHALL be the same as without the hub, and the console SHALL hold no error

#### Scenario: A saved System pane
- **GIVEN** a pane snapshot holding `__system__` in a split cell beside a chat
- **WHEN** the pane store hydrates it
- **THEN** only the chat SHALL remain, and no group SHALL reference `__system__`

### Requirement: HUBBR-06 — The bell in groups, in one order

The bell («Da guardare» > Ora) SHALL list, in this order: «Decidi tu» (the waits of Topics and the hub's «waiting for you» items together), «Si è rotto» (failed automations, services with a problem or stopped), «Quote e account» (a window at 90% or more, the pace alerts, account switched, limit reached, token expired on the Claude proxy in the last 24 hours), «Da guardare» (projects over their budget, contradictions of the agents' rules), «Finite». A group with no row SHALL not render. In «Decidi tu» the items with a deadline SHALL come first, nearest first, then the longest wait, every one of them in view; a group of the hub's warnings («Si è rotto», «Quote e account», «Da guardare») shows five rows and «Altre N». A service switched off on purpose or waiting on demand SHALL not enter. Where the hub is part of the installation the pill of the button SHALL say the figure of one group of the panel, never a sum the panel does not show: amber with the number of «Decidi tu» when something waits for the person, else the blue of the finished subjects, else grey with the hub's warnings; the Dock, the tray and the PWA badge keep ATTN-08. The rows SHALL write the time as the person reads it («adesso», «4 min», «21:26», «ieri»), and the foot of the panel SHALL say who is at work and whether the hub answers. Without the hub the bell SHALL be the Topics inbox, and the client SHALL ask nothing of `/api/hub/` or `/api/switchboard/`. With the hub read once in the window and silent now, the panel SHALL list Topics alone under a band «Hub non raggiungibile: vedi solo Topics» with «Riprova», and the foot SHALL say since when («hub fermo da 4 min»). With nothing in any group the panel SHALL say «Niente aspetta te, niente di rotto.» (only «Niente aspetta te.» when the hub does not answer) with a link to the History tab. The rows SHALL carry the mockup's actions where an answer exists: a chat's permission «Consenti» and «Nega» (the same decision as its panel in the chat), a hub item «Apri» and «Fatto», a failed automation «Risolvi tu», a stopped service «Apri in Processi» (it closes the bell and opens the machine's Processes), an expired token of the Claude proxy «Rinnova».

#### Scenario: Decide first
- **GIVEN** a hub with a «waiting for you» item due today, a failed automation, a stopped service, a full week, an account switch, a project over budget and a finished chat
- **WHEN** the bell opens
- **THEN** the groups SHALL be Decidi tu, Si è rotto, Quote e account, Da guardare, Finite, with the hub's item at the top of Decidi tu

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the bell opens
- **THEN** only the groups of Topics SHALL render and no request SHALL go to the hub's routes

### Requirement: HUBBR-07 — History with the filtered diary

The bell's History tab SHALL merge seven days of the hub's diary into the Topics log by time, with a filter «Tutto», «Topics», «Automazioni e agenti» and a search over title, detail and who. The diary SHALL bring failed runs, the agents' work («Risolvi tu» included), workflows, the person's own actions and the lines other writers note (the Mac's brake, budgets, subscriptions), and SHALL leave out the runs of automations that went well or were skipped: those stay on the automation's card. Each line SHALL say its state in words (hover and screen reader), unfold its whole text, and open its automation in Automazioni when it is about one.

#### Scenario: Routine runs stay out
- **GIVEN** a diary with a successful backup, a skipped brief and a failed reindex
- **WHEN** History opens
- **THEN** only the failed reindex SHALL be listed among the automation runs

### Requirement: HUBBR-08 — The machine's Processes

Where the hub is part of the installation, Sistema in the Topics menu and the command palette SHALL open «Processi», a view of the whole machine that takes the place of «Questo computer» (what that level said about this window, open tabs, archived and the health list, moves under Prestazioni). The view SHALL show the Mac (CPU, memory, swap, GPU and network of the machine, then the processes by memory with memory, GPU and network for each, and the CPU of the processes the hub measures), the PC (asleep, on or working, with the hub's reasons, its measures and its heavy programs), the hub's services (state, memory, port; the stopped ones first, the ones switched off on purpose counted, not listed) and the Claude proxy's log. A number the hub did not measure SHALL be a dash, never 0. The only command SHALL be «Ferma» on a running project script started by Topics, with the project's name and the script's port; no row of an app, a service, a session or the system SHALL carry a stop or a restart. Without the hub the row and the palette entry SHALL not exist.

#### Scenario: GPU and network per process
- **GIVEN** a hub whose census measures GPU and network for some processes and not for one
- **WHEN** «Processi» opens
- **THEN** each measured row SHALL show its GPU and its network, the other SHALL show a dash, and only the row of the running project script SHALL carry «Ferma»

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** Sistema and the palette open
- **THEN** neither SHALL offer «Processi»

### Requirement: HUBBR-09 — The proxy's log, live, closed with the view

The log section of «Processi» SHALL read the Claude proxy's log stream through the Topics proxy while the view is open and the log is open, newest line first, with «Tutto», «Solo errori» and a pause. Closing the log from the proxy's row, or closing the view, SHALL close the stream.

#### Scenario: Closed with the view
- **GIVEN** «Processi» open with the log reading the stream
- **WHEN** the view's tab is closed
- **THEN** the proxy SHALL see the stream end


### Requirement: HUBBR-10 — Accounts and quotas, with commands only on the proxy's accounts

Where the hub is part of the installation, the menu with your name SHALL carry, under the plan, a row «Account e quote» whose tail says the hottest quota of a plan in use from 80% (amber) and how many accounts the view lists (the proxy's Claude accounts plus Codex and Muse), the same number as the view's header; the card with your name SHALL show the same hottest quota from 80% and nothing below it. The row and the palette SHALL open «Account e quote», a view that SHALL show: at the top, under «Decidi tu», the Claude account in use when a window is at 80% or more, with the board's 90% line, the reset, «Passa a» the next ready account and the stop of the background work; the command that stops the new background work for some hours (and resumes it); the Claude accounts of the proxy, the one in use first, then by priority, the switched-off ones last, each with its five hours and week bars, its cap marker and its state (in uso, pronto, spento, tetto raggiunto, esaurito, token scaduto), with the proxy's commands: «Usa questo», priority up and down, the account's own caps, «Aggiorna token», on and off, «Togli l'account» after a confirmation; Codex and Muse with their bars read-only, no account command, and «Sblocca il freno per 2 ore» (or «Rimetti il freno» while unlocked); the reserve Anthropic API keys in the order the proxy uses them, with priority up and down and on and off; «Come funziona il freno», per class of work the providers in order and the current pick, and each provider's quota used against the week gone; the hub's own Italian reasons SHALL be shown only in Italian, with comma decimals. With the hub silent the bars SHALL keep their last reading under a band that says since when. Without the hub the row, the palette entry and the card's quota SHALL not exist.

#### Scenario: Commands only on Claude
- **GIVEN** a hub with Claude accounts on the proxy, Codex and Muse metered
- **WHEN** «Account e quote» opens
- **THEN** each Claude card SHALL carry the proxy's commands, the Codex and Muse cards SHALL carry only «Sblocca il freno per 2 ore», and «Usa questo» SHALL reach the proxy as a switch to that account

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the menu with your name and the palette open
- **THEN** neither SHALL offer «Account e quote», and the card SHALL show no quota

### Requirement: HUBBR-11 — Rotation and caps write the proxy's settings and read them back

The section «Rotazione e tetti» of «Account e quote» SHALL show the Claude proxy's settings (proxy on, automatic switch, rotation strategy with its interval or parallel requests where the strategy has one, the five hours and week caps of every account, the wait when all are stopped, requests in line, dollar to euro) and every change SHALL be written to the proxy and then read back from it: the value on screen is the one the proxy answers. The Notifications level of the user menu SHALL carry «Avvisi del proxy degli account», the proxy's own notifications setting, written and read back the same way, only where the hub is and the proxy answers.

#### Scenario: A cap written and read back
- **GIVEN** «Account e quote» open with the proxy's week cap off
- **WHEN** the week cap of every account is set to 90%
- **THEN** the proxy SHALL receive the cap, and the row SHALL show 90% as read again from the proxy

### Requirement: HUBBR-12 — Consumi in the Dashboard: hub sections only with the hub, amounts in euro, savings only for Claude

The menu with your name SHALL carry a row «Consumi» that opens the Dashboard; where the hub is part of the installation its tail SHALL say today's Claude tokens and their list price in euro. «Consumo per progetto» SHALL leave the System level and live in the Dashboard. Where the hub is, the Dashboard SHALL be «Consumi» and show, for the window chosen among Oggi, Settimana and 30 g: at the top, under «Decidi tu», a project past the week cap you set, with «Alza a N%» written to the hub and read back; the Claude tokens of the window, their cost at the API list price, what the plans cost for the window, the saving against the list price and the jobs given to Muse; the tokens per model over time; per model, per account (Claude from the proxy with five hours and week, Codex and Muse read-only from the hub) and per project (Claude, Codex and Muse as a share of the week, with your cap as a marker); the saving against the list price, for Claude only, and what Muse took off Claude; the board's work in one compact box. Every amount SHALL be in euro with the proxy's dollar to euro rate. The proxy's rows SHALL be summed by the Topics server (`GET /api/hub-usage`), never sent whole to a window, and a window the proxy's history does not cover SHALL say from when the data starts. Without the hub the Dashboard SHALL be the board's numbers as before, with «Consumo per progetto», and no hub section, no error.

#### Scenario: Consumi with the hub
- **GIVEN** a hub with a project past its cap and the proxy's rows of the week
- **WHEN** «Consumi» opens from the menu with your name
- **THEN** the Dashboard SHALL show «Decidi tu» with that project, the five numbers in euro, per model, per account and per project, and the saving for Claude only; «Alza a N%» SHALL reach the hub as the project's new cap

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** «Consumi» opens
- **THEN** the Dashboard SHALL show the board's numbers and «Consumo per progetto», and no hub section

### Requirement: HUBBR-13 — Agenti e lavori: coda e workflow nei filtri, niente card della Board duplicate, titolo mai il prompt grezzo

The System level of the menu with your name SHALL carry, below «Prestazioni», a level «Agenti e lavori» that takes the list of who is working out of «Prestazioni», with three filters, In corso, In attesa and Finiti, each with the number of its rows. In corso SHALL list the sessions of Topics at work (the same rows the card's badge counts), and where the hub is part of the installation also the Claude proxy's sessions running outside Topics, the hub's queued jobs running and the workflows running, a running workflow with the phase it is in and a bar of its phases (from the hub's `/api/automations`). In attesa SHALL list first, under «Decidi tu» and oldest first, the Topics sessions waiting on you with their question and how long they have waited and a command that opens them, and the workflows stopped at an approval gate with what the gate waits for and the way to the hub's automations, then the jobs in the hub's line in the hub's order (numbered, the same job in a row folded as ×N, each with a command that takes it out of the line through the hub's `DELETE /api/queue?id=`), then the jobs a quota holds with the time they restart. Finiti SHALL list what failed on top, then today and yesterday. A job of the queue born from a card of the Board (its `ref` a card, a night job, or a text that names a card by its id) SHALL NOT be listed: the footer says the night's cards stay on the Board and leads to the hub's automations. A title SHALL NEVER be the raw prompt: a delegated job's title is the first readable Italian sentence that says the work (past where to work, who the agent is and the rules), without paths, commands, parentheses or hashes and never two sentences glued, at most 64 characters, and otherwise «Lavoro delegato» with its project; a workflow's detail is its phase, its agents and its minutes, never the summary prose of its run; a proxy session is one row (a session at work is never also among the finished) told apart without its prompts: «Jarvis su <canale>» for a Jarvis turn, «Agente di un workflow» for a workflow's agent, otherwise «Sessione Claude fuori da Topics», with its model and the project its repository or its commands name, and the ended ones that read the same folded as ×N; a job in line SHALL say what it waits on (the hub's reason, a free Mac, the job before it, or the next round). The level SHALL open on In attesa when something waits on you, otherwise on In corso; the row in System SHALL say how many wait on you, the workflows at a gate included, read from the hub when System opens and whenever the hub's count of what needs you changes, and zero when the hub does not answer. With the hub silent the level SHALL say since when and from what time its data is, keep the hub's last answer and offer a retry that reads again; on the phone the level SHALL be the one sheet in sight, with a way back to System and a close; without the hub it SHALL list Topics alone and nothing of the hub, no error.

#### Scenario: Queue and workflows in the filters
- **GIVEN** a hub with a job running, two jobs in line (one of them twice), one held by a quota, a job born from a card, a workflow running and one failed, and a proxy session outside Topics
- **WHEN** «Agenti e lavori» opens
- **THEN** In corso SHALL list the proxy session, the running job and the running workflow, In attesa the line numbered with the twin folded as ×2 and the held job with its restart time, Finiti the failed workflow on top, and no filter SHALL list the card's job or any raw prompt

#### Scenario: A job taken out of the line
- **GIVEN** «Agenti e lavori» open on In attesa
- **WHEN** a job of the line is taken out
- **THEN** the hub SHALL receive `DELETE /api/queue?id=` with its id and the row SHALL leave the list

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** «Agenti e lavori» opens
- **THEN** it SHALL list the sessions of Topics alone, with no hub section and no error

#### Scenario: Hub silent
- **GIVEN** «Agenti e lavori» open with the hub's list read once
- **WHEN** the hub stops answering for the queue and the diary
- **THEN** a band SHALL say «Hub fermo da N min · dati delle HH:MM» with «Riprova», the list read before SHALL stay, and after the hub answers again «Riprova» SHALL take the band away

### Requirement: HUBBR-14 — Automazioni sopra la Board, vista intera senza pannello Cron, comandi solo sui job di Jarvis

Where the hub is part of the installation, the sidebar SHALL carry a row «Automazioni» above the Board whose tail says «N da sistemare», N being the hub's automations broken plus the ones waiting on you (`needsYou + broken` of `/api/automations/summary`, never the ones in order), and nothing when N is zero; once read, a hub that stops answering leaves the row saying «hub fermo». The row and the command palette SHALL open «Automazioni», a whole view that takes the place of the Cron panel, which SHALL no longer exist (no Cron pane type, no «+» entry; a link to the old panel opens Automazioni). The view SHALL show the verdict (how many to fix, then to decide, broken, in order out of the total, today's runs and the next run), the tabs Automazioni and Calendario, a search, and chips for each system with its count and what needs fixing: Jarvis (the `jarvis-channels` jobs and their health findings), Mac (launchd and the desktop app), GitHub, PC, Workflow. «Decidi tu» SHALL list what is broken or waits on you, oldest first, each with «Risolvi tu» and, on a Jarvis job, «Riprova». Each system SHALL list its rows with when, the last 24 hours one cell per hour, the last run with its exit, the vote, and the commands: only the Jarvis jobs `jarvis-channels` lists carry «Esegui ora», on and off and «Elimina» (after a confirmation), through Topics' `/api/cron/jobs` routes; a job switched off, which the hub leaves out, SHALL be listed so it can be switched back on; launchd, GitHub, PC and workflow rows SHALL be read-only. A gateway that does not answer SHALL turn the commands off and say so; a refused command SHALL show its reason in Italian. A system all in order SHALL fold under «Le altre aree». The Calendario tab SHALL list the hub's dated reminders and jobs by day, never their prompt in the row: the agent's instructions are drawn only behind a closed fold the person opens. A row SHALL open its detail beside the list, or as a sheet on the phone. Without the hub the row and the palette entry SHALL not exist.

#### Scenario: Automazioni with the hub and the gateway
- **GIVEN** a hub with two broken automations and one waiting on you, Jarvis jobs listed by `jarvis-channels` (one of them switched off), and launchd and GitHub jobs
- **WHEN** the row above the Board opens «Automazioni»
- **THEN** the row SHALL say «3 da sistemare», «Decidi tu» SHALL list the three oldest first, the Jarvis rows SHALL carry the three commands, the switched-off job SHALL be listed off, the Mac and GitHub rows SHALL be read-only, and no Cron panel SHALL be offered

#### Scenario: A command on a Jarvis job
- **GIVEN** «Automazioni» open on a Jarvis job
- **WHEN** it is run, switched off and deleted after the confirmation
- **THEN** Topics SHALL receive `POST /api/cron/jobs/<id>/run`, `PATCH` with `enabled: false` and `DELETE`, and the row SHALL say it ran

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the sidebar and the palette open
- **THEN** neither SHALL offer «Automazioni»

### Requirement: HUBBR-15 — Votes and «Risolvi tu» write the hub's feedback and are read back

The detail of an automation SHALL carry your vote with «Va bene», «Da cambiare» (with a note), «Nota», «Segnala» (with a note) and «Non avvisarmi più» (for 7 days, 30 days or for good, with a why), each written to the hub's `POST /api/feedback` in the hub's row shape (`vote` ok or cambia, `note`, `complaint`, `mute`), the job's fingerprint included, and SHALL then show the vote, the notes and the silence as the hub's model reads them back: a vote that did not land does not look given. A text the hub requires SHALL be asked before writing. On what is broken or waits on you, «Risolvi tu» SHALL send `POST /api/fix` with the job's key and say that an agent has it and where the outcome lands, or that an agent is on it already when the hub's queue has one. The detail SHALL list the job's runs (a Jarvis job's from the hub's `automations/runs`, a workflow's with its cost read only when asked from `automations/run/<id>`).

#### Scenario: A vote and a note read back
- **GIVEN** the detail of a broken Jarvis job with no vote
- **WHEN** «Va bene» is pressed and a note is written
- **THEN** the hub SHALL receive a `vote` with `v: ok` and a `note` with the text for that key, and the detail SHALL show «Va bene» pressed and the note, as read again from the hub

#### Scenario: Risolvi tu
- **GIVEN** the detail of a broken automation
- **WHEN** «Risolvi tu» is pressed
- **THEN** the hub SHALL receive `fix` with its key and the detail SHALL say an agent has it

### Requirement: HUBBR-16 — The project row with the hub's data only for a project it recognises, priority and budget written and read back

Where the hub is part of the installation, a project's sidebar row SHALL carry what the hub's `/api/live` (topic `projects`) says of that project, and only from the hub project that bears the name of its folder, which is the name the hub gives a project by default (a worktree counts as its repo). The hub's budget groups and aliases can give a folder another name (a `jarvis-voice` folder counted as `jarvis`, `acme-*` folders as `acme`): such a project SHALL show nothing of the hub rather than a guess, until the hub publishes its folder-to-name mapping. The hub's `dir` SHALL NOT be used to match: it is the folder of whichever agent the hub saw last (a board worktree, a sibling repo, a cross-project session), so it moves between reads and can point at another project's folder. The hub's grouped temporary folders (`tmp:`) never match. The budget is a share of the Claude week alone (Codex and Muse count in other units and are not summed in), so the row SHALL show an amber dot when the project's Claude share reaches the budget you set (`claude >= budgetPct`, where the hub's brake fires), a pause when the hub's brake holds the project (`frenato`) and a clock when its jobs wait in the hub's line (`in coda`), each with the reason, and the time the brake lets go when the hub gives one, as its tooltip; on hover the share of the week (the Claude share where a budget is set, «30% della settimana Claude», the whole week otherwise, «38% della settimana») SHALL take the place of the quiet signals, clear of the command rail, with the project's name whole where it fits and, on a narrow row, the hint's words giving way before the name does, whole or not at all (the number stays, never a half word). The project's menu SHALL say the Claude share against the budget («25% della settimana Claude su 25% di budget») and the state with its reason, without the project's own name the hub puts in front of it, and a budget brake as «Fermo per il budget» rather than repeating the budget line's numbers; and carry «Priorità» (Alta, Normale, Bassa) and «Budget della settimana» (Nessuno, 5%, 10%, 15%, 20%, 30% as the tray offers them, and the budget in force if it is none of these, with a line saying what a budget does), each choice written with `POST /api/hub/project-settings` (`{name, priority}` or `{name, budgetPct}`, `null` for none) and shown as the hub reads it back, so a refused write shows its reason and leaves the old choice. As the hub's own Progetti page did, live agents SHALL come before the brake (it holds new jobs, not running ones): a project with agents at work outside Topics SHALL carry a robot glyph with their count instead of the pause (Topics' own chats keep the row's loader), and a priority other than Normale SHALL show as an arrow on the row. A non-budget brake SHALL be said in the hub's short words (`brake`), never the raw gate text, and the time the brake lets go SHALL carry its day when it is not today («riparte gio alle 13:00»). The menu SHALL also carry what the project is (the hub's `what`), the share of the week per provider on bars (Claude with the budget's tick, Codex, Muse, only those that spent), the live agents folded under a line with their count, model mix and tokens of the last hour, unfolded each with provider, model, kind, since when, last activity, tokens and share of the week, title, sub-agents one step in and «Apri» where the hub knows a way in (a Topics chat opens as a tab, the desktop app's link outside), the hub's Opus advice («valuta Sonnet») when Opus runs on a project past a tenth of the Claude week or for two hours, and, for a project nobody works on, since when and who was last («Nessun agente da 3 g, l'ultimo il 3 nov (Codex)»), with «La cartella era temporanea e non esiste più» when it is gone. The bridge SHALL coarsen the agents' moving numbers (times to the minute, tokens to two digits) so the projects frame changes about once a minute, not on every read.

A project the hub does not recognise, a hub never read and a hub that stopped answering SHALL leave the row and the menu as Topics alone draws them.

#### Scenario: Agents before the brake, the menu's facts
- **GIVEN** a hub whose `acme-shop` is held by the quotas while one agent outside Topics works there, and whose `acme-web` has three agents, Opus among them, at 30% of the Claude week
- **WHEN** the sidebar draws them and the menu of each opens
- **THEN** `acme-shop` SHALL carry the agent's glyph with «1» and no pause, its menu «Fermo: Muse sopra ritmo · Codex esaurito» with the restart time; `acme-web`'s menu SHALL show Claude, Codex and Muse on bars, «3 agenti al lavoro» with the model mix and the pace, the three agents once unfolded, and the Opus advice

#### Scenario: A recognised project held by the brake
- **GIVEN** a hub whose `studio-x` is at 25% of the Claude week with a 25% budget and held by the brake, and whose `acme-web` is at 30% of the Claude week (38% with Codex and Muse) with a 40% budget
- **WHEN** the sidebar draws both projects and a third the hub does not know
- **THEN** `studio-x` SHALL carry the dot and the pause, «Fermo per il budget» with the day and time it lets go, `acme-web` neither, the third nothing of the hub, and hovering `acme-web` SHALL show «30%», with «della settimana Claude» only if it fits whole

#### Scenario: Codex and Muse do not count against the budget
- **GIVEN** a hub project at 10% of the Claude week and 30% of Codex, with a 25% budget
- **WHEN** the row is drawn
- **THEN** it SHALL carry no dot, as the hub does not brake it

#### Scenario: The hub's folder points at another project
- **GIVEN** a hub whose held row `misc-a` last saw an agent in the folder of the Topics project `notes-lab`, and whose `acme-web` last saw one in a board worktree
- **WHEN** the sidebar draws `notes-lab` and `acme-web`
- **THEN** `notes-lab` SHALL carry nothing of the hub and `acme-web` SHALL carry its own data

#### Scenario: Priority written and read back
- **GIVEN** the menu of `acme-web` at priority Normale
- **WHEN** «Alta» is chosen
- **THEN** the hub SHALL receive `{name: "acme-web", priority: "alta"}` and the menu SHALL show Alta as read again from the hub; against a hub that refuses the write the menu SHALL show the reason and keep Normale

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the sidebar and a project's menu open
- **THEN** neither SHALL carry anything of the hub

### Requirement: HUBBR-17 — Contesto degli agenti in System, the contradictions check only on confirmation

Where the hub is part of the installation, System SHALL carry «Contesto degli agenti» after «Agenti e lavori», a level whose row says the weight of Claude Code at start («15 k tok di base», from the hub's `/api/contesto`). The level SHALL show the weight per harness (Claude Code, Codex, jcode and any other the hub lists), the sessions opened in the home folder as Claude Code's extra and not as a harness of their own; the files read at start with who reads them and, on a tap, their text from `/api/context/text`; the list of skills; the sources read on demand folded; the lines repeated across files; the rules with an old date, oldest first; and the hub's last contradictions check with its time and, for each, why and the two rules with the label of their file. Files are named by the hub's labels, never by id or path. «Cerca contraddizioni» makes an agent work: it SHALL ask before it starts, send `POST /api/contesto/check` only after «Avvia il controllo», say that an agent is reading the rules while the hub says the check runs, and show what the agent found when it ends; a refused start SHALL show the hub's reason. A hub that stops answering SHALL keep the last answer on screen with a band and «Riprova». Without the hub the row SHALL not exist. The level comes in its own chunk.

#### Scenario: The context and a check on confirmation
- **GIVEN** a hub whose context weighs 14,888 tokens for Claude Code, with a memory index read only in the home sessions, an old rule and no contradiction found yet
- **WHEN** System > «Contesto degli agenti» opens, a file is tapped and «Cerca contraddizioni» is pressed, then cancelled, then pressed again and confirmed
- **THEN** the row SHALL say «15 k tok di base», the level SHALL list four harnesses with the home sessions under Claude Code, the file's text SHALL show, the hub SHALL receive no check before the confirmation and exactly one after it, and the contradiction the agent found SHALL show when the hub says the check is over

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** System opens
- **THEN** it SHALL offer neither «Contesto degli agenti» nor «Funzionalità»

### Requirement: HUBBR-18 — Funzionalità opened from System and the palette, never from the sidebar

Where the hub is part of the installation, System SHALL carry «Funzionalità» after «Processi», whose tail says how many features Jarvis is behind on, and the command palette SHALL carry «Funzionalità»; both SHALL open the view «Funzionalità», a singleton pane that neither the «+» nor a row of its own in the sidebar offers. The view SHALL read the hub's `/api/features` and show the verdict (where Jarvis is behind, out of how many features, how many systems are compared, Jarvis's share and place, the map's date), the ranking of the systems named without the repository in brackets, and the features area by area with Jarvis's share and place in each: by default only those where Jarvis is behind, or all of them, with a search. A feature SHALL open in place with how Jarvis does it, what was decided on it, every other system with its status (yes, in part, no, unknown), up to eight of the hub's news with how many more, and the evidence pages, the links opening outside; its row SHALL say when Jarvis is behind and what was decided. Above the comparison the view SHALL show the pyramid of what Jarvis needs, when the hub has one: a sentence with how many needed functions are covered, done today, moving to the single engine, missing and let go; its levels from the top down, each wider than the one above, with a bar in four colours and covered over needed; one level opened at a time with its description and its functions (outcome, where in the code, use over fourteen days); the legend and the pyramid's date. Then «Cosa manca: deciso» with one count per decision and the features still to build by priority. Under the ranking the view SHALL say how a share is counted and when the hub's watcher last looked for news. Beside «Dove è indietro» and «Tutte», the filters «Novità da rivedere», «Da fare» and «Scelte: non ora» SHALL each carry their count. An area SHALL say how many features it is behind on and who leads it with which share, and SHALL group its features under their groups with Jarvis's share in each. A hub that stops answering SHALL keep the last map with a band and «Riprova». Without the hub neither the row nor the palette entry SHALL exist. The view comes in its own chunk.

#### Scenario: The map from System and from the palette
- **GIVEN** a hub with 16 systems, 172 features and 47 where Jarvis is behind
- **WHEN** System opens, then «Funzionalità», then the palette's «Funzionalità»
- **THEN** the row SHALL say «47 indietro», the view SHALL say «47 dove Jarvis è indietro, su 172 voci», list only the features behind until «Tutte» is chosen, open a feature with who has it, and the palette SHALL bring back the same single view; no sidebar row of its own and no «+» entry SHALL offer it

#### Scenario: The pyramid, the decisions and a feature whole
- **GIVEN** a hub whose pyramid has seven levels with 15 of 17 needed functions covered, and whose map has two features still to build, 23 chosen not now and 43 with news
- **WHEN** «Funzionalità» opens, the base level is tapped, then a feature with ten news is opened under «Tutte»
- **THEN** the levels SHALL widen downwards and say covered over needed, the base SHALL list its functions with what moved first and their use over fourteen days, «Cosa manca: deciso» SHALL list the two to build by priority, the filters SHALL keep 43, 2 and 23 features, and the feature SHALL show the note, the decision, the fifteen others, eight news with «altre 2» and its evidence link

### Requirement: HUBBR-19 — The palette has one entry for every place of the hub

Where the hub is part of the installation, the command palette SHALL carry one entry for each place the hub's sections moved to, in this order: «Account e quote», «Consumi», «Processi», «Agenti e lavori», «Contesto degli agenti», «Funzionalità», «Log», «Automazioni». Each SHALL open its own place: the views through the utility bus (Account e quote, Consumi in the Dashboard, Processi, Funzionalità, Automazioni), the two levels of System in the user menu with System and the level already open («Agenti e lavori», «Contesto degli agenti»), and «Log» as Processi scrolled to its log section, opened. Without the hub none of the eight entries SHALL exist.

#### Scenario: Every entry opens its place
- **GIVEN** a hub that answers
- **WHEN** the palette opens and each of the eight entries is chosen in turn
- **THEN** each SHALL open its own place: the view, the System level with its rows, or Processi with its log in sight

#### Scenario: No hub
- **GIVEN** nobody answers on the hub's address
- **WHEN** the palette opens
- **THEN** none of the eight entries SHALL be offered

### Requirement: HUBBR-20 — The board's «Frenato» chip says who Topics holds and until when

The board's bar SHALL carry a «Frenato» chip beside the cap's gear while Topics keeps at least one card in Todo behind a provider's wall: Claude or Codex under a hold (a spent window, a plan limit, an API outage), or Claude's five-hour window at the dispatch line (`PLAN_DISPATCH_HOLD_AT`) or above with its reset still ahead. Which cards a wall holds is the dispatcher's own verdict, card by card (`taskPlanWait` behind the tick's gates), read from `GET /api/dispatch/brakes`: a wall that holds no card, because every card on Automatic found another runtime, SHALL NOT be named by the chip. The chip SHALL name the provider (or both), the window and its share when the plan reports it, and when the cards start again. Its popover SHALL list Claude and Codex, held or free: a held one with its reason and how many cards wait, a free one with its five-hour share where it is measured (Codex's from the hub) and how many cards it has at work; Muse with its cards at work where the hub has it; and where the cards' suites and builds run (on the PC while the hub says the Mac is under strain). It SHALL link to «Account e quote» where the hub answers. The Todo column SHALL open with a strip saying how many of its cards wait, for whom, and when they start again, and each held card SHALL say «Aspetta il freno · <provider>» in place of the queue's chip. The sidebar's Board row SHALL carry a «Frenato» tag while any card is held. The popover's lead SHALL say the cap stays where it is, with its number when the cap is a count. While Claude's brake is Topics' own early stop at the dispatch line, the popover SHALL offer «Togli il freno a Claude»: it lifts the early stop for the current five-hour window only, so the held cards start up to the window's own limit, and the next window brakes again on its own (a restart puts the margin back). A provider's wall (a spent window, a plan limit, an API outage) SHALL offer no such command, and the server SHALL refuse it. With nothing held the chip, the strip and the tag SHALL not exist; on the phone the chip is a full-width row under the bar. The hub's pace brake, which holds no card, is not this chip's.

#### Scenario: Claude past the line, then Codex at its limit with no card of its own
- **GIVEN** Claude's five-hour window at 94% with its reset at a known time, two Todo cards pinned to Claude on a board that dispatches, and no hold for Codex
- **WHEN** the board opens, and then Codex is held until a later time
- **THEN** the chip SHALL say «Frenato · Claude · quota 5h al 94%, riparte alle HH:MM», the Todo column SHALL say «2 aspettano il freno di Claude», both cards SHALL say «Aspetta il freno · Claude», the sidebar's Board row SHALL say «Frenato», and the popover SHALL show Claude held with the threshold and «2 card aspettano», Codex free with its share, Muse, and «Suite e build»; with Codex held but holding no card the chip SHALL still name Claude alone, and the popover SHALL say that Codex holds no card

#### Scenario: Lifting Topics' early stop
- **GIVEN** Claude's five-hour window at 94% with its reset ahead and two Todo cards held behind it, and the cap at 8
- **WHEN** the popover opens and «Togli il freno a Claude» is pressed
- **THEN** the lead SHALL say «Il tetto resta 8», and after the press the chip, the strip and the cards' lines SHALL be gone, the server SHALL hold no Claude card, and a second lift SHALL be refused

#### Scenario: Nothing held
- **GIVEN** no hold and Claude's window below the line
- **WHEN** the board opens
- **THEN** there SHALL be no «Frenato» chip, no strip in Todo and no tag on the sidebar's Board row
