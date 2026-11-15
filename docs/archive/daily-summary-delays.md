# Daily summary: overruns and waits (card cd972f2f)

The daily summary script lives outside this repo (the operator's home tooling). Decision recorded here only.

- Adds at most 3 lines after the per-project totals.
- Overrun: real duration above 2x the estimate from the estimates registry.
- Wait: a session blocked for 2 hours or more (waiting for an answer, or stalled), with its start hour.
- A day with neither adds nothing. No new messages: it only appears where the summary already appears.
- Bar: the script's selftest covers an overrun day, a clean day and a 3 hour wait; removing the thresholds turns it red.
