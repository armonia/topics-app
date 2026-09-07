/**
 * THE BOOT SWEEP ONLY OWES SOMETHING TO THE TOPICS STILL OPEN.
 *
 * On the production database 98% of the rows the boot sweeps belong to archived
 * topics, and the "running" tools they carry are persistent false positives:
 * the sweep is idempotent, so anything real there would already have been
 * closed. Reading them cost seconds of blocked event loop and a gigabyte of
 * decoded blobs, and the HTTP listener was already up by then.
 *
 * BLACKLIST, NOT WHITELIST. `archived = 0` would silently drop a session whose
 * `topics` row does not exist yet, and its spinner would spin forever. Only
 * what is KNOWN archived is excluded. The two NULL guards are not decoration:
 * `NULL NOT IN (...)` is NULL (falsy), so a message without a session key, or
 * a single archived topic row without one, would empty the whole scan.
 *
 * The clause is shared so the tests bind to the SQL that actually runs.
 */
export const NOT_ARCHIVED_SQL =
  `(session_key IS NULL OR session_key NOT IN
    (SELECT session_key FROM topics WHERE archived = 1 AND session_key IS NOT NULL))`;
