# Ghost "queued" CI runs (2026-11)

Three runs (43098243002, 43098243186, 43098115525) stayed `queued` since 2026-11-11.

- They have 0 jobs (`actions/runs/<id>/jobs` total_count 0), so they do not count against concurrent job limits.
- `gh run cancel` answers "completed"; `force-cancel` answers 409 "not been queued yet". No API removes them.
- Only GitHub support can purge them; open a ticket with the run ids.
- Queued runs created in the last hours are normal and unrelated.
