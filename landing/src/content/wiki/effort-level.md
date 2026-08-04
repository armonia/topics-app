---
title: Effort level
definition: Effort is how hard a model is asked to think before it answers. It is set per session rather than per account, it changes both the quality and the price of a turn, and a session started from a bare shell can silently get the cheapest tier without saying so.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - prompt-caching
  - pty
---

Reasoning models expose a dial for how much thinking to spend before producing
an answer. More effort means more reasoning tokens, a slower turn and a larger
bill; less effort means a faster, cheaper answer that is worse at anything
requiring several steps held in mind at once.

It is a per-invocation setting. Nothing about your account or your plan fixes
it — whoever launches the process decides, and if nobody decides, a default
applies.

## The failure mode

The default is not always the one you would pick, and nothing tells you which
one you got. A session launched from a plain shell without the flag can fall
back to the cheapest tier, and the only symptom is that the answers are worse
than the same model gave you yesterday. You do not see a warning. You see a
model that seems to have got dumber.

This is a genuinely nasty class of bug because it inverts the usual debugging
instinct: the model is fine, the prompt is fine, and the thing that changed is a
flag you never knew was there.

## The other direction

Full effort on a task that does not need it is money set on fire. Renaming a
variable across four files does not need deep reasoning, and paying for it on
every small task is how a token budget disappears without a single expensive
turn to point at.

So the useful setting is not global. It is per unit of work: high for the task
that has to hold a design in mind, low for the mechanical sweep.

## In Topics

Effort is passed explicitly on every spawn, so a session opens at the tier you
chose rather than at whatever the environment defaults to. It is set per topic,
which means the expensive setting applies to the work that earns it and the
cheap one to the work that does not — and either way you can see which you got.
