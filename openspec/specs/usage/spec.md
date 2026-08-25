## Purpose

Answers the money question: how many tokens a turn actually consumed, what those
tokens cost, and how much the NEXT call will cost. It is a separate capability
from `resource-attribution` on purpose — that one attributes memory and CPU to a
pane, this one attributes tokens and dollars to a turn, a tool call and a
session. The two share nothing: no module, no table, no unit.

It is also separate from `context`, which describes the inspector (which sources
go into the prompt, and the dedup that keeps them from being re-sent). Here the
context window appears only as a DENOMINATOR: what the counter divides by, and
why a wrong denominator makes the ring lie.

## Background

Common preconditions:

- Prices are USD per 1M tokens and live in one table (`server/usage/pricing.ts`).
  A wrong price does not raise an error — it produces a plausible number that
  nobody checks until the bill arrives. Measured on the production DB: with the
  table frozen on retired models every Opus turn fell into the family fallback
  at $15/$75 and was shown at three times its real cost ($643.66 against
  $214.55 on the sample). Migration `073_fix_opus_pricing` rewrote the stored
  rows; the requirements below keep the table from drifting again.
- The four kinds of prompt token are priced differently and are **disjoint
  shares of the same total**: fresh input at 1×, a 5-minute cache write at
  1.25×, a 1-hour cache write at 2×, a cache read at 0.1×. `prompt = fresh +
  cacheRead + cacheCreation`, and the 1-hour figure is a share of
  `cacheCreation`, never an addend.
- "Context" (the ring's numerator) is `input + cache_read + cache_creation` of
  ONE call: what the model just read. Output is not context, and reasoning
  tokens are not either — they are already inside the next round's input.
- A session's spend is not how much was said: it is how much context the model
  holds MULTIPLIED by how many times it is re-sent. Every tool call is a call to
  the model, and every call re-reads everything.

## Requirements

### Requirement: USAGE-01 — Every model resolves to a price, and an unpriced one is visible rather than free

The system SHALL resolve a model id to a price by exact match first, then by
longest known key contained in the id, then by an explicit family fallback that
points at the CURRENT model of that family. A window-mode suffix (`[1m]`) SHALL
be stripped before matching: it is a serving mode, not a different model. A model
that resolves to nothing SHALL be billed at zero rather than at a wrong rate.

#### Scenario: A shorter name does not borrow a longer key's rate
- **GIVEN** the table holds both `gpt-4o` and `gpt-4o-mini`
- **WHEN** a turn on `gpt-4o` is priced
- **THEN** it SHALL be billed at the `gpt-4o` rate, not at the cheaper `gpt-4o-mini` rate
- **AND** a versioned id such as `gpt-4o-2024-08-06` SHALL still resolve to `gpt-4o`

#### Scenario: The models actually in use have their own price, not the family fallback
- **GIVEN** the current model ids (`claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`, `claude-fable-5`)
- **WHEN** each is priced
- **THEN** each SHALL resolve to its own entry
- **AND** an Opus turn SHALL NOT be billed at the retired $15/$75 rate

#### Scenario: The family fallback points at the current model
- **GIVEN** an id of a known family that is not yet in the table (`claude-opus-99-inesistente`)
- **WHEN** it is priced
- **THEN** it SHALL be billed at the CURRENT model's rate for that family
- **AND** erring low SHALL be preferred to erring high

#### Scenario: The window suffix does not lose the exact price
- **GIVEN** the id `claude-opus-5[1m]`, which is what the CLI reports
- **WHEN** it is priced
- **THEN** it SHALL resolve to the same rate as `claude-opus-5`

#### Scenario: An unknown model is not billed
- **GIVEN** a model id present in no entry and in no family
- **WHEN** a turn on it is priced
- **THEN** the cost SHALL be zero
- **AND** the same SHALL hold when the cache-aware calculation is used

### Requirement: USAGE-02 — Cache tokens are billed at the cache rate, and the two write TTLs are disjoint

The system SHALL price a cache read at 0.1×, a 5-minute cache write at 1.25× and
a 1-hour cache write at 2× the model's input rate. The 1-hour figure SHALL be a
share of the cache-write total, added alongside the 5-minute share and never on
top of the same tokens. Splitting a provider's prompt total into its shares
SHALL never produce a negative fresh figure — incoherent input SHALL yield a low
cost, never a credit.

#### Scenario: A re-read prompt is not billed as fresh input
- **GIVEN** a turn whose prompt is almost entirely cache reads (a long agentic turn)
- **WHEN** it is priced with the shares separated
- **THEN** the cost SHALL be several times lower than pricing the same total as fresh input
- **AND** a call with no cache tokens SHALL cost exactly what the plain calculation gives

#### Scenario: An hour-long cache write costs twice a five-minute one
- **GIVEN** the same number of cache-write tokens on the same model
- **WHEN** they are billed once as 5-minute and once as 1-hour
- **THEN** the ratio SHALL be 2 to 1.25

#### Scenario: The two write shares add up instead of overwriting each other
- **GIVEN** a turn with both 5-minute and 1-hour cache writes
- **WHEN** it is priced
- **THEN** the result SHALL equal the sum of the two shares priced separately

#### Scenario: A caller that only has the total keeps the previous behaviour
- **GIVEN** a caller that passes only the cache-write total, with no TTL breakdown
- **WHEN** the turn is priced
- **THEN** the whole total SHALL be billed at 1.25×

#### Scenario: Incoherent shares do not produce a credit
- **GIVEN** a provider reporting more cache-read tokens than prompt tokens
- **WHEN** the prompt total is split into shares
- **THEN** the fresh share SHALL be zero, never negative
- **AND** the resulting cost SHALL still be positive

### Requirement: USAGE-03 — A turn's usage accumulates per model call and is not poisoned by a dirty number

The system SHALL accumulate the usage of a turn one model call at a time, count
the calls, and produce a NEW total rather than mutating the previous one. A value
that is not a usable number — `NaN`, `Infinity`, negative — SHALL contribute zero
to the sums while still counting as a call.

#### Scenario: The empty total is zero, calls included
- **GIVEN** a turn that has not yet seen a call
- **WHEN** its total is read
- **THEN** every field SHALL be zero, the call count included

#### Scenario: Calls sum and are counted
- **GIVEN** two calls with their own prompt, completion and cache-read figures
- **WHEN** both are accumulated
- **THEN** the total SHALL be their sum
- **AND** the call count SHALL be two

#### Scenario: Accumulation does not mutate the previous total
- **GIVEN** a total that crosses an asynchronous handler driven by a stream parser
- **WHEN** a call is accumulated onto it
- **THEN** the previous total SHALL be unchanged
- **AND** the result SHALL be a different object

#### Scenario: One dirty value does not poison the rest of the turn
- **GIVEN** a call reporting `NaN` between two well-formed calls
- **WHEN** all three are accumulated
- **THEN** the total SHALL be the sum of the two well-formed calls
- **AND** it SHALL remain a finite number

#### Scenario: Infinity and negatives count as zero but still count as a call
- **GIVEN** a call reporting `Infinity` for the prompt and a negative cache read
- **WHEN** it is accumulated
- **THEN** both sums SHALL be zero
- **AND** the call count SHALL be one

### Requirement: USAGE-04 — The shares written to a row and sent on the wire are disjoint

The system SHALL expose a turn's shares in the DISJOINT form used by the message
row (migration 070) and by the `stream:usage` frame, through a single
translation: fresh is the REMAINDER, the 1-hour write is capped at the write
total, and the four shares SHALL sum to the prompt total. Callers that persist or
transmit a turn's usage SHALL go through that translation rather than naming the
raw nested fields.

#### Scenario: Fresh is the remainder and the four shares sum to the prompt
- **GIVEN** a turn total with prompt, cache read, cache write and a 1-hour share
- **WHEN** the shares are computed
- **THEN** fresh SHALL be the prompt minus the reads and writes
- **AND** fresh plus read plus the two write shares SHALL equal the prompt

#### Scenario: The 1-hour figure is a share of the writes, not an addition
- **GIVEN** a turn with 40 write tokens of which 10 are at the 1-hour TTL
- **WHEN** the shares are computed
- **THEN** the 1-hour share SHALL be 10 and the 5-minute share 30, not 50 in total

#### Scenario: Everything written at the 1-hour TTL empties the 5-minute share
- **GIVEN** a turn whose cache-write total coincides with its 1-hour figure — the shape the CLI actually produces
- **WHEN** the shares are computed
- **THEN** the 5-minute share SHALL be zero rather than replicating the 1-hour one
- **AND** the four shares SHALL still sum to the prompt

#### Scenario: A 1-hour figure larger than the write total does not produce a negative
- **GIVEN** a provider reporting a 1-hour figure above the cache-write total (rounding between calls)
- **WHEN** the shares are computed
- **THEN** the 1-hour share SHALL be capped at the total and the 5-minute share SHALL be zero

#### Scenario: No input produces an impossible row
- **GIVEN** any combination of overflowing, inverted or dirty figures
- **WHEN** the shares are computed
- **THEN** neither write share SHALL be negative
- **AND** the two write shares together SHALL equal the cache-write total

### Requirement: USAGE-05 — The token-cost rule written in SQL agrees with the one written in TypeScript

The cost and context formulas SHALL exist as one decision with two writings — a
TypeScript function for per-row work and an SQL fragment for aggregation — and
the two SHALL produce the same number on the same input, including rows where a
column was never written and rows where the recorded cache read exceeds the
recorded prompt.

#### Scenario: The two writings agree on every row shape
- **GIVEN** a set of rows including zeroes, never-written columns and a legacy row whose cache read exceeds its prompt
- **WHEN** cost and context are computed once in SQL on a real SQLite database and once in TypeScript
- **THEN** the two results SHALL be equal for every row

#### Scenario: The two tables agree on the same consumption
- **GIVEN** the same consumption expressed as a `messages` row and as a `tasks` row
- **WHEN** the cost is computed in SQL for both
- **THEN** the two SHALL be the same number

### Requirement: USAGE-06 — The context counter carries the literal ACP `usage_update` block

The payload of the context counter SHALL contain the ACP block verbatim —
`sessionUpdate: "usage_update"` with `used` and `size` — with the presentation
fields (`percent`, `level`, `reason`, `estimated`, `model`) alongside it and
never inside it. The numerator SHALL be `input + cache_read + cache_creation`;
output and reasoning tokens SHALL NOT count. The live event and the persisted
read SHALL produce the same object for the same measure.

#### Scenario: The numerator is input plus cache
- **GIVEN** a usage report with input, cache-read and cache-creation figures
- **WHEN** the context numerator is computed
- **THEN** it SHALL be their sum

#### Scenario: Output and reasoning are not context
- **GIVEN** a usage report carrying a large output figure, and one carrying reasoning tokens
- **WHEN** the numerator is computed
- **THEN** neither SHALL contribute

#### Scenario: A missing or malformed usage report is zero, not an exception
- **GIVEN** a usage report that is null, undefined, empty, or carries `NaN` and negative fields
- **WHEN** the numerator is computed
- **THEN** it SHALL be zero and nothing SHALL be thrown

#### Scenario: Presentation stays outside the protocol block
- **GIVEN** a context update built for a known model
- **WHEN** the payload is inspected
- **THEN** the ACP block SHALL contain exactly `sessionUpdate`, `used` and `size`
- **AND** `percent`, `level` and `estimated` SHALL sit beside it, not within

#### Scenario: Cost appears only when there is one
- **GIVEN** a context update built without a cost
- **WHEN** the payload is inspected
- **THEN** the block SHALL carry no `cost` field, rather than a zero
- **AND** a cost passed in SHALL appear verbatim

#### Scenario: The percentage saturates at 100 while the measure stays true
- **GIVEN** a measure larger than the resolved window
- **WHEN** the update is built
- **THEN** the percentage SHALL be 100 and the level critical
- **AND** `used` SHALL remain the real number

#### Scenario: Live and stored reads produce the same object
- **GIVEN** the same measure, once as a live event and once classified from the persisted row
- **WHEN** both payloads are built
- **THEN** they SHALL be equal

### Requirement: USAGE-07 — The context window is resolved from the model that served the call

The system SHALL size the context window from the model that SERVED the call,
falling back to the model that was requested. A window-mode suffix carried by the
request SHALL survive the bare id the CLI reports, but ONLY when the same model
answered: a fallback onto a different model SHALL bring its own window. A window
DECLARED by the provider SHALL outrank the table and SHALL clear the `estimated`
flag; a declared window that is zero, negative or not a number SHALL be ignored.
An unknown model SHALL fall back to the default window and SHALL declare that the
figure is an estimate.

#### Scenario: Full provider ids resolve, and longer keys win
- **GIVEN** ids carrying dates and suffixes (`claude-sonnet-4-5-20250929`, `gpt-4o-mini-2024-07-18`, `gpt-5-codex`)
- **WHEN** their window is resolved
- **THEN** each SHALL resolve to its own window rather than to a shorter key's

#### Scenario: A bare Claude id is the short window; the long window must be asked for
- **GIVEN** `claude-opus-5` bare and `claude-opus-5[1m]`
- **WHEN** their windows are resolved
- **THEN** the bare id SHALL be the short window and the suffixed one the long window
- **AND** a model whose long window is standard SHALL resolve long without a suffix

#### Scenario: An unknown model uses the default and declares it
- **GIVEN** a model id in no table entry, or no id at all
- **WHEN** the window is resolved
- **THEN** it SHALL be the default window
- **AND** it SHALL be marked as not known, so the interface can show an approximation instead of a false precision

#### Scenario: The requested suffix survives the CLI's bare id
- **GIVEN** a session started on a long-window mode whose events report the bare id
- **WHEN** the window model is resolved from the served id and the requested id
- **THEN** it SHALL keep the suffix and resolve to the long window

#### Scenario: A fallback onto another model brings its own window
- **GIVEN** a long-window request that was served by a different model (fast mode, overload)
- **WHEN** the window model is resolved
- **THEN** it SHALL be the model that answered, with that model's window

#### Scenario: The model serving the call outranks the one requested
- **GIVEN** a call served by a long-window model while a short-window model was requested
- **WHEN** the context update is built
- **THEN** the size SHALL be the long window and the percentage computed against it

#### Scenario: A window declared by the provider outranks the table
- **GIVEN** a provider that reports its own context window for a model absent from the table
- **WHEN** the update is built
- **THEN** the declared window SHALL be used and the estimate flag SHALL be off
- **AND** a declared window of zero, negative or `NaN` SHALL leave the resolved window untouched

#### Scenario: A recorded measure is re-divided by the current model's window
- **GIVEN** a persisted measure recorded against a window the table has since corrected
- **WHEN** it is re-read
- **THEN** the denominator SHALL be recomputed from the CURRENT model of the topic
- **AND** an unknown current model SHALL leave the recorded window in place, carrying its estimate flag

### Requirement: USAGE-08 — A measure that received an answer outranks a window too small to have served it

When the measured context exceeds the resolved window, the system SHALL treat the
measure as evidence and widen the window: a prompt that received an answer fit
inside the window that served it. Promotion to a named longer window SHALL happen
only for the model families that window is actually served for; beyond every
named window the measure itself SHALL become the size and SHALL be declared an
estimate. A window that was already an estimate SHALL NOT be promoted to a
certainty.

#### Scenario: A measure that fits changes nothing
- **GIVEN** a measure at or below the resolved window, or zero, or `NaN`
- **WHEN** the covering window is computed
- **THEN** the window SHALL be returned unchanged

#### Scenario: A measure that overflows promotes only the families served long
- **GIVEN** a measure above the short window on a family the long window is served for
- **WHEN** the covering window is computed
- **THEN** it SHALL be the long window
- **AND** on a family that long window is NOT served for, the size SHALL become the measure itself, declared an estimate

#### Scenario: Beyond every named window the measure is the size
- **GIVEN** a measure above the longest named window
- **WHEN** the covering window is computed
- **THEN** the size SHALL be the measure and it SHALL be declared an estimate

#### Scenario: A guess is not promoted to a certainty
- **GIVEN** a starting window already marked as not known
- **WHEN** a measure forces it wider
- **THEN** the result SHALL still be marked as not known

#### Scenario: No route lets a session read above 100%
- **GIVEN** a session started long, whose transcript reports the bare id, with and without a requested model
- **WHEN** the ratio of measure to resolved window is computed on each route
- **THEN** it SHALL never exceed 1

### Requirement: USAGE-09 — The warning level answers two questions: capacity, and price per call

The system SHALL raise the context level from the PERCENTAGE of the window used
and, independently, from the ABSOLUTE token count — because on a long window a
small percentage is still a large prompt that every call re-reads. The payload
SHALL say which of the two spoke. Colour SHALL follow the percentage alone, so a
cost warning does not repaint a ring that is not full.

#### Scenario: One scale for colour and warning
- **GIVEN** the warning and critical percentage thresholds
- **WHEN** a percentage is classified
- **THEN** below warning it SHALL be ok, at warning it SHALL be warn, at critical it SHALL be critical

#### Scenario: Absurd numbers do not produce NaN in the ring
- **GIVEN** a `NaN` measure, a negative measure, or a zero-sized window
- **WHEN** the measure is classified
- **THEN** the percentage SHALL be zero, the used figure SHALL be zero, and the size SHALL fall back to the default

#### Scenario: The absolute threshold fires on a long window at a low percentage
- **GIVEN** a measure at the absolute warning threshold on a long window
- **WHEN** it is classified
- **THEN** the percentage SHALL stay low and the level SHALL be warn
- **AND** the reason SHALL name cost rather than capacity

#### Scenario: Capacity is the explanation when both fire
- **GIVEN** a measure that trips both the percentage and the absolute threshold
- **WHEN** it is classified
- **THEN** the reason SHALL name the window, the more urgent of the two

#### Scenario: The ring stays cool where the warning fires on cost
- **GIVEN** a measure that is critical by absolute tokens but low by percentage
- **WHEN** the payload is read
- **THEN** the percentage SHALL remain low while the level is critical

### Requirement: USAGE-10 — The cost probe multiplies current context by calls, and shows measured beside projected

The system SHALL report, for a session, the CURRENT context multiplied by the
number of tool calls (the projection), alongside the prompt tokens actually sent
(the measurement), and the price of ONE more call — billed as a cache read,
because that is what a re-sent context is. The current context SHALL be the LAST
measure, not the largest, so a compaction lowers it. A persisted live measure
SHALL outrank the last message's, because it belongs to the turn in progress. A
session with no measures SHALL report zero, never an invented number.

#### Scenario: The probe reconstructs a measurement taken by hand on a real chat
- **GIVEN** a frozen 46-message prefix of a real session, and the figures read by hand from the interface
- **WHEN** the probe is computed on it
- **THEN** messages, tool calls, context, prompt tokens, cost and the last turn's prompt SHALL each be within 10% of the hand measurement
- **AND** the projected product SHALL exceed what was measured, within the same order of magnitude, because the context was growing

#### Scenario: The product is context times calls, not the sum of prompts
- **GIVEN** a turn with three calls and a known prompt total
- **WHEN** the probe is computed
- **THEN** the projection SHALL be the last context multiplied by the call count
- **AND** the measured prompt SHALL be reported separately

#### Scenario: The context is the last measure, so a compaction lowers it
- **GIVEN** a session whose later call measured far less context than an earlier one
- **WHEN** the probe is computed
- **THEN** the current context SHALL be the later, smaller figure

#### Scenario: A call without a measure still counts as a call
- **GIVEN** a turn whose trailing calls carry no context measure
- **WHEN** the probe is computed
- **THEN** they SHALL count towards the call total but not towards the context

#### Scenario: The live measure outranks the message row
- **GIVEN** a persisted session measure more recent than the last message's calls
- **WHEN** the probe is computed
- **THEN** the current context and the window SHALL come from it

#### Scenario: A session with no measures reports zero, not NaN
- **GIVEN** a session with no usage at all
- **WHEN** the probe is computed
- **THEN** context, projection and per-call price SHALL be zero and there SHALL be no last turn

#### Scenario: The last turn skips a reply that cost nothing
- **GIVEN** a costly turn followed by one interrupted before its first call
- **WHEN** the last turn is elected
- **THEN** it SHALL be the costly one, so the multiplier is not zeroed right after an expensive turn

#### Scenario: One more call is priced as a cache read
- **GIVEN** a session holding a known context on a priced model
- **WHEN** the price of one more call is computed
- **THEN** it SHALL be the context billed at the cache-read rate, not as fresh input

#### Scenario: The window never falls below the measure
- **GIVEN** a persisted window smaller than the measured context
- **WHEN** the probe is computed
- **THEN** the reported window SHALL be at least the measure

### Requirement: USAGE-11 — The probe reads a session's rows in conversation order

Reading the probe from the database SHALL return the session's messages in
conversation order — by sort order, not by timestamp. A read limited to a prefix of the conversation SHALL exclude the live persisted
measure, which belongs to the present rather than to the window being measured. A
session that does not exist SHALL produce an empty probe.

#### Scenario: The database read reproduces the probe's own figures
- **GIVEN** the fixture rows inserted into a database
- **WHEN** the probe is read through the query
- **THEN** messages, tool calls, context and prompt tokens SHALL match the values computed directly from the rows

#### Scenario: Order is the stored order, not the timestamp
- **GIVEN** rows whose timestamps deliberately alternate between two days
- **WHEN** the rows are read
- **THEN** their order SHALL be the stored conversation order

#### Scenario: A prefix really truncates
- **GIVEN** a limit of 12 messages on a 46-message session
- **WHEN** the probe is read
- **THEN** it SHALL report 12 messages, fewer calls and fewer prompt tokens

#### Scenario: On a prefix the live measure does not enter
- **GIVEN** a persisted live measure far larger than anything in the prefix
- **WHEN** the probe is read with a limit
- **THEN** the context SHALL come from the rows
- **AND** without a limit the live measure SHALL win

#### Scenario: A session that does not exist does not explode
- **GIVEN** a session key with no rows
- **WHEN** the probe is read
- **THEN** every figure SHALL be zero

### Requirement: USAGE-12 — The live turn strip shows the accumulated total, never a client-side sum

While a turn runs, the interface SHALL show the turn's consumption only once a
usage frame has arrived — never a count invented from zero — and SHALL REPLACE it
with each frame, because the server sends totals already accumulated. The figure
shown SHALL be the WEIGHTED cost (a cache read weighs 0.1), while the raw figures
and the call count SHALL remain readable in the element's title.

#### Scenario: No usage frame, no count
- **GIVEN** a turn that has started streaming and has received no usage frame
- **WHEN** the streaming strip is inspected
- **THEN** the turn-usage entry SHALL NOT be present

#### Scenario: The first frame shows the weighted cost
- **GIVEN** a usage frame with prompt, completion and cache-read figures
- **WHEN** the strip renders
- **THEN** it SHALL show the weighted token cost in compact form
- **AND** the title SHALL carry the raw cache-read and fresh figures

#### Scenario: The second frame replaces the first instead of summing
- **GIVEN** a second usage frame carrying the running total
- **WHEN** the strip updates
- **THEN** it SHALL show the cost of that total
- **AND** it SHALL NOT show the sum of the two frames

#### Scenario: The call count explains the tokens read
- **GIVEN** a turn that has made two model calls
- **WHEN** the strip's title is read
- **THEN** it SHALL name the number of calls

### Requirement: USAGE-13 — The turn multiplier needs both factors, and moves while the turn works

The interface SHALL show the multiplier — tool calls × context — only when BOTH
factors exist, SHALL update it as calls accumulate during the turn, and SHALL
expose the two factors machine-readably with the product spelled out in the
title. The context inspector SHALL show the same multiplication for the whole
session, together with the price of the next call, the prompt tokens actually
sent and the last turn's figures.

#### Scenario: One factor is not a multiplication
- **GIVEN** a live turn for which the context is known but no call has happened
- **WHEN** the composer strip is inspected
- **THEN** the multiplier SHALL NOT be present

#### Scenario: The multiplier appears with the first call and grows
- **GIVEN** a turn reporting one call, then six, then twelve, at a constant context
- **WHEN** each frame arrives
- **THEN** the multiplier SHALL show the current call count against that context each time

#### Scenario: The factors are machine-readable and the product is spelled out
- **GIVEN** a multiplier showing twelve calls at a known context
- **WHEN** its attributes are read
- **THEN** the call count and the context SHALL be exposed as data
- **AND** the title SHALL state the resulting product

#### Scenario: The inspector shows the session's multiplication
- **GIVEN** a session probe with a context, a call count and a projected product
- **WHEN** the cost panel is opened from the context ring
- **THEN** it SHALL show context, calls and the product as one expression
- **AND** it SHALL show the price of the next call, the prompt tokens really sent, and the last turn

### Requirement: USAGE-14 — Each tool row carries the cost of the model call that decided it

Each tool row SHALL show the cost attributed to that single action, and a group
row SHALL show the sum of the costs of the actions it collapses. Those figures
SHALL be present in the document but painted only under the pointer, with their
space reserved so revealing them does not reflow the row. A group's reveal SHALL
be its own: hovering a sibling row SHALL NOT light up the group summary.

#### Scenario: Each row shows its own cost and a group sums its actions
- **GIVEN** a turn with two ungrouped tool calls of very different cost, and another with three collapsed into a group
- **WHEN** the transcript is rendered
- **THEN** each single row SHALL show its own attributed cost
- **AND** the group row SHALL show the sum of its three actions

#### Scenario: The figures are present but unpainted at rest
- **GIVEN** a finished tool row that is not under the pointer
- **WHEN** its cost and duration are measured
- **THEN** their painted opacity SHALL be zero
- **AND** their box SHALL already occupy width, so nothing moves when they light up

#### Scenario: The pointer reveals them without shifting the row
- **GIVEN** a tool row under the pointer
- **WHEN** cost and duration are measured
- **THEN** both SHALL be fully painted
- **AND** the cost box SHALL sit at the same horizontal position as at rest

#### Scenario: A group's reveal is its own
- **GIVEN** a transcript containing both single rows and a group row
- **WHEN** the pointer moves onto a single row
- **THEN** the group summary SHALL stay unpainted
- **AND** it SHALL light up only when the group's own summary is hovered

### Requirement: USAGE-15 — Il consumo di un turno si legge in avanti, e non si conta due volte

Il consumo SHALL essere letto dal transcript in modo INCREMENTALE, ripartendo
soltanto dai byte aggiunti: il file è in sola aggiunta e viene interrogato ogni
pochi secondi.

Le righe di consumo SHALL essere DEDUPLICATE per identificativo del messaggio. La
riga di comando ne scrive UNA per ogni blocco di contenuto della stessa risposta,
con gli stessi numeri: sommarle tutte sovracconta di due volte e mezzo.

Il conteggio fatturabile SHALL comprendere ingresso, uscita e scrittura di cache,
e NON la lettura di cache.

La cache a lunga durata SHALL essere letta dal campo che la dichiara e NON
dedotta dal tempo fra due richieste. Prima si tariffava tutto assumendo
l'aggregazione: su una sessione vera il costo passa da 149,69 a 175,75 dollari.

Un file che è DIVENTATO più piccolo dell'offset noto SHALL far ripartire il
conteggio da capo: è stato compattato, non è tornato indietro.

Una riga scritta a metà SHALL essere tenuta da parte come byte grezzi fino al
completamento, perché un carattere multi-byte può essere spezzato dal taglio.

Un file assente SHALL dare zero e NON un errore.

#### Scenario: tre righe per una risposta
- **GIVEN** tre righe di consumo con lo stesso identificativo di messaggio
- **THEN** SHALL contare una volta sola

### Requirement: USAGE-16 — Il consumo di un task comprende le sue sessioni figlie, e non torna mai indietro

Il consumo attribuito a un task SHALL comprendere quello delle sessioni FIGLIE.
Con un coordinatore il lavoro vero gira nelle figlie, ognuna col proprio
transcript: contare solo il padre mostrerebbe le card che delegano di più come
le più economiche.

Il registro NON SHALL mai decrescere. Una figlia MORTA SHALL restare sommata con
il suo ultimo valore noto, e un transcript diventato illeggibile o azzerato SHALL
valere l'ultimo valore noto e MAI zero. Il consumo di un turno si calcola come
differenza con un pavimento a zero: una lettura calante sparirebbe in silenzio.

Solo le figlie di QUELLA sessione SHALL entrare nel conto.

Una interrogazione fallita SHALL rispondere con quello che il registro ha, mai
con un'eccezione.

#### Scenario: una figlia che muore
- **GIVEN** una sessione figlia sparita dal registro delle sessioni
- **THEN** il suo ultimo consumo noto SHALL restare nel totale

#### Scenario: un transcript azzerato
- **GIVEN** una figlia il cui transcript torna un valore più basso di prima
- **THEN** SHALL valere il valore più alto già letto

### Requirement: USAGE-17 — Due strade, un numero solo

Lo stesso consumo arriva in tabella per DUE strade indipendenti: il trascritto
che la riga di comando scrive su disco e legge a incrementi (la strada di un
task della board), e gli eventi del fornitore accumulati sul turno (la strada di
una chat). Le due SHALL produrre lo STESSO numero a partire dallo stesso
consumo.

La definizione di «quanti token» SHALL essere UNA e SHALL essere provata
CONFRONTANDO le due strade sullo stesso ingresso, non verificandole ciascuna
contro le proprie aspettative. Due strade provate separatamente restano verdi
mentre divergono.

#### Scenario: lo stesso consumo per le due strade
- **GIVEN** un consumo fatto passare per il trascritto e per gli eventi
- **THEN** i due totali SHALL coincidere

### Requirement: USAGE-18 — L'uscita per le macchine è un contratto, non una stampa più ordinata

Lo strumento a riga di comando che riporta il consumo SHALL avere una forma
destinata a un PROGRAMMA, e quella forma SHALL essere analizzabile PER INTERO:
una riga di legenda, un colore o un'intestazione di tabella la rendono
inutilizzabile, e il guasto arriva a valle, dove nessuno lo collega allo
strumento.

La prova SHALL far girare lo strumento DAVVERO e analizzare tutta la sua uscita,
non cercare pezzi dentro il testo. I numeri attesi SHALL essere calcolati a mano
sull'ingresso: senza, lo strumento continua a stampare una forma valida e
sbagliata.

#### Scenario: uscita per macchina
- **GIVEN** lo strumento eseguito nella forma destinata ai programmi
- **THEN** tutta l'uscita SHALL essere analizzabile in una volta sola
