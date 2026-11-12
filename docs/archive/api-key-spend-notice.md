# API-key spend notice (card c13102d3)

The model proxy (hub-service, :3336) falls back to a paid API key when no subscription can serve a request.
That spend used to reach only its own log. Since jarvis commit e3a7865d the first fallback of each 30-minute
window posts one "Ti aspetta" entry (`tipo: spesa`, `key: api-key-fallback`, key name and caller) to
`/api/attesa`; a failed post is logged and never fails the request. The fallback itself stays on.
The code and its test (`tests/api_key_notice.rs`, with fake-anthropic) live in the jarvis repo, not here.
