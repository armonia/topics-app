---
title: ACP (Agent Client Protocol)
definition: >-
  A protocol that lets one interface talk to different coding agents without hard-wiring any
  of them. Where MCP standardises what an agent can reach, ACP standardises how a client and
  an agent talk to each other.
updatedDate: 2026-08-04
pillar: protocols
seeAlso:
  - mcp
  - cli-coding-agent
---

The two protocols are often confused because both have "agent" in the name and
both are about interoperability. They sit on opposite sides of the agent.

- **[[mcp]]** is between the agent and the *tools* it uses.
- **ACP** is between the agent and the *client* that displays it: the thing
  showing the conversation, the diffs and the permission prompts.

## What it is for

Without it, every editor or workspace that wants to support three agents writes
three integrations, and each one drifts. With it, the client implements one
protocol and any conforming agent can be plugged in.

The parallel with the Language Server Protocol is exact, and so is the reason it
matters: LSP is why a new language does not have to be integrated separately into
every editor.

## What flows over it

Prompts and responses, streamed. Tool calls, so the client can show what the
agent is doing rather than a spinner. Permission requests, so approval happens in
the interface rather than in a terminal the user cannot see. File operations, so
the client can present a diff instead of a wall of text.

That last pair is the practical payoff: a permission prompt you can answer with a
button, and a change you can read before accepting.

## Its limit

A protocol standardises the conversation, not the capabilities. Two agents behind
the same interface still differ in what they can do and how well; ACP means you
can switch between them without rebuilding the interface, not that the switch is
invisible.
