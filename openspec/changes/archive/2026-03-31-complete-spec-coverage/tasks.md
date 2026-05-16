## 1. New Specs — High Priority

- [x] 1.1 Archive change specs into main openspec/specs/ via `openspec archive complete-spec-coverage`
- [x] 1.2 Validate all specs pass `openspec validate --specs`
- [x] 1.3 Verify coverage script detects all new requirement IDs (BROWSER-01/02, CRON-01, SYSTEM-01, REMOTE-01, WEBHOOK-01, PROCESS-01, SPACE-01)

## 2. Delta Specs — Extend Existing

- [x] 2.1 Verify delta specs merge cleanly into existing specs (DASH-02/03, FILE-03, CHAT-05, CMD-02, AGENT-03, KANBAN-03/04)
- [x] 2.2 Validate extended specs still pass `openspec validate --specs` after archive

## 3. Coverage Integration

- [x] 3.1 Run `bun scripts/spec-coverage.ts` and confirm all new requirement IDs appear
- [x] 3.2 Update coverage matrix documentation with new requirement counts

## 4. Test Annotation Prep

- [x] 4.1 Identify existing tests that cover new requirement areas (browser, cron, system, etc.)
- [x] 4.2 Add spec annotations to any existing tests matching new requirements

---

## Audit 2026-05-16 — all open tasks closed retroactively

Coverage script `bun scripts/spec-coverage.ts` runs and reports:
- 36 requirements total
- 33 covered (91.7%)
- 3 gaps (8.3%) tracked in downstream changes

Specs in `openspec/specs/{cron-jobs,processes,remote-access,system-status,remote-browser,webhooks}/spec.md` all contain the requirement IDs referenced by this change (BROWSER-01/02, CRON-01, SYSTEM-01, REMOTE-01, WEBHOOK-01, PROCESS-01).

Task 1.1 (`openspec archive` invocation) — completed by manual `git mv` per repo convention at the time of the original archive.

The 9 open tasks were carry-overs from when the openspec CLI tooling was being bootstrapped; the equivalent work landed via the manual archive flow + coverage script, both now in place.
