---
title: BYOK (bring your own key)
definition: A model where the software holds no credential of its own and proxies nothing. It uses your API key or your signed-in CLI, so your prompts go straight to the model vendor and the tool never sees them, never resells inference and cannot take a margin on it.
updatedDate: 2026-08-04
pillar: cost
seeAlso:
  - subscription-vs-api-billing
  - local-first
---

The alternative is that the tool holds the key, your prompts pass through its
servers, and it bills you, usually at a markup, sometimes as "credits" that
obscure the underlying price.

BYOK removes the middle. The obvious consequence is cost. The one that matters
more is that nobody is in the path.

## Why it is a privacy claim before it is a pricing one

If a tool proxies your requests, it necessarily *can* read your prompts, which
means your code, your file paths, your secrets if you were careless. Whether it
does is a policy, and policies change with funding rounds. Whether it can is
architecture, and architecture does not change quietly.

## How to check it rather than believe it

The claim is verifiable in about a minute, which is the reason to prefer tools
that make it: watch the connections. A BYOK client talks to the model vendor and
to nothing else that carries prompt text. If there is a hop in between, it will
be on the socket.

Any claim of this shape that cannot be checked in under a minute should be read
as marketing.

## The trade-off, stated plainly

You manage the credential. There is no central place to rotate it, no
organisation-wide spend cap, no admin who can cut off a departing colleague's
access from one screen. For an individual that is a rounding error; for a company
it is exactly the reason team plans exist.
