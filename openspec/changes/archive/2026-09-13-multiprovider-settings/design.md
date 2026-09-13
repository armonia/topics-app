# Experience and execution boundaries

The primary Settings question is which model service to connect. API connections must remain visible before setup, expose a password field for replacement, explain that API usage is billed by the provider, and report connection errors without exposing the key. Advanced execution controls belong in a disclosure, not ahead of the provider list.

An API key is saved on the Topics server, scoped to that installation. Use the canonical state directory and an atomic private file (directory 0700, file 0600); public settings contain only non-secret defaults. Existing environment variables remain a fallback. Validate a new key with a non-generating models request before persistence. Updating credentials must not stop unrelated running sessions.

Chat and coding capabilities remain distinct. OpenAI API already serves streamed chat without an external program. Codex executes GPT coding tasks using an installed runtime; Topics can discover the binary bundled with the desktop app. The native Topics coding engine currently uses Anthropic and existing Claude account credentials. Selecting the native runtime does not turn every provider into a native coding agent.

For a fully CLI-free product, the recommended next architecture is a provider-neutral native tool loop with separate Anthropic and OpenAI API transports, a common permission/abort/history/usage contract, and onboarding via provider API keys. A ChatGPT subscription and API billing are separate authentication paths; do not present API-key setup as spending the subscription. A hosted browser-only product additionally needs workspace execution on a host and member-scoped authorization/usage. Those capabilities need their own acceptance tests before being advertised.
