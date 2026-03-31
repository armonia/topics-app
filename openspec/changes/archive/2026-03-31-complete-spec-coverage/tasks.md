## 1. New Specs — High Priority

- [ ] 1.1 Archive change specs into main openspec/specs/ via `openspec archive complete-spec-coverage`
- [ ] 1.2 Validate all specs pass `openspec validate --specs`
- [ ] 1.3 Verify coverage script detects all new requirement IDs (BROWSER-01/02, CRON-01, SYSTEM-01, REMOTE-01, WEBHOOK-01, PROCESS-01, SPACE-01)

## 2. Delta Specs — Extend Existing

- [ ] 2.1 Verify delta specs merge cleanly into existing specs (DASH-02/03, FILE-03, CHAT-05, CMD-02, AGENT-03, KANBAN-03/04)
- [ ] 2.2 Validate extended specs still pass `openspec validate --specs` after archive

## 3. Coverage Integration

- [ ] 3.1 Run `bun scripts/spec-coverage.ts` and confirm all new requirement IDs appear
- [ ] 3.2 Update coverage matrix documentation with new requirement counts

## 4. Test Annotation Prep

- [ ] 4.1 Identify existing tests that cover new requirement areas (browser, cron, system, etc.)
- [ ] 4.2 Add spec annotations to any existing tests matching new requirements
