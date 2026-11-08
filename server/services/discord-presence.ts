/**
 * The Discord status, published by Topics.
 *
 * ── WHAT IT REPLACES ────────────────────────────────────────────────────────
 * A separate daemon (`~/Projects/claude-discord-presence`, launchd) that every
 * 15s ran `ps`, counted the `claude` processes, sampled their CPU delta for one
 * second and from there GUESSED how many sessions were working. It had two
 * structural errors, not calibration ones: it counted processes that are not
 * working sessions, and it did not see the chats over the API, which launch no
 * process at all. Topics does not guess - it knows which turns it is streaming
 * and which tasks the board has in hand.
 *
 * ── WHY THE SERVICE IS A STATE MACHINE AND NOT A `setInterval` ──────────────
 * There are three things that can be different on every round: the switch, the
 * wire to Discord, and what there is to say. Keeping them in a single tick
 * means that turning the switch off CLEARS the presence (rather than leaving it
 * stale), that a closed Discord is not an error but a state you get out of by
 * yourself, and that a wrong Application ID does not produce a storm of
 * attempts: that failure does not pass with time, so we slow down.
 *
 * ── NOTHING IS GLOBAL IN HERE ───────────────────────────────────────────────
 * Snapshot, settings, connector and clock all arrive injected: the test runs
 * the service against a fake Discord in tmpdir and against a hand-written
 * snapshot, touching neither the DB nor the real app. The singleton - which is
 * needed, because there is only one wire per process - sits at the bottom, and
 * is ten lines long.
 */

import type {
  DiscordConnectionState,
  DiscordDetailLevel,
  DiscordPresenceStatus,
  OutputLanguage,
} from "../../shared/types";
import {
  DiscordIpcError,
  handshake,
  netConnector,
  onActivityAck,
  sendActivity,
  type IpcConnector,
  type IpcSocket,
} from "./discord-ipc";
import { buildActivity, type DiscordActivity, type PresenceSnapshot } from "./discord-activity";

/**
 * The Discord Application ID the card shows up under.
 *
 * It is not a secret - it is public by construction, it sits in the client of
 * anyone who sees your presence - so it lives in the code and not among the
 * keys. The env var is for whoever wants their own app (the name at the top of
 * the card is the application's, so whoever does not use ours will see theirs
 * written there).
 */
export const DEFAULT_CLIENT_ID = "1467514747988611174";

/** The card's large image. A direct URL: recent clients resolve it without
 *  having to upload an art asset in the Developer Portal. */
/**
 * The presence's large image.
 *
 * NOTHING NEEDS TO BE UPLOADED ON THE PORTAL: the opposite used to be written
 * here, and it was false. The previous version of this comment claimed that
 * Discord honours an external `large_image` only for apps that already have a
 * Rich Presence asset uploaded. Asking the IPC directly (24/08), with the
 * application at ZERO assets:
 *
 *   - this URL is ACCEPTED and Discord rewrites it as
 *     `mp:external/<hash>/https/raw.githubusercontent.com/...`, that is, it
 *     took charge of it and proxied it on its own CDN;
 *   - that address, asked of `media.discordapp.net`, answers 200 with the right
 *     128x128 PNG (5,351 bytes, the two white clouds on blue);
 *   - a made-up key (`chiave_che_non_esiste`) disappears from the reply  allow-italian: the key sent to Discord, quoted verbatim
 *     instead, and so does the hash of the application icon: that field wants
 *     an ASSET key, which is another thing entirely.
 *
 * The negative control is the part that counts: if Discord discarded external
 * URLs, this field would disappear the way the made-up key disappears. It
 * stays, so it holds.
 *
 * The "T" you see in the panel's preview is another matter: that is the
 * PREVIEW drawn by us, not Discord's card.
 *
 * The name at the top of the card is the APPLICATION's, not `large_text`: the
 * IPC sends it back as `name: "Jarvis"`. To make it read "Topics" you rename
 * the application on the portal - that one does require logging in.
 *
 * It is overridden with `DISCORD_PRESENCE_IMAGE` without recompiling.
 */
export const DEFAULT_LARGE_IMAGE =
  "https://raw.githubusercontent.com/armonia/topics-app/main/desktop-tauri/src-tauri/icons/128x128.png";

/**
 * The wire's state and its snapshot live in `shared/types.ts`, not here:
 * `GET /api/profile/discord` sends them to the panel as they are, and a second
 * client-side declaration would be a mirror doomed to diverge
 * (`tests/unit/no-type-mirrors.test.ts`).
 *
 * And they are not re-exported from here: this module USES them, it is not
 * their door. A convenience `export type { … }` here would give the same shape
 * two addresses, nobody would import the second, and `check:deadcode` would
 * count it dead - which is exactly what sent this card back.
 */

export interface DiscordPresenceSettings {
  enabled: boolean;
  level: DiscordDetailLevel;
  language: OutputLanguage;
}

export interface DiscordPresenceDeps {
  /** The real state, asked for on every round: it is what makes the numbers exact. */
  getSnapshot: () => PresenceSnapshot;
  /** The settings, re-read on every round: this way a switch moved from
   *  another window takes effect without anyone having to notify this service. */
  getSettings: () => DiscordPresenceSettings;
  clientId?: string;
  largeImage?: string | null;
  connect?: IpcConnector;
  candidates?: string[];
  /** How often we look at whether anything has changed. */
  refreshMs?: number;
  /** How long we wait for the READY. A Discord that accepts the connection and
   *  then goes quiet is rare but real (startup in progress), and without a cap
   *  the tick would hang on that wire - that is, the presence would stop
   *  updating without anything saying so. */
  handshakeTimeoutMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** How long we wait before retrying, by kind of failure. A closed Discord is a
 *  condition that changes on its own quickly (you open it); a refused ID does
 *  NOT change with time, so retrying it every 15s is just noise.
 *
 *  A side effect worth knowing, measured over six server restarts: if the FIRST
 *  attempt succeeds the presence is alive in ~3s, if it fails (Discord has not
 *  reopened the socket yet) we wait the full `socket_error` minute and the
 *  recovery arrives at ~50-60s. In between the state is `error`, which at a
 *  glance looks like a fault and is instead the waiting working as intended:
 *  whoever diagnoses after a restart should look twice, a minute apart, before
 *  saying "broken". */
const RETRY_MS: Record<string, number> = {
  no_socket: 30_000,
  timeout: 60_000,
  socket_error: 60_000,
  handshake_refused: 300_000,
};

export interface DiscordPresenceService {
  start(): void;
  stop(): Promise<void>;
  /** One round right away, without waiting for the timer. Called by whoever
   *  moves the switch: a checkbox that takes fifteen seconds to take effect
   *  reads as a broken checkbox. */
  tick(): Promise<void>;
  status(): DiscordPresenceStatus;
  /** The activity that would be published NOW at a given level - the preview
   *  of the card in Settings. It does not touch the wire: it can be called with
   *  the switch off, and that is the point (you look before turning it on). */
  preview(level?: DiscordDetailLevel): DiscordActivity | null;
}

export function createDiscordPresence(deps: DiscordPresenceDeps): DiscordPresenceService {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((msg: string) => console.log(`[discord] ${msg}`));
  const refreshMs = deps.refreshMs ?? 15_000;
  const clientId = deps.clientId ?? process.env.DISCORD_CLIENT_ID?.trim() ?? DEFAULT_CLIENT_ID;
  const largeImage =
    deps.largeImage === undefined
      ? (process.env.DISCORD_PRESENCE_IMAGE?.trim() || DEFAULT_LARGE_IMAGE)
      : deps.largeImage;

  let socket: IpcSocket | null = null;
  let connection: DiscordConnectionState = "off";
  let user: DiscordPresenceStatus["user"] = null;
  let lastError: string | null = null;
  let lastPublishedAt: number | null = null;
  let published: DiscordActivity | null = null;
  /** The key of what is already on the wire: we write only when it CHANGES.
   *  Discord rate-limits SET_ACTIVITY, and rewriting the same state every
   *  fifteen seconds is the way to end up throttled for nothing. */
  let publishedKey = "";
  /**
   * The application name as Discord says it, not as we imagine it. It is known
   * only after the first accepted activity: before that it stays `null`, which
   * is honest, whereas writing "Topics" would be the same lie as before.
   */
  let applicationName: string | null = null;
  let nextAttemptAt = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** One round at a time: a slow tick (handshake in progress) must not overlap
   *  with the timer's and open two wires. */
  let inFlight: Promise<void> | null = null;

  function dropSocket(): void {
    if (!socket) return;
    try { socket.destroy(); } catch { /* already dead */ }
    socket = null;
    publishedKey = "";
    published = null;
    // The name holds for the wire that said it: another application, another
    // name. Keeping it here would be remembering the answer to a different
    // question.
    applicationName = null;
    user = null;
  }

  async function ensureConnected(): Promise<boolean> {
    if (socket) return true;
    if (now() < nextAttemptAt) return false;
    connection = "connecting";
    try {
      const res = await handshake({
        clientId,
        connect: deps.connect ?? netConnector,
        candidates: deps.candidates,
        timeoutMs: deps.handshakeTimeoutMs,
        onClose: (why) => {
          // The wire dropped: we start again on the next round, with no timers
          // of our own (a tick already exists, and two clocks chasing each
          // other are how the old daemon ended up stacking sockets).
          if (!socket) return;
          dropSocket();
          connection = "connecting";
          lastError = `filo caduto (${why.slice(0, 120)})`;
          log(`filo caduto: ${why.slice(0, 200)}`);
        },
      });
      socket = res.socket;
      user = res.user;
      // Discord sends the activity back as it saved it: it is the only place
      // from which we learn what the application is really called.
      onActivityAck(res.socket, (ack) => {
        if (ack.applicationName) applicationName = ack.applicationName;
      });
      connection = "connected";
      lastError = null;
      nextAttemptAt = 0;
      log(`collegato su ${res.socketPath}${res.user?.username ? ` (utente ${res.user.username})` : ""}`);
      return true;
    } catch (err) {
      const code = err instanceof DiscordIpcError ? err.code : "socket_error";
      connection = code === "no_socket" ? "no_discord" : "error";
      lastError = (err as Error)?.message ?? String(err);
      nextAttemptAt = now() + (RETRY_MS[code] ?? 60_000);
      return false;
    }
  }

  function write(activity: DiscordActivity | null): void {
    if (!socket) return;
    const key = activity ? JSON.stringify(activity) : "__clear__";
    if (key === publishedKey) return;
    try {
      sendActivity(socket, process.pid, activity);
      publishedKey = key;
      published = activity;
      lastPublishedAt = now();
    } catch (err) {
      lastError = `scrittura fallita: ${(err as Error)?.message ?? err}`;
      dropSocket();
      connection = "error";
    }
  }

  function currentActivity(level: DiscordDetailLevel, language: OutputLanguage): DiscordActivity | null {
    return buildActivity(deps.getSnapshot(), level, language, largeImage);
  }

  async function runTick(): Promise<void> {
    const settings = deps.getSettings();

    if (!settings.enabled) {
      if (socket) {
        // Turning off CLEARS: a stale state after you have withdrawn consent is
        // the worst thing this service can do.
        write(null);
        dropSocket();
      }
      connection = "off";
      lastError = null;
      published = null;
      return;
    }

    if (!(await ensureConnected())) return;
    write(currentActivity(settings.level, settings.language));
  }

  function tick(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = runTick()
      .catch((err) => {
        lastError = (err as Error)?.message ?? String(err);
        connection = "error";
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, refreshMs);
      (timer as unknown as { unref?: () => void }).unref?.();
      void tick();
    },
    async stop(): Promise<void> {
      if (timer) { clearInterval(timer); timer = null; }
      await inFlight?.catch(() => { /* shutting down does not fail over a tick */ });
      if (socket) { write(null); dropSocket(); }
      connection = "off";
    },
    tick,
    status(): DiscordPresenceStatus {
      const s = deps.getSettings();
      return {
        enabled: s.enabled,
        level: s.level,
        connection,
        user,
        lastError,
        lastPublishedAt,
        applicationName,
        activity: published,
      };
    },
    preview(level?: DiscordDetailLevel): DiscordActivity | null {
      const s = deps.getSettings();
      return currentActivity(level ?? s.level, s.language);
    },
  };
}

// ── The singleton, because there is only one wire per process ──────────────

let service: DiscordPresenceService | null = null;

/** Grafts the service in (`server.ts` does it, once) and starts it. */
export function startDiscordPresence(deps: DiscordPresenceDeps): DiscordPresenceService {
  service?.stop().catch(() => { /* the old one goes away regardless */ });
  service = createDiscordPresence(deps);
  service.start();
  return service;
}

/** The live service, if there is one. `null` in every reduced context (the
 *  route tests, a server without this piece): whoever reads it has to handle
 *  that, and the route does so by saying "off" instead of breaking. */
export function getDiscordPresence(): DiscordPresenceService | null {
  return service;
}

/**
 * One round RIGHT AWAY because the settings changed.
 *
 * Called by the route that writes the switch. Without this, turning the
 * presence on would take effect at the next tick - up to fifteen seconds of a
 * panel saying "on" and a profile showing nothing, that is, a switch that looks
 * broken.
 */
export async function reconcileDiscordPresence(): Promise<void> {
  await service?.tick();
}
