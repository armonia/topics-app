-- The model survives an unbound requeue; its automatic reasoning effort must
-- survive with it or the next fresh topic falls back to the global CLI config.
ALTER TABLE tasks ADD COLUMN model_effort TEXT;
