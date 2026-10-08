/**
 * Terminal text as a person reads it: without colour and cursor codes.
 *
 * Moved here from ProcessLogPane on 07/10 so the chat's woken banner uses the
 * same rule: the card of a finished command showed freeagent's red error
 * codes as boxes (topic:d740f8ae). The second pass catches a code whose ESC
 * byte was already lost on the way.
 */
export const stripAnsi = (text: string) =>
  // The ESC byte is what this regex has to recognize to strip it.
  // The lint rule flags control bytes that slipped into a pattern by
  // mistake; here they are the subject.
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')
      .replace(/\[(?:\d+;)*\d*[A-HJKSTfm]/g, '');
