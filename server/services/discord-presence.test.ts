/**
 * The presence state machine.
 *
 * The transport already has its own test against a real socket
 * (`discord-ipc.test.ts`); here the counterpart is a fake socket IN PROCESS,
 * because the questions are different ones and none of them is about bytes:
 * does turning off clear? does the same state get rewritten? is a closed
 * Discord an error or a condition? does a refused Application ID stop being
 * retried?
 *
 * They are the four things the daemon this replaced got wrong - the last one
 * cost it a crash-loop with the macOS diagnostic reports full.
 */

import { describe, expect, test } from "bun:test";
import { createDiscordPresence, type DiscordPresenceSettings } from "./discord-presence";
import { createFrameDecoder, encodeFrame, IPC_OP, type IpcSocket } from "./discord-ipc";
import type { PresenceSnapshot } from "./discord-activity";
import { presenceLines } from "../../shared/presence-phrase";

const SNAPSHOT: PresenceSnapshot = {
  openSessions: 12,
  workingSessions: 3,
  activeTasks: 2,
  focusProject: "Armonia-CRM",
  since: 1_700_000_000_000,
};

/** A fake in-process Discord: it answers READY (or not) and records the commands. */
function fakeDiscord(opts: { ready?: boolean; appName?: string } = {}) {
  const ready = opts.ready !== false;
  // The real Discord ANSWERS a SET_ACTIVITY by sending the activity back as it
  // saved it, with the application name inside. The fake one imitates that,
  // otherwise nothing about that name could be proved here.
  const appName = opts.appName ?? "Jarvis";
  const activities: Array<unknown> = [];
  let connections = 0;
  const handlers = new Map<string, Array<(arg: never) => void>>();

  const socket: IpcSocket = {
    write(data: Uint8Array) {
      for (const frame of decode(data)) {
        if (frame.op === IPC_OP.HANDSHAKE && ready) {
          queueMicrotask(() => emit("data", encodeFrame(IPC_OP.FRAME, {
            evt: "READY", data: { user: { username: "pippo" } },
          })));
        }
        if (frame.op === IPC_OP.FRAME && frame.payload?.cmd === "SET_ACTIVITY") {
          const activity = (frame.payload.args as { activity: unknown }).activity;
          activities.push(activity);
          const nonce = (frame.payload as { nonce?: string }).nonce;
          queueMicrotask(() => emit("data", encodeFrame(IPC_OP.FRAME, {
            cmd: "SET_ACTIVITY", nonce,
            data: { ...(activity as Record<string, unknown> ?? {}), name: appName },
          })));
        }
      }
      return true;
    },
    destroy() { return true; },
    on(event: string, cb: (...args: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb as (arg: never) => void);
      handlers.set(event, list);
      return socket;
    },
  };
  const decode = createFrameDecoder();
  function emit(event: string, arg: unknown) {
    for (const cb of handlers.get(event) ?? []) (cb as (a: unknown) => void)(arg);
  }

  return {
    activities,
    get connections() { return connections; },
    connect: (): IpcSocket => { connections++; return socket; },
  };
}

function settings(over: Partial<DiscordPresenceSettings> = {}): DiscordPresenceSettings {
  return { enabled: true, level: "activity", language: "it", ...over };
}

/** The service does not start with the timer: the tests call `tick()` by hand,
 *  so there is no real clock to wait for. */
function service(over: {
  settings?: DiscordPresenceSettings;
  snapshot?: PresenceSnapshot;
  ready?: boolean;
  now?: () => number;
  appName?: string;
} = {}) {
  const discord = fakeDiscord({ ready: over.ready, appName: over.appName });
  let current = over.settings ?? settings();
  const svc = createDiscordPresence({
    getSnapshot: () => over.snapshot ?? SNAPSHOT,
    getSettings: () => current,
    connect: discord.connect,
    candidates: ["/finto/discord-ipc-0"],
    clientId: "test",
    largeImage: null,
    // The "mute" fake Discord (`ready:false`) times out by definition: 40ms
    // instead of 4s, so the test lasts as long as the logic it tests.
    handshakeTimeoutMs: 40,
    now: over.now,
    log: () => { /* silence in the tests */ },
  });
  return { svc, discord, set: (s: Partial<DiscordPresenceSettings>) => { current = { ...current, ...s }; } };
}

describe("interruttore", () => {
  test("spento: nessun filo aperto, e lo stato lo DICE («off», non «errore»)", async () => {
    const { svc, discord } = service({ settings: settings({ enabled: false }) });
    await svc.tick();
    expect(discord.connections).toBe(0);
    expect(svc.status().connection).toBe("off");
    expect(svc.status().lastError).toBeNull();
  });

  test("acceso: si collega e pubblica ciò che sta succedendo", async () => {
    const { svc, discord } = service();
    await svc.tick();
    await svc.tick(); // the READY arrives in a microtask: the second round writes
    expect(discord.connections).toBe(1);
    expect(svc.status().connection).toBe("connected");
    expect(svc.status().user?.username).toBe("pippo");
    // The label is the one from `presence-phrase` («chat aperte», not  allow-italian: quotes the published label verbatim
    // «aperte»): this test checks that the service PUBLISHES the phrase, not  allow-italian: quotes the published label verbatim
    // that it knows how to rewrite it. Keeping a copy of it by hand had already
    // made it diverge back at 647ccd7c, when the word changed over there and
    // not over here.
    expect(discord.activities.at(-1)).toMatchObject({
      details: presenceLines(SNAPSHOT, "it").details,
    });
  });

  test("il nome dell'applicazione lo dice Discord, non il codice", async () => {
    // The name at the top of the card is decided by the developer portal and
    // nobody can guess it from here: the panel wrote "Topics" by hand while the
    // real card said "Jarvis", and whoever opened the preview to know what
    // other people see was reading something false.
    const { svc } = service();
    expect(svc.status().applicationName).toBeNull(); // before the wire: unknown
    await svc.tick();
    await svc.tick();
    expect(svc.status().applicationName).toBe("Jarvis");
  });

  test("un'altra applicazione, un altro nome: non si ricicla il precedente", async () => {
    const { svc } = service({ appName: "Topics" });
    await svc.tick();
    await svc.tick();
    expect(svc.status().applicationName).toBe("Topics");
  });

  test("spegnere PULISCE la presence invece di lasciarla appesa", async () => {
    const { svc, discord, set } = service();
    await svc.tick();
    await svc.tick();
    expect(discord.activities.at(-1)).not.toBeNull();

    set({ enabled: false });
    await svc.tick();
    expect(discord.activities.at(-1)).toBeNull();
    expect(svc.status().connection).toBe("off");
    expect(svc.status().activity).toBeNull();
  });
});

describe("scritture sul filo", () => {
  test("lo stesso stato non si riscrive: Discord limita i SET_ACTIVITY", async () => {
    const { svc, discord } = service();
    await svc.tick();
    await svc.tick();
    const dopoPrima = discord.activities.length;
    await svc.tick();
    await svc.tick();
    expect(discord.activities.length).toBe(dopoPrima);
  });

  test("uno stato diverso si scrive", async () => {
    const { svc, discord, set } = service();
    await svc.tick();
    await svc.tick();
    const prima = discord.activities.length;
    set({ level: "detailed" });
    await svc.tick();
    expect(discord.activities.length).toBe(prima + 1);
    expect(discord.activities.at(-1)).toMatchObject({ state: "su Armonia-CRM" });
  });
});

describe("quando Discord non c'è", () => {
  test("nessun candidato ⇒ `no_discord`, che non è un guasto da riparare", async () => {
    const discord = fakeDiscord();
    const svc = createDiscordPresence({
      getSnapshot: () => SNAPSHOT,
      getSettings: () => settings(),
      connect: discord.connect,
      candidates: [],
      log: () => {},
    });
    await svc.tick();
    expect(svc.status().connection).toBe("no_discord");
    expect(svc.status().lastError).toContain("Discord desktop");
  });

  test("un ID rifiutato non si ritenta a ogni giro: il fallimento non passa col tempo", async () => {
    let clock = 0;
    const { svc, discord } = service({ ready: false, now: () => clock });
    await svc.tick();
    expect(svc.status().connection).toBe("error");
    const attempts = discord.connections;

    clock += 30_000; // half a minute later: still inside the slowdown
    await svc.tick();
    expect(discord.connections).toBe(attempts);

    clock += 600_000; // ten minutes later: we try again
    await svc.tick();
    expect(discord.connections).toBe(attempts + 1);
  }, 10_000);
});

describe("anteprima", () => {
  test("si guarda a interruttore SPENTO — è il punto: si guarda prima di accendere", () => {
    const { svc, discord } = service({ settings: settings({ enabled: false }) });
    expect(svc.preview("detailed")).toMatchObject({ state: "su Armonia-CRM" });
    expect(discord.connections).toBe(0);
  });

  test("l'anteprima di un livello è ciò che quel livello pubblica, non un'imitazione", async () => {
    const { svc, discord, set } = service({ settings: settings({ level: "minimal" }) });
    const attesa = svc.preview();
    await svc.tick();
    await svc.tick();
    expect(discord.activities.at(-1)).toEqual(attesa);
    set({ level: "detailed" });
    const attesa2 = svc.preview();
    await svc.tick();
    expect(discord.activities.at(-1)).toEqual(attesa2);
  });
});
