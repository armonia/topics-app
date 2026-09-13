# Automatic GPT task model

GOAL: Automatic tasks compare all eligible coding providers, choose and persist an available concrete GPT model and supported reasoning effort appropriate to the task, while explicit choices and existing sessions remain authoritative.

OUT: no new provider, UI, session migration, paid test calls, live task changes or runtime restart. Claude holds and machine dispatch limits remain intact; an unconstrained automatic task can choose another eligible provider.

User authorization: automatic selection across all compatible available providers and enabling Codex fixes were explicitly approved in the ongoing Topics quality pass.

BAR: mocked planner/dispatcher tests, fake Codex subprocess tests, and `./scripts/qa-gate.sh --veloce` must pass. Existing provider hold tests remain green.

PROOF: captured commands and results in verification.md; this is backend behavior with no changed browser flow.

TRACES: catalog metadata and planner → provider completion isolation/timeout → dispatcher and host routing → topic effort → regressions.
