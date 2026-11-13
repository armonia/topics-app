import { attribuisciMedia, type TurnToolTrace } from "./media-ownership";
import type { AppContext } from "../types";

type OutboundMessage = Parameters<AppContext["broadcastToAll"]>[0];

export interface AttachMediaOfTurnArgs {
  sessionKey: string;
  topicId: string | undefined;
  requestStartMs: number;
  toolsOfTurn: TurnToolTrace[];
  ownRow: { readonly rowId: string };
  findNewMediaFiles: (sinceMs: number) => Promise<string[]>;
  updateLastMessageWithMedia: (sessionKey: string, media: string[], opts?: { rowId?: string }) => void;
  broadcast: (message: OutboundMessage) => void;
}

/**
 * Attaches to the finished turn the media files IT named. A failure here used
 * to vanish, and the turn's pictures with it: it is reported instead.
 */
export async function attachMediaOfTurn(args: AttachMediaOfTurnArgs): Promise<void> {
  const { sessionKey } = args;
  try {
    const candidates = await args.findNewMediaFiles(args.requestStartMs);
    const { propri, altrui } = attribuisciMedia(candidates, args.toolsOfTurn);
    if (altrui.length > 0) {
      console.log(`[Media] ${sessionKey}: ${altrui.length} files discarded, not named by this turn: ${altrui.map((p) => p.split("/").pop()).join(", ")}`);
    }
    if (propri.length > 0 && sessionKey) {
      args.updateLastMessageWithMedia(sessionKey, propri, args.ownRow);
      args.broadcast({ type: "message:media", sessionKey, topicId: args.topicId, media: propri });
    }
  } catch (e) {
    console.warn(`[Media] ${sessionKey}: attaching the media of the turn failed:`, e);
  }
}
