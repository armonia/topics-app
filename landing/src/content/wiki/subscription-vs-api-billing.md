---
title: Subscription vs API billing
definition: >-
  Two different ways to pay for the same model, and they are not interchangeable. A
  subscription authorises the vendor's own CLI or app; the API bills per token against a key.
  Nothing bridges them, which is why a tool that wants to use your plan must run the real
  binary.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - byok
  - pty
  - cli-coding-agent
---

**A subscription** is a monthly price for using the vendor's client (their app,
their CLI) with usage limits expressed in vaguer terms than tokens. **API
billing** is per-token against a key, metered exactly, with no monthly floor.

They are separate products that happen to reach the same models.

## The consequence that decides architecture

There is no HTTP endpoint that accepts a subscription. The plan authorises the
official client; the API authorises a key. So any third-party tool faces a fork:

- Use the **API** and the user pays per token, on top of any subscription they
  already have, which for a heavy user can be several times the monthly price.
- Drive the **official CLI** as a subprocess and inherit the subscription, which
  means owning a [[pty]], because the CLI is an interactive terminal program.

The second is more work and it is the only one that lets someone use the plan
they are already paying for.

## Practical differences beyond price

A subscription's limits are usually per-window and opaque; you find them by
hitting them. API keys have quotas and rate limits you can read. A subscription
usually cannot be shared across a team; keys can be issued per person and
revoked.

## What neither changes

Where your prompts go. Both send them to the model vendor. What differs is who
sits between you and them: with [[byok]] and a locally-run client, nobody.
