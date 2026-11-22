/**
 * Where the channel bridge's own database lives (read-only, another repo's
 * data). Split out from `../routes/agent-channels` so both that route and
 * `./channel-place` can import the path without the two files importing each
 * other (a route that reads places and a service that resolves them).
 */
import { homedir } from "os";
import { join } from "path";

export function channelsDbPath(env: Record<string, string | undefined> = process.env): string {
  return env.JARVIS_CHANNELS_DB?.trim() || join(homedir(), "Library", "Application Support", "jarvis-channels", "channels.sqlite");
}
