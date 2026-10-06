# Acceptance — model-picker-compact

## Barra eseguibile

```bash
# 1. Unit dell'accordion + compattazione (qui)
bun test --timeout 30000 client/src/components/Shared/ModelSelector/ModelList.test.tsx
# 2. Porte locali (qui)
bun run typecheck && bun run lint && bun run check:comment-language \
  && bun run check:identifier-language && bun run check:spec-coverage
# 3. e2e del selettore (su CI, PR della change)
#    model-selector, model-selector-revision, model-panels-providers,
#    picker-keyboard-nav, muse-provider-picker — tutti verdi
# 4. Mutazione sul punto critico (qui, a mano, poi revert):
#    invertire il default-aperto in ModelList → il unit sull'accordion rosso
```

## Scenario: accordion

- **GIVEN** il selettore aperto su una chat con Opus 5.5
- **WHEN** l'utente guarda il pannello
- **THEN** solo la sezione Anthropic è aperta, le altre mostrano solo
  l'intestazione con `aria-expanded="false"`
- **WHEN** tocca l'intestazione OpenAI
- **THEN** OpenAI si apre sul posto senza chiudere le altre.

## Scenario: ricerca apre tutto

- **GIVEN** il selettore con sole Anthropic aperta
- **WHEN** l'utente cerca «gpt»
- **THEN** le sezioni rimaste sono tutte aperte
- **WHEN** pulisce la ricerca
- **THEN** torna lo stato dei toggle.

## Scenario: banda una riga

- **GIVEN** il selettore aperto a 1280 px
- **THEN** la banda sta in una riga e dice «Gli altri vanno diretti»
- **AND** Automatico sta in una riga «Automatico · nome».

## Prova

CI verde sulla PR + screenshot AC-34 scaricati dagli artifact e rivisti.
