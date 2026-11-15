# Daily summary: overruns and waits (card cd972f2f)

The daily summary script lives outside this repo (the operator's home tooling), so this note only records the decision.

- Up to 3 extra lines in the summary of the previous day.
- Overrun: an activity whose real duration is more than 2x its estimate from the estimates registry.
- Wait: a card or session idle for more than 2 hours on something that could have been unblocked earlier, one line each with the hour.
- Nothing to report means no extra line.
- Bar: the script self-test exits 0 and covers an overrun day, a clean day and a 3 hour wait; removing the thresholds turns it red.
