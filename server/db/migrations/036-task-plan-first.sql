-- 036: plan-first dispatch flag (floating board composer).
-- A task created with plan_first=1 instructs the dispatched agent to deliver
-- a short PLAN to review (question block) BEFORE implementing anything; the
-- human approves the plan and the same agent resumes into implementation.
ALTER TABLE tasks ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0;
