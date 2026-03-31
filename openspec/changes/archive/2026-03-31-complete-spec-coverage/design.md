## Context

Topics App has 10 OpenSpec specs covering core features (chat, topics, kanban, layout, agents, files, terminal, dashboard, context, commands) with 18 requirements and 308 scenarios. A codebase audit revealed 20 additional feature areas with no spec coverage, including major user-facing features (embedded browser, cron jobs, system monitoring, remote access) and supporting systems (webhooks, processes, spaces).

All specs are documentation-only — GIVEN/WHEN/THEN behavioral scenarios describing current app behavior. No code changes are involved.

## Goals / Non-Goals

**Goals:**
- Achieve near-complete spec coverage of all user-facing features in Topics App
- Create 7 new specs for uncovered feature domains
- Extend 6 existing specs with missing requirements via delta files
- Maintain consistent format (OpenSpec-valid, coverage-script-compatible)
- Every requirement has testable GIVEN/WHEN/THEN scenarios

**Non-Goals:**
- Writing new E2E tests (separate future milestone)
- Changing application code or behavior
- Specifying internal implementation details
- Covering non-user-facing infrastructure (database schema, build pipeline)

## Decisions

**1. Delta specs for modifications vs. rewriting entire specs**
- Decision: Use OpenSpec delta format (ADDED/MODIFIED sections) for extending existing specs
- Rationale: Delta files are archived cleanly by `openspec archive`, preserving history. Rewriting would lose the original spec as a baseline.

**2. Requirement ID naming for new specs**
- Decision: Continue the established pattern — domain prefix + sequential number (BROWSER-01, CRON-01, SYSTEM-01, REMOTE-01, WEBHOOK-01, PROCESS-01, SPACE-01)
- Rationale: Consistent with existing IDs (CHAT-01, DASH-01, etc.), parseable by coverage script regex

**3. Heading format**
- Decision: Use `### Requirement: FEAT-NN — Title` format (matches v2.0 conversion)
- Rationale: Passes OpenSpec validation AND is parseable by `scripts/spec-coverage.ts`

**4. Scenario depth for new specs**
- Decision: 15-30 scenarios per spec for new domains, 5-15 added scenarios per extended spec
- Rationale: Matches the density of existing specs (17-41 scenarios each). Smaller new domains (system-status, remote-access) need fewer scenarios than complex ones (remote-browser).

## Risks / Trade-offs

- **Spec drift risk** — Specs describe current behavior which may change. Mitigation: specs are living documents, updated via OpenSpec change workflow.
- **Coverage script compatibility** — New requirement IDs must match the regex. Mitigation: using established `### Requirement: ID — Title` format already validated.
- **Delta file complexity** — 6 delta files modify existing specs. Mitigation: using ADDED sections (not MODIFIED) since we're adding new requirements, not changing existing ones.
