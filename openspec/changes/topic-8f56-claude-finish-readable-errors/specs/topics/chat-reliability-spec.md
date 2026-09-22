# Delta: topics / chat-reliability (topic-8f56-claude-finish-readable-errors)

Merges into `openspec/specs/topics/chat-reliability-spec.md` on archive. The
canonical file is NOT touched before then.

TWO BOUNDARIES, ONE DEFECT. A verdict reaches the reader by two different
roads, and both printed the provider's envelope verbatim:

1. the verdict already STORED on the message, which the amber banner renders
   (`CHAT-REL-07`);
2. the turn that never starts at all, where `/api/chat` answers non-ok and
   `client/src/lib/api.ts::chatApi.sendMessage` throws, and that throw IS the
   text the chat shows (`CHAT-REL-08`).

Fixing only the first would leave every refused-before-start turn exactly as
unreadable as before, which is the shape of the failure that was reported.

## ADDED Requirements

### Requirement: CHAT-REL-07 - A verdict reads as a sentence, its payload stays behind a fold

The chat SHALL show the provider's own sentence in the amber banner, and SHALL
keep the raw payload available instead of printing it or discarding it.

Measured on 2026-09-22: 126 of the 2101 verdict rows on this machine carried a
provider JSON object inline, so the one sentence that mattered sat between two
braces and a null request id. 91 of those 126 arrived whole; the other 35 were
stored truncated, cut off at a fixed 309 characters, so the object never closes
and `JSON.parse` can never see them. ALL 126 read as a sentence, by two
different routes described below. A further 36 rows carry braces that are not
JSON at all, and those SHALL keep printing exactly as they are.

#### Scenario: the provider refused with a JSON payload
- **GIVEN** a verdict reading `API 401: {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}. The token could not be renewed either: run `claude` then /login once, then retry.`
- **WHEN** the banner renders it
- **THEN** the visible sentence keeps the label, the provider message and the advice, and contains no brace
- **AND** the payload is reachable, pretty-printed, from a fold that starts closed
- **AND** the fold offers a copy of the payload

#### Scenario: a verdict that is already prose
- **GIVEN** a verdict with no JSON object in it
- **THEN** the banner prints it unchanged and shows no fold

#### Scenario: a payload stored truncated, message closed before the cut
- **GIVEN** a verdict cut at 309 characters, `API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.112: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message."},"request_id":"req_011C`
- **WHEN** the banner renders it
- **THEN** the visible sentence is the label plus the provider message, with no brace and no key name in it
- **AND** the fold holds the payload VERBATIM, cut included, and is copyable
- **AND** the fold is labelled as truncated, so nobody pastes it into a bug report believing it is the whole envelope

#### Scenario: a payload stored truncated, message cut mid-sentence
- **GIVEN** the commoner shape, 26 of the 35, where the cut fell inside the message so its quote never closes
- **THEN** the sentence is still shown, and ends with an ellipsis marking that it was cut
- **AND** a cut landing inside an escape sequence drops that half-written character rather than failing the whole read

#### Scenario: the payload is read, never repaired
- **GIVEN** any truncated payload
- **THEN** the system SHALL NOT close braces, fill in missing fields, or re-serialise the object
- **AND** the `message` string SHALL be lifted out by a scanner that respects quotes and escapes, recognising keys only where a key can structurally be, so a message quoting `"message":"` inside itself cannot hijack the read
- **AND** a truncated object that yields no readable sentence SHALL be printed untouched, as it always was

A repaired payload is a payload the provider never sent. It would be pasted
into bug reports as though it were real, which is a worse failure than the
unreadable line this requirement exists to fix.

#### Scenario: braces that are not JSON
- **GIVEN** a verdict quoting a path or a shell snippet with braces
- **THEN** the text is left alone, because guessing would eat prose
- **AND** an unclosed brace with no JSON object behind it is left alone too: the truncated-payload rule requires an object that opens with a quoted key, so prose never reaches it

### Requirement: CHAT-REL-08 - A turn refused before it starts throws a sentence, and keeps its code

`chatApi.sendMessage` SHALL open the server's refusal envelope the same way
`request()` does: the `error` field becomes the thrown message, and every other
field of the body SHALL ride on the `ApiError` so callers can branch on it.

A turn refused before it starts is never persisted, so this throw is the only
text the reader gets. It used to be `response.text()` verbatim, which is why a
503 reached the chat as an escaped JSON object.

THE COUPLED HALF, and it is not optional. `useChat` tells the two 409s apart
(`duplicate_message`, which must NOT be re-queued, from `stream_in_flight`,
which must) and it did so by searching the thrown message for the code, which
only worked while the message was the raw body. The sentence and the code are
one requirement: shipping the sentence alone re-queues a message the server has
already accepted, producing the duplicate the idempotency key exists to prevent.

#### Scenario: the provider is not connected
- **GIVEN** `/api/chat` answers 503 with `{"error":"Provider \"jcode\" is unavailable. Connect it in Settings or choose another provider.","code":"provider_unavailable","provider":"jcode"}`
- **WHEN** `chatApi.sendMessage` rejects
- **THEN** the thrown message is the provider sentence, with no brace and no escaped quote
- **AND** `status` is 503, `code` is `provider_unavailable`, and `provider` is `jcode`

#### Scenario: the server already has this message
- **GIVEN** `/api/chat` answers 409 with `{"error":"message already accepted","code":"duplicate_message","messageId":"msg_42"}`
- **THEN** the thrown error carries `code: "duplicate_message"` and `messageId: "msg_42"`
- **AND** the caller decides on the code, never on the wording of the message

#### Scenario: a body that is not JSON
- **GIVEN** a plain-text 502 from a proxy in front of the server
- **THEN** the body is thrown as it came, because it is the most informative thing available
- **AND** an empty body falls back to the HTTP status text rather than an empty banner
