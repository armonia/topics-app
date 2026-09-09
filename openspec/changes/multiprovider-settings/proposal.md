# Multi-provider readiness and a clear setup path

## Goal
Make the existing GPT paths discoverable and reliable from Settings through model selection and task dispatch, and describe precisely what Topics can run without a CLI.

## Scope authorized by the current request
- Connect or replace an OpenAI/Anthropic API key from Settings even on a fresh installation. Persist keys in a private server-side file, never in the public settings or snapshots. Validate credentials before replacing working configuration.
- Preserve explicit GPT selection and make OpenAI defaults effective on the next turn. Use compatible request parameters and filter unsupported model modalities from the chat catalog.
- Show task models from providers that can actually execute coding tasks and route the chosen model accordingly; do not offer API chat-only providers as coding agents.
- Explain API billing, local execution requirements, and the current Claude-only native engine. Put advanced execution controls behind a disclosure.
- Keep the initial client bundle within the existing budget. Load the optional version/update panel separately, warming it when its parent menu opens.

## Outside this change
A new native GPT coding engine, a Topics-hosted inference service, new OAuth login flows, per-member billing/credential tenancy, and automatic migration of live sessions. These are evaluated in the design rather than presented as existing capabilities. No paid generation or real task dispatch is needed for verification.

## Acceptance bar and evidence
Targeted provider/auth/routing contract tests pass; isolated desktop/mobile Settings and GPT picker flows pass with video; typecheck, lint and static gates (`bun run qa:gate --veloce`) pass; client build stays within its budget. An independent verifier reviews routing and persistence. Existing green checks are repeated only if relevant code changes.

## Tracks
1. Provider credential and OpenAI contracts.
2. Settings, model selection, and execution routing.
3. Independent review, isolated browser evidence, and no-CLI product assessment.
