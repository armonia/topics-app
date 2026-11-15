# Daily summary: overruns and waits (card cd972f2f)

The morning-brief daily summary is produced by an out-of-repo script (the
"work day in the calendar" job). It now appends at most 3 extra lines:

- activities that ran more than 2x their logged estimate;
- waits or stalls over 2 hours (review without a look, stopped on a limit,
  unanswered question), one line each with the time.

A day with no overrun and no wait adds nothing. Bar: the script's `--selftest`
exits 0 (overrun day, clean day, 3 hour wait); removing the thresholds turns
it red. No code of this repo changed.
