# Overnight private message left unanswered (card 24fd3612)

Cause, read from the channel service log and the Switchboard activity log:

1. At the time of the first message every subscription account was exhausted, and the paid API keys used as the last
   resort had no credit left (HTTP 400 "credit balance is too low").
2. The channel service correctly opened a quota block and held the message, but the block's end time was only an
   estimate (30 min). Held messages waited for that estimate; the block ended early only when a second message tried
   and succeeded ten minutes later.

Fix (in the channel service, not in this repo): while a block has an estimated end, the oldest held owner message is
re-sent as a probe every 3 minutes, without counting as a retry. Recovery is detected within minutes instead of at the
estimate. The API credit still has to be topped up by whoever owns the account.
