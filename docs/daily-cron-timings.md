# Daily cron timings (card cd972f2f)

The daily-summary job now reports how the day was spent, not only how long:
longest block, fragmented day (most blocks of 30 min or less), daytime gaps of
3 h or more, repeated short returns to the same project, late start.

The code lives outside this repository, in the assistant's own daily-calendar
script (`--dry-run` prints a `tempi:` line per finding, exit 0). This note only
records the decision.
