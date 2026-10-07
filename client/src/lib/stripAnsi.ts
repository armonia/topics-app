/**
 * Terminal text as a person reads it: without colour and cursor codes.
 *
 * Moved here from ProcessLogPane on 07/10 so the chat's woken banner uses the
 * same rule: the card of a finished command showed freeagent's red error
 * codes as boxes (topic:d740f8ae). The second pass catches a code whose ESC
 * byte was already lost on the way.
 */
export const stripAnsi = (text: string) =>
  // Il byte ESC è ciò che questa regex deve riconoscere per poterlo togliere.
  // La regola serve a intercettare i byte di controllo finiti in un pattern per
  // sbaglio; qui sono il soggetto.
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, '')
      .replace(/\[(?:\d+;)*\d*[A-HJKSTfm]/g, '');
