/**
 * La macchina a stati della presence.
 *
 * Il trasporto ha già il suo test contro un socket vero (`discord-ipc.test.ts`);
 * qui l'interlocutore è un socket finto IN PROCESSO, perché le domande sono
 * altre e nessuna riguarda i byte: spegnere pulisce? lo stesso stato si
 * riscrive? Discord chiuso è un errore o una condizione? un Application ID
 * rifiutato smette di essere ritentato?
 *
 * Sono le quattro cose che il daemon sostituito sbagliava — l'ultima gli
 * costava un crash-loop con i rapporti di diagnostica di macOS pieni.
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

/** Un Discord finto in processo: risponde READY (o no) e registra i comandi. */
function fakeDiscord(opts: { ready?: boolean; appName?: string } = {}) {
  const ready = opts.ready !== false;
  // Discord vero RISPONDE a un SET_ACTIVITY rimandando l'activity come l'ha
  // salvata, col nome dell'applicazione dentro. Il finto lo imita, altrimenti
  // qui non si puo' provare niente su quel nome.
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

/** Il servizio non si avvia col timer: i test chiamano `tick()` a mano, così
 *  non c'è nessun orologio vero da aspettare. */
function servizio(over: {
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
    // Il Discord finto «muto» (`ready:false`) va in timeout per definizione:
    // 40ms invece di 4s, così il test dura quanto la logica che prova.
    handshakeTimeoutMs: 40,
    now: over.now,
    log: () => { /* silenzio nei test */ },
  });
  return { svc, discord, set: (s: Partial<DiscordPresenceSettings>) => { current = { ...current, ...s }; } };
}

describe("interruttore", () => {
  test("spento: nessun filo aperto, e lo stato lo DICE («off», non «errore»)", async () => {
    const { svc, discord } = servizio({ settings: settings({ enabled: false }) });
    await svc.tick();
    expect(discord.connections).toBe(0);
    expect(svc.status().connection).toBe("off");
    expect(svc.status().lastError).toBeNull();
  });

  test("acceso: si collega e pubblica ciò che sta succedendo", async () => {
    const { svc, discord } = servizio();
    await svc.tick();
    await svc.tick(); // il READY arriva in un microtask: il secondo giro scrive
    expect(discord.connections).toBe(1);
    expect(svc.status().connection).toBe("connected");
    expect(svc.status().user?.username).toBe("pippo");
    // L'etichetta e' quella di `presence-phrase` («chat aperte», non
    // «aperte»): questo test verifica che il servizio PUBBLICHI la frase, non
    // che la sappia riscrivere. Tenerne una copia a mano l'aveva gia' fatto
    // divergere dal 647ccd7c, quando la parola cambio' di la' e non di qua.
    expect(discord.activities.at(-1)).toMatchObject({
      details: presenceLines(SNAPSHOT, "it").details,
    });
  });

  test("il nome dell'applicazione lo dice Discord, non il codice", async () => {
    // Il nome in cima alla card lo decide il portale sviluppatori e nessuno
    // puo' indovinarlo da qui: il pannello scriveva «Topics» a mano mentre la
    // card vera diceva «Jarvis», e chi apriva l'anteprima per sapere cosa
    // vedono gli altri leggeva una cosa falsa.
    const { svc } = servizio();
    expect(svc.status().applicationName).toBeNull(); // prima del filo: non si sa
    await svc.tick();
    await svc.tick();
    expect(svc.status().applicationName).toBe("Jarvis");
  });

  test("un'altra applicazione, un altro nome: non si ricicla il precedente", async () => {
    const { svc } = servizio({ appName: "Topics" });
    await svc.tick();
    await svc.tick();
    expect(svc.status().applicationName).toBe("Topics");
  });

  test("spegnere PULISCE la presence invece di lasciarla appesa", async () => {
    const { svc, discord, set } = servizio();
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
    const { svc, discord } = servizio();
    await svc.tick();
    await svc.tick();
    const dopoPrima = discord.activities.length;
    await svc.tick();
    await svc.tick();
    expect(discord.activities.length).toBe(dopoPrima);
  });

  test("uno stato diverso si scrive", async () => {
    const { svc, discord, set } = servizio();
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
    let orologio = 0;
    const { svc, discord } = servizio({ ready: false, now: () => orologio });
    await svc.tick();
    expect(svc.status().connection).toBe("error");
    const tentativi = discord.connections;

    orologio += 30_000; // mezzo minuto dopo: ancora dentro il rallentamento
    await svc.tick();
    expect(discord.connections).toBe(tentativi);

    orologio += 600_000; // dieci minuti dopo: si riprova
    await svc.tick();
    expect(discord.connections).toBe(tentativi + 1);
  }, 10_000);
});

describe("anteprima", () => {
  test("si guarda a interruttore SPENTO — è il punto: si guarda prima di accendere", () => {
    const { svc, discord } = servizio({ settings: settings({ enabled: false }) });
    expect(svc.preview("detailed")).toMatchObject({ state: "su Armonia-CRM" });
    expect(discord.connections).toBe(0);
  });

  test("l'anteprima di un livello è ciò che quel livello pubblica, non un'imitazione", async () => {
    const { svc, discord, set } = servizio({ settings: settings({ level: "minimal" }) });
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
