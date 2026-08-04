---
title: CLI coding agent
definition: A coding agent that runs as a command-line process on your machine — Claude Code, Codex, OpenCode, Gemini CLI — rather than inside an editor or behind a web app. It reads and writes your real files with your real permissions, which is both the appeal and the risk.
updatedDate: 2026-08-04
pillar: parallel-agents
seeAlso:
  - pty
  - acp
  - subscription-vs-api-billing
---

The category emerged because the terminal already had everything an agent needs
and an editor did not: a working directory, a shell, your credentials, your
tools, and no sandbox in the way.

## What distinguishes it from an editor assistant

An editor assistant is scoped to the buffer and asks permission to touch
anything else. A CLI agent starts from the opposite premise — it has a shell, so
it can read any file, run any command, install anything, and commit.

That is why it can do end-to-end work and why it needs supervision. The
guardrails are not technical restrictions inside the tool; they are the ones you
put around it: which directory it starts in, whether that directory is a
[[git-worktree-per-agent]] or your actual checkout, and whether anything it does
reaches a remote without a human.

## The practical consequences

**It is interactive.** It redraws, prompts and takes single keypresses, which is
why driving one programmatically means a [[pty]] rather than a pipe.

**Its billing is tied to the binary.** A subscription authorises the official
CLI, not the API — see [[subscription-vs-api-billing]].

**It has its own tool set.** Whatever the installed CLI can do, it can do; a
wrapper that re-implements a subset gets a different, smaller agent.

## Why several at once is the hard part

One is easy to watch. Three is where it breaks down: they finish at different
times, two of them are waiting on a question you have not noticed, and all three
are editing the same repository. Everything difficult about this category is
downstream of that.
