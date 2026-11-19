/**
 * THE BOOT SWEEP ONLY OWES SOMETHING TO THE TOPICS STILL OPEN, AND TO THE ONES
 * ARCHIVED JUST NOW.
 *
 * On the production database 98% of the rows the boot sweeps belong to archived
 * topics, and the "running" tools they carry are persistent false positives:
 * the sweep is idempotent, so anything real there would already have been
 * closed. Reading them cost seconds of blocked event loop and a gigabyte of
 * decoded blobs, and the HTTP listener was already up by then.
 *
 * THE EXCEPTION IS THE RECENTLY ARCHIVED. A chat archived WHILE one of its tools
 * was running (native sub-agent chats archive themselves at the end of their
 * turn) was never swept again, and its spinner stayed forever. So an archived
 * topic stays in scope for `ARCHIVED_GRACE_DAYS` after its retirement
 * (`retirements.retired_at`, indexed): enough to cover any restart gap, and the
 * first boot after the sweep has run closes the tools, so the row leaves the
 * scan for good (idempotent).
 *
 * BLACKLIST, NOT WHITELIST. `archived = 0` would silently drop a session whose
 * `topics` row does not exist yet, and its spinner would spin forever. Only
 * what is KNOWN archived (and not recent) is excluded. The two NULL guards are
 * not decoration: `NULL NOT IN (...)` is NULL (falsy), so a message without a
 * session key, or a single archived topic row without one, would empty the
 * whole scan.
 *
 * The clause is shared so the tests bind to the SQL that actually runs.
 */
export const ARCHIVED_GRACE_DAYS = 7;

export const NOT_ARCHIVED_SQL =
  `(session_key IS NULL OR session_key NOT IN
    (SELECT session_key FROM topics WHERE archived = 1 AND session_key IS NOT NULL
       AND id NOT IN (SELECT ref_id FROM retirements
                      WHERE kind = 'topic' AND retired_at >= datetime('now', '-${ARCHIVED_GRACE_DAYS} days'))))`;
