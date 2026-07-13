-- "Priorità automatica": 1 = nobody chose a priority explicitly — the
-- dispatched agent is asked to evaluate and set one at kickoff. Any explicit
-- priority write (human composer/drawer, or an agent update) flips it to 0.
ALTER TABLE tasks ADD COLUMN priority_auto INTEGER NOT NULL DEFAULT 1;
