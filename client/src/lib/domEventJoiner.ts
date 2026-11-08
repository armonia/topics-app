import { parseBrowserWsMessage } from '../../../shared/browser-ws-messages';
import { BrowserWsChunkAssembler, type BrowserWsChunk } from '../../../shared/browser-ws-chunks';

/**
 * Puts a large mirror event back together from the pieces the server sends it in
 * (NATIVE-HOST-05): the whole event once the last piece is in, `undefined` before.
 * The joined text goes through the same schema as a single `dom_event` frame.
 */
export function createDomEventJoiner(): (piece: BrowserWsChunk) => unknown {
  const assembler = new BrowserWsChunkAssembler();
  return (piece) => {
    const text = assembler.add(piece);
    if (text === null) return undefined;
    try {
      const complete = parseBrowserWsMessage(JSON.parse(text));
      return complete.ok && complete.data.type === 'dom_event' ? complete.data.event : undefined;
    } catch { return undefined; }
  };
}
