-- scheduled_review_minutes: how often a fresh, cheap review pass looks at the
-- technical cards sitting in review (`services/scheduled-review.ts`). NULL =
-- inherit the global row, then the default; 0 = off, which is the default.
ALTER TABLE board_workflow_rules ADD COLUMN scheduled_review_minutes INTEGER;
-- reviewer_models: JSON {primary, fallback} model ids of that review; NULL = the app's defaults.
ALTER TABLE board_workflow_rules ADD COLUMN reviewer_models TEXT;
