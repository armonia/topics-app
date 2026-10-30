-- 20261030181324-dispatch-overflow.sql
--
-- Il prefisso è un timestamp UTC (YYYYMMDDHHMMSS), non un contatore: è quello
-- che rende impossibile la collisione fra card in parallelo. Non rinominarlo.
--
-- Scrivi qui SOTTO cosa cambia e perché. Poi:
--   bun run scripts/gen-migrations-manifest.ts   (se hai toccato il nome)
--   bun run check:migrations


--
-- Overflow dispatch: a card held by THIS machine's memory floor for more than
-- two minutes moves to another online machine (Cloud Claude, then a paired
-- node). On 30/10/2026 three cards sat behind the Mac's floor while the PC and
-- the cloud were online and the floor does not apply to them.
--
-- board_settings.dispatch_overflow: the board's switch, ON by default.
ALTER TABLE board_settings ADD COLUMN dispatch_overflow INTEGER NOT NULL DEFAULT 1;
-- board_settings.dispatch_stay_local: every card of this board touches the Mac
-- itself (local processes, OpenClaw, sessions, macOS) and never moves.
ALTER TABLE board_settings ADD COLUMN dispatch_stay_local INTEGER NOT NULL DEFAULT 0;
-- tasks.stay_local: the same explicit mark on one card. An explicit flag, not a
-- heuristic on the text: a guess that sends a macOS card to the cloud fails there.
ALTER TABLE tasks ADD COLUMN stay_local INTEGER NOT NULL DEFAULT 0;
-- tasks.overflowed_at: when the dispatcher moved the card off this machine. The
-- chip reads it to say where it went and why; a person choosing a machine clears it.
ALTER TABLE tasks ADD COLUMN overflowed_at TEXT;
-- tasks.base_branch: on a node's MIRROR card, the branch its worktree is born
-- from (the origin card's own delivery branch, already on origin). NULL = main,
-- as always. Without it a card sent back after a review and moved to another
-- machine restarted from main and conflicted with its own commits (df5fd8c5).
ALTER TABLE tasks ADD COLUMN base_branch TEXT;
