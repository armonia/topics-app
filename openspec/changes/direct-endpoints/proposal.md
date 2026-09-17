# Configurable OpenAI-compatible endpoints for chats

## Goal
Let whoever uses the app add their own OpenAI-compatible HTTP endpoints (llama-server, vLLM, LM Studio, a remote gateway) in Settings and pick them for CHATS, without touching the two built-in API providers.

## Scope
Endpoints are declared in Settings, persisted outside the database, registered as regular chat providers named `direct-<slug>`, and offered in the chat provider/model picker. The OpenAI transport is factored into a reusable wire module so both the built-in `openai` provider and the configurable ones share one code path.

Out of scope, deliberately: the Kanban task pickers. MP-TASK-01 requires coding-capable runtimes, and this transport does one completion round with no file/bash tools and no board access, so a card dispatched on it could never close. Running the board on a local model is a separate decision (ACP with a jcode profile is the short road).

## Acceptance bar
- Unit: URL guard table, endpoint store round-trip, wire module. The 8 existing `openai.test.ts` tests stay green unchanged.
- E2E: add / test / delete an endpoint in Settings; a chat against a stubbed endpoint (`page.route`) covering streaming, abort and usage; an explicit test that no `direct-*` provider appears in the task pickers.
- Live probe against a real llama-server on the LAN, with one warm-up request before the measurement.
- The seven code gates green; no bloat added to the frozen files (`agent-loop.ts`, `native/provider.ts`, `chat.ts`, `task-dispatcher.ts`).

## Verification

Unit, merged tree, `bun test` on the ten touched modules: 139 pass / 0 fail. The
8 `openai.test.ts` tests are in that run and were not edited.

Mutation, to show the guards are actually load-bearing rather than merely
present. Four breaks in the SOURCE, each one killing a test:

| break | test that died |
| --- | --- |
| `169.254.0.0/16` dropped from `isForbiddenEndpointIpv4` | 4, incl. "a redirect towards the metadata address is refused before it is followed" |
| `redirect: "manual"` → `"follow"` in `fetchCheckedEndpoint` | the same redirect test (the per-hop re-check is the only thing holding it) |
| `contextWindowFor` stops reading the declared registry | "a window the provider declared wins over the default the table falls back on": got 1.000.000, wanted 200.192 |
| `capabilities.includes('coding-tasks')` → `true` | 2 of the task-picker boundary tests |

Gates: the 18 static rails of the CI `check` step, green on the merged tree;
`typecheck` exit 0.

Bundle: **no raise needed any more.** The +363 byte bump this branch carried was
measured on the 14/09 baseline (435.937 gz), and on 17/09 main realigned that
ratchet to a real build (444.684 gz measured on the CI runner). Against main's
number the eager entry builds at 445.144 gz here, i.e. ~460 byte for the feature
against ~8.900 of headroom, so the branch's raise was dropped and
`check:bundle` passes on main's baseline untouched.

### Still open
Step 9 of `tasks.md`, the live probe against the LAN llama-server, is NOT
done. Everything above proves the transport against a fake OpenAI-compatible
server on loopback; nothing here has spoken to a real llama-server. That is the
one claim in the acceptance bar that remains unmeasured.
