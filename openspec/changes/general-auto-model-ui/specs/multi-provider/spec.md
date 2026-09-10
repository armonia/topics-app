## ADDED Requirements

### Requirement: MP-TASK-03 — General automatic selection and readable task models

Task creation, task details and board settings SHALL describe Auto as selection among connected, available models compatible with coding tasks, across providers. The task's Auto choice SHALL explain that an explicit project model takes precedence over general Auto. Auto SHALL NOT imply a restriction to one provider or access to API-only coding capabilities. Existing explicit model overrides and the lock on already assigned sessions SHALL remain intact.

When dispatch resolves a model, task details and board cards SHALL retain its recognizable model name and version rather than reducing it to a provider or family name. Long labels SHALL fit their containing surface, with the complete model available in the detail or tooltip.

#### Scenario: General Auto and a resolved GPT model
- **WHEN** a task using Auto is resolved to `gpt-5.5`
- **THEN** the model chip identifies `GPT-5.5`, not only `gpt`
- **AND** the same model label is used in manual selection and task presentation.

#### Scenario: Manual selection and existing sessions
- **WHEN** a user opens the task model selector before assignment
- **THEN** Auto and available explicit models remain selectable
- **AND** an assigned session keeps its model selector locked.
