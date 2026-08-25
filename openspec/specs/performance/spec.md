## Purpose

Specifies performance and visual quality requirements for the Topics App, including layout stability (CLS), load times, and absence of visual artifacts like white flash during transitions.

## Background

Common preconditions shared across scenarios:
- The user is logged into Topics App at http://localhost:3333
- The main application layout is visible with a sidebar on the left and a content area on the right
- At least one topic exists with messages

## Requirements

### Requirement: PERF-01 — Layout Stability & Visual Quality

The system SHALL maintain visual stability during all user interactions, with Cumulative Layout Shift (CLS) below 0.1, and SHALL prevent white flash artifacts during page load and topic transitions.

#### Scenario: Topic switch has no visible layout shift
- **GIVEN** a topic is selected
- **WHEN** user clicks another topic
- **THEN** Cumulative Layout Shift (CLS) is less than 0.1
- **AND** no white flash occurs during transition

#### Scenario: Initial page load has no white flash
- **GIVEN** the app loads for the first time
- **WHEN** the page renders
- **THEN** no background color change from white to dark is visible (dark background applied before first paint)

#### Scenario: Sidebar toggle does not cause content shift
- **GIVEN** the sidebar is visible
- **WHEN** user toggles sidebar
- **THEN** main content resizes smoothly without jumping

#### Scenario: Panel split does not cause layout shift
- **GIVEN** a single panel view
- **WHEN** user splits right/down
- **THEN** no visible content jump occurs during split animation

#### Scenario: UI is visually stable after topic switch
- **GIVEN** a topic is loaded
- **WHEN** 2 seconds pass after the switch
- **THEN** less than 2% of pixels change between screenshots
- **AND** no text content flickers or changes

#### Scenario: No DOM thrashing during initial load
- **GIVEN** the app has finished loading (networkidle)
- **WHEN** 3 seconds pass
- **THEN** fewer than 50 DOM mutations occur
- **AND** no "Connecting" or loading text appears and disappears repeatedly

#### Scenario: UI is visually stable after sidebar toggle
- **GIVEN** the sidebar has been toggled
- **WHEN** 2 seconds pass
- **THEN** less than 2% of pixels change between screenshots

#### Scenario: Chat message list does not shift on new message
- **GIVEN** user is reading messages at bottom
- **WHEN** a new message arrives
- **THEN** existing messages do not shift position

### Requirement: PERF-02 — Load Performance

The system SHALL load within acceptable time thresholds and SHALL NOT block the main thread with long tasks during normal user interaction.

#### Scenario: App loads within 3 seconds
- **GIVEN** a fresh page load
- **WHEN** navigation completes
- **THEN** DOMContentLoaded fires within 3000ms

#### Scenario: Topic switch completes within 500ms
- **GIVEN** a topic exists with messages
- **WHEN** user clicks the topic
- **THEN** the chat content is visible within 500ms

#### Scenario: No render-blocking resources after initial load
- **GIVEN** the app is loaded
- **WHEN** user interacts
- **THEN** no long tasks (>50ms) block the main thread during normal interaction

### Requirement: LEAK-01 — Una sessione lunga non accumula, e c'è un cancello che se ne accorge

Topics è una sessione lunga per costruzione: resta aperta per giorni, le pane si
aprono e si chiudono, i topic si cambiano, i messaggi arrivano in streaming. Un
leak è una **derivata**, e ogni altro cancello di questo repository misura un
punto — i byte del bundle a build time, la latenza di un gesto, i frame di uno
scroll. Per costruzione nessuno di loro può vederlo.

Il sistema DEVE:

1. **liberare le strutture per-socket alla chiusura.** Le due mappe dei client
   WebSocket (`wsClients`, `browserWsClients`) perdono la loro voce nel gestore
   di `close`, e la voce esterna della mappa sparisce quando il suo insieme si
   svuota;
2. **non dipendere solo da `close`.** Una rottura TCP semi-aperta (laptop che
   dorme, rete che cade) non fa scattare `close`: un heartbeat DEVE mietere i
   socket senza pong, altrimenti la pulizia non gira mai;
3. **annullare i timer che ha creato** — il timer di riconnessione
   dell'EventSource del browser remoto, e i tre timer di stream (soft, grace,
   hard);
4. **misurare la crescita nel tempo** su un banco che ripete cicli di
   interazione, e giudicarla contro un budget per heap, nodi DOM e listener.

Il cancello DEVE poter diventare rosso: un banco che non ha mai fallito non è un
banco.

> Nota su cosa esisteva già, perché questo requisito non introduce
> comportamento. Il banco (`tests/e2e/long-session-growth.spec.ts`) e il cancello
> (`scripts/check-session-growth.ts`) erano scritti, funzionanti e **senza
> requisito che li nominasse** — la terza volta che questa forma compare in una
> sola notte. Verificato il 25/08/2026: sulla misura registrata la sessione resta
> piatta (heap x1.32 su budget x1.51, DOM x1.13 su x1.3, listener x1.10 su x1.2),
> e su una misura sintetica con un leak il cancello esce rosso nominando heap e
> listener.

#### Scenario: un socket chiuso non lascia la sua voce

- **GIVEN** un client WebSocket registrato in una delle due mappe
- **WHEN** il socket si chiude
- **THEN** la sua voce è rimossa, e la voce esterna sparisce se l'insieme si svuota

#### Scenario: un socket semi-aperto viene mietuto

- **GIVEN** un socket che non risponde al ping oltre la soglia
- **WHEN** l'heartbeat gira
- **THEN** il socket è rimosso dalla mappa e chiuso

#### Scenario: la crescita oltre il budget è rossa e dice dove guardare

- **GIVEN** una misura in cui heap o listener crescono oltre il budget
- **WHEN** il cancello la giudica
- **THEN** esce non-zero, nomina la grandezza sfondata e indica dove cercare

#### Scenario: una sessione sana resta piatta

- **GIVEN** una misura di cicli ripetuti entro i budget
- **WHEN** il cancello la giudica
- **THEN** esce zero
