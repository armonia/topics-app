# OpenClaw AGENTS.md size analysis — 2026-10

## Context

AGENTS.md is the startup context for the OpenClaw gateway agent.
Hard limit: 20,000 characters (agents-doctor exits 1 above the limit).
Current state at analysis time: 19,144 chars (96.7% of limit).

## Section breakdown

| % | Chars | Section |
|---|---|---|
| 27.0% | 5171 | Chat dal vivo (live-chat rules) |
| 15.8% | 3017 | Finisci o schedula (async scheduling) |
|  9.4% | 1806 | Anticipa e chiudi (anticipation rules) |
|  9.1% | 1741 | Discord IDs |
|  7.6% | 1464 | External vs Internal |
|  6.7% | 1281 | Red Lines |
|  5.3% | 1023 | Memory |
|  5.3% | 1018 | Group Chats |
|  3.9% |  745 | Tools |

## Duplicates found in OPS-ATTILIO.md

`OPS-ATTILIO.md` has a §"Dettagli spostati da AGENTS.md (11/10)" of 5,073 chars
with detailed versions of:
- Registrations and browser procedure (1,282 chars) — AGENTS.md keeps 1,238 chars
  of the same content under External vs Internal.
- Group chats extended guide — AGENTS.md retains ~400 chars of summary.
- Discord: how to find IDs not in the list.

## Proposed cuts (needs owner approval before applying)

| Label | Section | Current | After | Saving | Method |
|---|---|---|---|---|---|
| A1 | External/Internal browser block | 1238c | 280c | **−958c** | Already in OPS; compress to 3-line rule |
| A4 | Finisci: risveglio paragraph | 1120c | 650c | **−470c** | Keep rule + critical notes; flags to OPS |
| A2 | Chat dal vivo: lavori-watch | 695c | 200c | **−450c** | Keep rule only, cut script description |
| A5 | Finisci: cron-when flags | 619c | 280c | **−200c** | Keep `--free any`; flag list to OPS |
| A3+B1 | Chat punto 5: diario+remindctl | 380c | 80c | **−300c** | Commands to OPS, keep rule |

**Total: −2,508c → 16,636c (83% of limit, buffer ~3,364c)**

## What not to cut

- Discord IDs: needed on every Discord message — cannot move to OPS
- Red Lines: security rules, justified density
- Memory write rules: used every session
- Dev, Subagent, Come scrivere: too small to matter

## Detailed study

Full analysis with context: `~/.openclaw/memory/studio-agents-md-dieta-2026-10-26.md`
