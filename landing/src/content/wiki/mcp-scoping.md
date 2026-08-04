---
title: MCP scoping
definition: Restricting which MCP servers a given session can see. It matters because every tool an agent is offered costs context on every turn and adds one more way to pick the wrong thing — and because inherited configuration is the usual reason an agent has tools nobody meant to give it.
updatedDate: 2026-08-04
pillar: protocols
seeAlso:
  - mcp
  - agent-turn
---

MCP configuration is normally layered: something global, something per project,
something per session. The layers merge, and the merged result is what the agent
gets — which is how a session ends up with a database tool, a deploy tool and a
messaging tool when it was asked to fix a typo.

## The two costs

**Tokens.** Tool definitions live in the context and are re-sent every turn. A
dozen servers is a standing charge on every message in the session, paid whether
or not any of them is used. See [[agent-turn]].

**Judgement.** More options make a worse chooser. An agent with one way to search
uses it; an agent with four picks badly, and the wrong pick is often the one that
takes an action instead of reading something.

## The blast radius

The uncomfortable case is not cost, it is capability. A session spawned to
summarise a file does not need the tool that can send a message or the one that
can write to production, and if it has them, then a prompt injection in the file
it was asked to read now has them too.

## The rule

Start each session from an explicit set rather than from whatever the environment
merged together, and make it easy to say "this one, nothing else" — most clients
support exactly this and almost nobody uses it.

## In Topics

Sessions are spawned with an explicit configuration rather than inheriting the
ambient one, so a session gets the servers its work needs and no others.
