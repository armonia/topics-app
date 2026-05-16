# Delta — tools capability (new)

## ADDED Requirements

### Requirement: Tool call row renders a form when input is required

The `<ToolCallRow>` component SHALL recognize the `status: "waiting_for_input"` state. When in that state the row SHALL:

1. Auto-expand to its detail view (regardless of the user's prior collapsed/expanded preference for that row).
2. Render `<ToolInputForm>` with `schema = toolCall.userInputSchema` and `onSubmit = chatApi.toolResponse(...)`.
3. Display a short banner ("L'agente attende la tua risposta") above the form to make the pending state legible at a glance.
4. Hide the generic loading spinner that the row uses for `pending` / `running`.

The form SHALL stay editable until either the user submits successfully (HTTP 200), the user clicks the global Stop button, or the session is aborted by the provider. A 4xx/5xx submission SHALL display an inline error and keep the form interactive.

After a successful submission the row SHALL switch to a collapsed summary that shows the value the user sent, so the conversation history remains auditable. This summary SHALL be readable even when scrolled back to in a later session.

#### Scenario: `questions` schema renders one radio fieldset per question

- **GIVEN** a tool call with `userInputSchema.kind === "questions"` and three questions, each with three options
- **WHEN** the row mounts in `waiting_for_input` state
- **THEN** the form SHALL render three `<fieldset>` elements, each containing four radios (three options + "Other" with an inline textarea)
- **AND** the Send button SHALL be disabled until every question has a selection
- **AND** if a question declares `multiSelect: true`, its inputs SHALL be checkboxes instead of radios

#### Scenario: `elicitation` schema renders a typed form

- **GIVEN** a tool call with `userInputSchema.kind === "elicitation"` and a `requestedSchema` of `{ type: "object", properties: { name: { type: "string" }, age: { type: "number", minimum: 0 } }, required: ["name"] }`
- **WHEN** the form renders
- **THEN** it SHALL show a text input for `name` (required, marked) and a number input for `age` (optional, with min=0 validation)
- **AND** submission SHALL be blocked until required fields are filled and validation passes
- **AND** the submitted payload SHALL be `{ name: <string>, age?: <number> }`

#### Scenario: `raw` fallback shows a free-text area

- **GIVEN** a tool call with `userInputSchema.kind === "raw"`
- **WHEN** the form renders
- **THEN** it SHALL show a single multi-line textarea and a Send button
- **AND** submission SHALL forward the textarea's value verbatim

#### Scenario: Submitted response is preserved in history

- **GIVEN** a tool call that has been answered with the value `"option B"`
- **WHEN** the user scrolls back to this exchange (same session or after reload)
- **THEN** the row SHALL render a collapsed summary line containing `"option B"` (or the structured value for non-question shapes)
- **AND** clicking the summary SHALL expand to a read-only view of the full prompt and the user's response
