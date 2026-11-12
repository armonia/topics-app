# No silent fallback for non-Claude models (card c13102d3)

Decision: a scheduled agent whose model is not a Claude model (for example a
`muse-cli/*` id) is never run on a paid Claude fallback model.

- Before: the native engine dropped the unknown model and used the default
  Claude model through the paid API. One first run spent 34.9 M prompt tokens
  (5.20 EUR) and exhausted the API credit, and nobody was told.
- Now: `engine::model()` in the jarvis-channels crate returns an error that
  names the model, and the turn fails at start with that reason in its thread.
  A job with no model set still gets the default; a Claude id passes through.
- Where it lives: the crate is outside this repository. Change in the jarvis
  repository, commit b258b993; test
  `a_non_claude_model_is_refused_instead_of_falling_back`, and flipping the
  `Err` branch to `Ok` turns it red.
- Rule going forward: a non-Claude model runs on its own engine (delegate or
  museagent), or the job refuses to start.
