-- 20261110192117-overflow-skip-machine.sql
--
-- The node an empty run came back from, and until when the overflow skips it.
-- Before, the card was pinned to this Mac for 6 hours instead: under the memory
-- floor it then waited there while another node was online (10/11, five cards).
ALTER TABLE tasks ADD COLUMN overflow_skip_machine TEXT;
ALTER TABLE tasks ADD COLUMN overflow_skip_until TEXT;
