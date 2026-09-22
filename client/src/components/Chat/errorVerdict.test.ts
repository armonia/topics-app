import { describe, expect, test } from 'bun:test';
import { readableVerdict } from './errorVerdict';

/**
 * A verdict is a sentence, not a payload.
 *
 * Every sample below is a verbatim row from this machine's message database
 * (2026-09-22), minus the warning sign the banner strips: invented inputs would
 * only prove that the parser handles what the parser was written for.
 *
 * @covers CHAT-REL-07
 */

describe('readableVerdict', () => {
  test('keeps label, provider message and advice, and drops the braces', () => {
    const raw = 'API 401: {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}. The token could not be renewed either: run `claude` then /login once, then retry.';
    const v = readableVerdict(raw);
    expect(v.headline).toBe('API 401: OAuth access token has been revoked. The token could not be renewed either: run `claude` then /login once, then retry.');
    expect(v.headline).not.toContain('{');
    expect(v.details).toContain('"request_id": null');
  });

  test('a stream error keeps the retry count that follows the payload', () => {
    const v = readableVerdict('stream error: {"details":null,"type":"overloaded_error","message":"Overloaded"} (retried 27 times over 732s without success)');
    expect(v.headline).toBe('stream error: Overloaded (retried 27 times over 732s without success)');
    expect(v.details).toContain('overloaded_error');
  });

  test('a context-length refusal reads as the provider wrote it', () => {
    const v = readableVerdict('API 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1073758 tokens > 1000000 maximum"},"request_id":"req_011Ceh7SSPvCHaPoRn5UKh1K"}');
    expect(v.headline).toBe('API 400: prompt is too long: 1073758 tokens > 1000000 maximum');
    expect(v.details).toContain('req_011Ceh7SSPvCHaPoRn5UKh1K');
  });

  test('an OAuth refresh failure reads its description', () => {
    const v = readableVerdict('OAUTH_REFRESH_FAILED 400: {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}');
    expect(v.headline).toBe('OAUTH_REFRESH_FAILED 400: Refresh token not found or invalid');
  });

  test('a message quoting braces survives inside the payload', () => {
    const v = readableVerdict('API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.14: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_0184DyJq4mu7nwZnDTfWCSbn"},"request_id":"req_x"}');
    expect(v.headline).toContain('tool_use` ids were found');
    expect(v.details).toContain('req_x');
  });

  test('prose is left alone and gets no fold', () => {
    const raw = 'Nessuna risposta: il turno si è chiuso senza produrre niente. Il tuo messaggio è ancora qui: «Riprova» lo rimanda.'; // allow-italian: verbatim verdict row from the database
    const v = readableVerdict(raw);
    expect(v.headline).toBe(raw);
    expect(v.details).toBeNull();
  });

  test('braces that are not JSON stay in the sentence', () => {
    const raw = 'Command failed: ls ${HOME}/nope {not json}';
    const v = readableVerdict(raw);
    expect(v.headline).toBe(raw);
    expect(v.details).toBeNull();
  });

  test('an empty verdict answers empty instead of throwing', () => {
    expect(readableVerdict('')).toEqual({ headline: '', details: null, truncated: false });
  });

  test('a payload with no readable message still yields a headline', () => {
    const v = readableVerdict('API 500: {"type":"error","error":{"type":"api_error"}}');
    expect(v.headline).toBe('API 500:');
    expect(v.details).toContain('api_error');
  });
});

/**
 * THE 35 ROWS THAT ARRIVE CUT IN HALF.
 *
 * Of the 126 payload verdicts on the reference database (2026-09-22), 35 were
 * stored truncated at a fixed 309 characters, so the object never closes and
 * `JSON.parse` can never see them. They used to fall through to the
 * untouched-text branch and print the envelope raw, which is the very defect
 * this change exists to remove, just on the rows that needed it most: every
 * one of the 35 is a `tool_use`/`tool_result` pairing error, the kind you
 * cannot act on without reading the sentence.
 *
 * NOT REPAIRED, READ. Nothing here closes braces or guesses missing fields: a
 * repaired object would be a payload the provider never sent, pasted into bug
 * reports as if it had. The `message` string is lifted out with a scanner that
 * respects escapes, and the payload stays in the fold exactly as it was
 * stored, truncation included.
 *
 * @covers CHAT-REL-07
 */
describe('readableVerdict on a payload stored truncated', () => {
  // Verbatim row shape, 309 characters: the cut landed inside `request_id`,
  // so the message itself closed before it.
  const CUT_IN_REQUEST_ID = 'API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.112: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6. Each `tool_use` block must have a corresponding `tool_result` block in the next message."},"request_id":"req_011C';

  // The other shape, and the commoner one (26 of the 35): the cut landed
  // inside the message, which therefore never closes its quote.
  const CUT_INSIDE_MESSAGE = 'API 400: {"type":"error","error":{"type":"invalid_request_error","message":"messages.14: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_0184DyJq4mu7nwZnDTfWCSbn, toolu_01EVX8rHgYZQ3VNXbbXJArm2. Each `tool_use` block must have a corresponding `tool_result` block in the next me';

  test('a message that closed before the cut reads whole, with no brace', () => {
    const v = readableVerdict(CUT_IN_REQUEST_ID);
    expect(v.headline).toBe('API 400: messages.112: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6. Each `tool_use` block must have a corresponding `tool_result` block in the next message.');
    expect(v.headline).not.toContain('{');
    expect(v.headline).not.toContain('invalid_request_error');
  });

  test('the truncated payload stays in the fold, raw and whole', () => {
    const v = readableVerdict(CUT_IN_REQUEST_ID);
    expect(v.truncated).toBe(true);
    // Raw, not pretty-printed: half an object cannot be re-serialised without
    // inventing the half that is missing.
    expect(v.details).toBe('{"type":"error","error":{"type":"invalid_request_error","message":"messages.112: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01WA8ekA3YdZkzy9R79FxFk6. Each `tool_use` block must have a corresponding `tool_result` block in the next message."},"request_id":"req_011C');
  });

  test('a message cut mid-sentence still reads, and says it was cut', () => {
    const v = readableVerdict(CUT_INSIDE_MESSAGE);
    expect(v.headline).toBe('API 400: messages.14: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_0184DyJq4mu7nwZnDTfWCSbn, toolu_01EVX8rHgYZQ3VNXbbXJArm2. Each `tool_use` block must have a corresponding `tool_result` block in the next me…');
    expect(v.headline).not.toContain('invalid_request_error');
    expect(v.truncated).toBe(true);
    expect(v.details).toStartWith('{"type":"error"');
  });

  test('escapes inside a truncated message are decoded, not shown', () => {
    const v = readableVerdict('API 400: {"type":"error","error":{"message":"the field \\"name\\" is required"},"request_id":"req_01');
    expect(v.headline).toBe('API 400: the field "name" is required');
    expect(v.truncated).toBe(true);
  });

  test('a whole payload is not marked truncated', () => {
    const v = readableVerdict('API 400: {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"},"request_id":"req_x"}');
    expect(v.truncated).toBe(false);
    expect(v.details).toContain('\n'); // pretty-printed, as before
  });

  // THE GUARD. An unclosed brace in prose is prose, and the 36 brace-bearing
  // rows that are not JSON must keep printing exactly as they always did.
  test('an unclosed brace with no JSON object behind it is left alone', () => {
    const raw = 'Command failed: ls ${HOME}/nope and then {oops';
    const v = readableVerdict(raw);
    expect(v.headline).toBe(raw);
    expect(v.details).toBeNull();
    expect(v.truncated).toBe(false);
  });

  test('an unclosed object with no message key is left alone', () => {
    const raw = 'API 500: {"type":"error","request_id":"req_011C';
    const v = readableVerdict(raw);
    expect(v.headline).toBe(raw);
    expect(v.details).toBeNull();
  });
});
