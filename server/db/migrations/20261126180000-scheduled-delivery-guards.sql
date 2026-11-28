-- Two guards for the delivery of a job's outcome (change lavori-programmati-in-topics, rules R23 and R26).
-- `awaiting_owner`: a job an agent created is born paused and stays "waiting for the owner" until a
-- person turns it on; while it is set the engine refuses to run it and nothing of it is delivered.
-- `deliver_since`: when the job got its `deliver` block; only runs that finished after it are delivered,
-- so adding a delivery to an old job does not send out its history.
ALTER TABLE scheduled_jobs ADD COLUMN awaiting_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled_jobs ADD COLUMN deliver_since TEXT;
UPDATE scheduled_jobs SET deliver_since = updated_at WHERE deliver_json IS NOT NULL;
