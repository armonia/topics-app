# Night DM unanswered: quota hold (card 24fd3612)

Cause: with every Claude account exhausted and the fallback API keys out of
credit (HTTP 400), the quota hold kept the oldest private message until the
estimated reset time, so repeated "are you there" pings went unanswered.

Cure (lives in the channels gateway repo, not here): while the hold has only an
estimated end, the oldest held message is used as a probe every 3 minutes, so
the hold lifts as soon as quota is back.
