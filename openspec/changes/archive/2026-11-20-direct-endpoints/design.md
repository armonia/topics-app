# Design — configurable OpenAI-compatible endpoints

## Persistence, and why not in the database
`<STATE_DIR>/direct-endpoints.json`, written tmp + rename. No migration, no schema
change, and a corrupt file degrades to "no configured endpoints" instead of blocking boot.

The bearer secret does NOT go in `.topics-secrets/providers.json`: that file's reader
rebuilds the object with the `openai` and `claude` keys only, so the first key save after
an endpoint was added would silently drop it. Secrets live in a sibling file of their own,
`.topics-secrets/direct-endpoints-secrets.json`, mode 0600, keyed by endpoint id.

Validation (id/slug shape, URL, auth mode, model filter, timeout) is a pure module under
`shared/`, so the client can refuse a bad form before the round trip and the server can
refuse a hand-edited file with the same rules.

## Name
`direct-<slug>`, slug from the label, `[a-z0-9-]` only. No `:` — provider names travel
inside composite keys elsewhere and a colon would split them.

## Wire
`server/providers/openai-wire.ts` gets what is generic today inside `openai.ts`: SSE
consumption and request body assembly. `OpenAICompatibleProvider` is parametric over
name, label, base URL, auth (`none` | `bearer`), model filter, timeout and whether to ask
for `stream_options.include_usage` (llama-server accepts it; some gateways reject it).
`openai.ts` keeps its class but delegates to the wire, staying one instance among others.

## URL guard
A NEW function, not `isSafePublicUrl`: that one exists to keep the framing browser OUT of
the private network, and here the private network is exactly the point. The new guard
allows loopback, RFC1918, 100.64/10 (Tailscale) and fc00::/7; it blocks 169.254/16 (cloud
metadata), fe80::/10, 0/8 and multicast; it refuses userinfo in the URL; it resolves DNS
on every request, not once at save time; and it re-checks every hop with `redirect:
"manual"`. Table-driven test.

## Per-model context window
`ProviderSnapshotEntry.modelContextWindows` carries the window per model id, taken from
the endpoint config and from `/v1/models` (`meta.n_ctx`). The picker and the context
assembler read it BEFORE the static table, otherwise a 200k local model shows the
fallback badge. An upstream "context size exceeded" is translated into a sentence that
names the window and the model instead of the raw upstream string.

## Bloat
Everything new lands in new modules. The four frozen files are not touched beyond, at
most, a single delegating line each.
