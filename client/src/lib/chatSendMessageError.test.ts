/**
 * THE OTHER PLACE A VERDICT IS BORN: the chat's own HTTP boundary.
 *
 * `readableVerdict` cleans up what is already STORED. But a turn that never
 * starts never gets stored: `/api/chat` answers non-ok, `chatApi.sendMessage`
 * throws, and `useChat` writes `err.message` straight into the banner. That
 * message was the raw response body, so a 503 reached the reader as
 *
 *   {"error":"Provider \"jcode\" is unavailable...","code":"provider_unavailable"}
 *
 * escaped quotes included, while the sibling helper `request()` twenty lines
 * above had been extracting `error` correctly for years.
 *
 * THE TRAP THIS FILE GUARDS. `useChat` tells its two 409s apart with
 * `err.message.includes('duplicate_message')`, which only ever worked because
 * the message WAS the JSON. Making the message human without carrying `code`
 * would re-queue a message the server already has, which is the duplicate the
 * idempotency key exists to prevent. So the sentence and the code are one
 * requirement, not two.
 *
 * @covers CHAT-REL-08
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { chatApi, ApiError, apiErrorCode } from './api';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A non-ok `/api/chat` answer, exactly as the server writes it. */
function serverAnswers(status: number, body: string, statusText = ''): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, statusText })) as unknown as typeof fetch;
}

const CHAT_REQUEST = { sessionKey: 'topic:8f56abcd', messages: [] };

describe('chatApi.sendMessage on a non-ok answer', () => {
  test('a 503 throws the provider sentence, not the payload', async () => {
    serverAnswers(
      503,
      JSON.stringify({
        error: 'Provider "jcode" is unavailable. Connect it in Settings or choose another provider.',
        code: 'provider_unavailable',
        provider: 'jcode',
      }),
    );

    const err = await chatApi.sendMessage(CHAT_REQUEST).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ApiError);
    const api = err as ApiError;
    expect(api.message).toBe(
      'Provider "jcode" is unavailable. Connect it in Settings or choose another provider.',
    );
    // The two shapes a reader must never see: the envelope and its escapes.
    expect(api.message).not.toContain('{');
    expect(api.message).not.toContain('\\"');
    expect(api.message).not.toContain('"code"');
  });

  test('the 503 keeps code and details, which the UI and the retry read', async () => {
    serverAnswers(
      503,
      JSON.stringify({
        error: 'Codex is unavailable for the global coordinator',
        code: 'codex_unavailable',
      }),
    );

    const api = (await chatApi.sendMessage(CHAT_REQUEST).catch((e: unknown) => e)) as ApiError;
    expect(api.status).toBe(503);
    expect(api.code).toBe('codex_unavailable');
  });

  test('a 409 duplicate carries its code, which is how the retry knows not to re-queue', async () => {
    serverAnswers(
      409,
      JSON.stringify({
        error: 'message already accepted',
        code: 'duplicate_message',
        messageId: 'msg_42',
      }),
    );

    const api = (await chatApi.sendMessage(CHAT_REQUEST).catch((e: unknown) => e)) as ApiError;
    expect(api.status).toBe(409);
    expect(api.code).toBe('duplicate_message');
    expect(api.messageId).toBe('msg_42');
  });

  test('the code survives the whole trip, which is what useChat branches on', async () => {
    serverAnswers(
      409,
      JSON.stringify({ error: 'message already accepted', code: 'duplicate_message' }),
    );
    const err = await chatApi.sendMessage(CHAT_REQUEST).catch((e: unknown) => e);
    expect(apiErrorCode(err)).toBe('duplicate_message');
    // And the sentence no longer answers that question, which is the point:
    // the old detection read the body text and would silently go false here.
    expect((err as ApiError).message).not.toContain('duplicate_message');
  });

  test('a body that is not JSON is passed through as it came', async () => {
    serverAnswers(502, 'upstream closed the connection');
    const api = (await chatApi.sendMessage(CHAT_REQUEST).catch((e: unknown) => e)) as ApiError;
    expect(api.message).toBe('upstream closed the connection');
    expect(api.status).toBe(502);
  });

  test('an empty body falls back to the status text instead of an empty banner', async () => {
    serverAnswers(500, '', 'Internal Server Error');
    const api = (await chatApi.sendMessage(CHAT_REQUEST).catch((e: unknown) => e)) as ApiError;
    expect(api.message).toBe('Internal Server Error');
  });
});
