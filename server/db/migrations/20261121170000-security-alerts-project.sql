-- The board that receives a card when a machine's security check goes red; NULL = no cards.
ALTER TABLE app_settings ADD COLUMN security_alerts_project_id TEXT;
