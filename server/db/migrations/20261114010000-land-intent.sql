-- 20261114010000-land-intent.sql
--
-- tasks.land_intent: somebody decided this card's work goes to main ('human' for
-- a person's Approva/Landa, 'auto' for the automatic land), and the decision
-- outlives a red or a conflict. While it is set, a bounce back to the agent does
-- not send the card to a person again: its next green delivery re-enters the CI
-- phase by itself. A person's reject with a comment clears it.
ALTER TABLE tasks ADD COLUMN land_intent TEXT CHECK (land_intent IN ('human', 'auto'));
ALTER TABLE tasks ADD COLUMN land_intent_at TEXT;
