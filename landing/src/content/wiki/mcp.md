---
title: MCP (Model Context Protocol)
definition: A protocol for exposing tools, data and prompts to an AI agent over a standard interface, so a capability written once can be used by any client that speaks it. The interesting question it raises is not transport. It is who decides which tools an agent can see.
updatedDate: 2026-08-04
pillar: protocols
seeAlso:
  - mcp-scoping
  - acp
---

Before a standard existed, every agent had its own way of being given a tool, so
a capability had to be re-implemented for each one. MCP fixes that: a server
advertises tools, resources and prompts; a client connects and passes them to the
model.

## The three things a server offers

**Tools** the model can call. **Resources** it can read. **Prompts**, which are
templates a user can invoke. Most servers in practice are tools and little else.

## Where the real design question lives

Standardising the transport was the easy part. The hard part is *scope*: an agent
with thirty tools available is worse than one with six, because every tool is
context it pays for on every turn and one more chance to pick the wrong one.

So the operational question is not "can this agent use MCP" but "which servers is
this particular session allowed to see", which is [[mcp-scoping]], and is
usually configured badly by default.

## Both directions

A tool can *consume* MCP servers, and it can *be* one. The second is the more
interesting direction for a workspace: it means another agent can drive it: create a task, open a browser pane, ask the user a typed question — rather than
only being driven by a person.

Topics both mounts MCP servers for its sessions and exposes its own, so an agent
can operate the workspace itself.
