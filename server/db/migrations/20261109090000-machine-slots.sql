-- 20261109090000-machine-slots.sql
--
-- How many cards a paired node may run at once (card cbf3b91d). NULL = the
-- default of its kind (OVERFLOW_SLOTS), so every existing row keeps behaving
-- as before. Declared by the person from the machines UI, 1 to 8.
ALTER TABLE machines ADD COLUMN slots INTEGER;
