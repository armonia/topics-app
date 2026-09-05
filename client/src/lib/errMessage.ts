/**
 * The sentence to show a person for something that was thrown.
 *
 * `request()` in `lib/api.ts` rejects with an `ApiError` whose `message` is
 * already the server's own `error` field, so this is what puts the server's
 * words into a toast instead of a generic "something went wrong". It was
 * copy-pasted into five components before it lived anywhere; the chat surfaces
 * import it from here, the older copies are debt to migrate one file at a time.
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
