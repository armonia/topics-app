## ADDED Requirements

### Requirement: BROWSER-03 — Superficie di apertura scelta dall'agent, promozione esplicita

Quando un agent apre un browser, il sistema SHALL distinguere due **superfici**:
`inline` (contesto di lavoro dell'agent, nessuna pane) e `pane` (superficie per
l'umano). Il tool `open_browser_pane` SHALL accettare l'argomento
`surface: "inline" | "pane"` con default `"inline"`, e la sua descrizione SHALL dire
che `"pane"` va usato solo quando l'URL serve all'umano (login/OAuth, dev server,
anteprima da revisionare, pagina promessa all'utente).

Un'apertura `inline` SHALL creare o riusare un contesto browser con id
`agent-<topic8>-<seq>`, navigarlo lato server (contesto headless), e restituire
`{url, title, contextId}`. NON SHALL emettere il broadcast di apertura pane, NON SHALL
montare alcuna pane, e il contesto NON SHALL mai entrare in `pane-store-v2` (nessun
`OPEN_PANE`, nessun tombstone, nessun LWW di pane). Tutti i tool `browser_*` SHALL
poter guidare un contesto inline passandone il `contextId`, senza nuovi tool, e
`browser_list_tabs` SHALL elencarlo con un'etichetta che ne dichiara la natura di
contesto d'agent.

La promozione a pane vera SHALL essere un atto **esplicito**: dall'agent, chiamando
`browser_focus_tab` sul contesto inline (oppure aprendo direttamente con
`surface:"pane"`); dall'umano, con un click sulla card in chat o sulla riga in
sidebar. Il sistema NON SHALL promuovere per euristica (né sull'URL, né sul contenuto
della pagina). Dopo la promozione l'identità SHALL restare la stessa (`contextId`
invariato), così i comandi successivi dell'agent guidano la pane visibile.

Un contesto inline inattivo (turno finito e nessuna attività per la finestra di idle
configurata) SHALL essere **sospeso**: il motore viene distrutto e restano URL,
titolo, log dei passi e ultimo fotogramma. Riprenderlo SHALL ricaricare dall'URL. Il
numero di contesti inline **vivi** per topic SHALL avere un tetto: superato il tetto,
il contesto meno recente SHALL essere sospeso, non distrutto.

Il testo del risultato del tool SHALL restare compatto (URL finale e titolo): log,
passi e fotogramma SHALL vivere nello stato del client, non nel contesto del modello.

#### Scenario: apertura per uso interno dell'agent
- **GIVEN** una chat con un agent e nessuna pane browser aperta
- **WHEN** l'agent chiama `open_browser_pane` con un URL e senza `surface`
- **THEN** il contesto `agent-…` viene creato e navigato lato server, il layout dell'utente resta invariato (nessuna pane compare) e il tool restituisce URL e titolo finali

#### Scenario: apertura destinata all'umano
- **GIVEN** un agent che deve far completare un login all'utente
- **WHEN** chiama `open_browser_pane` con `surface:"pane"`
- **THEN** si apre una pane vera accanto alla chat, come oggi

#### Scenario: promozione a metà lavoro
- **GIVEN** un contesto inline vivo su cui l'agent ha già navigato
- **WHEN** l'agent chiama `browser_focus_tab` su quel `contextId`
- **THEN** una pane vera si apre sulla pagina corrente con lo stesso `contextId`, e i comandi successivi dell'agent agiscono su quella pane

#### Scenario: sospensione e ripresa
- **GIVEN** un contesto inline rimasto inattivo oltre la finestra di idle
- **WHEN** il sistema lo sospende
- **THEN** il motore è distrutto e non restano processi browser attivi per quel contesto
- **AND** quando l'umano o l'agent lo riprende, la pagina viene ricaricata dall'URL conservato

#### Scenario: il contesto inline non tocca il layout globale
- **GIVEN** un topic con contesti inline vivi e sospesi
- **WHEN** il client ricarica o un altro dispositivo si sincronizza
- **THEN** nessuna pane appare o scompare nel layout di progetto per effetto di quei contesti
