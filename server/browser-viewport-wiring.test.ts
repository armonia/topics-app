/**
 * THE ARBITER SEEN FROM THE SOCKETS, WITH THE IDENTITY THE SERVER REALLY MAKES.
 *
 * The suite next door (`browser-viewport-arbiter.test.ts`) drives the rule with
 * identities written by hand, and that is exactly how it missed the bug this
 * file exists for: it always passed `device: "mac"`, and the Mac pane NEVER
 * produces a device id. The Tauri shell loads from `localhost:3333`, loopback
 * is the owner by definition (`evaluateIdentity`) and the owner by definition
 * has `deviceId: null`. Only a PAIRED PHONE carries one. So the identity that
 * used to fall back on the socket fell back on it for the one client that has
 * to keep its place across a reconnection.
 *
 * Hence the rule here: no hand-made `WSData`. Every socket in this file is born
 * from `evaluateIdentity` + `upgradeWebSocket`, the same two functions the
 * request path calls, so that what the arbiter sees is what the server sees.
 *
 * @covers TOPIC-BROWSER-05
 */
import { test, expect } from "bun:test";
import type { Server } from "bun";
import { evaluateIdentity, type DeviceRecord } from "./lib/device-auth";
import { upgradeWebSocket } from "./lib/ws-upgrade";
import type { WSData } from "./types";
import {
  createViewportWiring,
  LOOPBACK_OWNER,
  viewportClaimantOf,
  type ViewportWiring,
} from "./browser-viewport-wiring";

const CTX = "ctx-1";

/** A socket as the wiring sees it: its data, and what was sent down it. */
interface Pane {
  data: WSData;
  readyState: number;
  sent: string[];
  send(payload: string): void;
}

/**
 * Open a browser socket the way a request does it.
 *
 * `transport: "loopback"` is the Mac shell (its proxy makes every request come
 * from 127.0.0.1); a phone presents a session token for a paired device and
 * reaches us over the network. `pane` is the `?client=` the real client always
 * sends: the same value means the same pane coming back on a new socket.
 */
function connect(who: "loopback" | { device: string }, paneName = "pane-1"): Pane {
  const identity = typeof who === "object"
    ? evaluateIdentity({
      transport: "remote",
      sessionToken: `token-${who.device}`,
      device: {
        id: who.device, name: who.device, role: "guest", tokenHash: "hash",
        createdAt: 0, lastSeenAt: Date.now(), firstIp: null, revokedAt: null,
      } satisfies DeviceRecord,
      bearerToken: null, expectedDaemonToken: null, now: Date.now(),
    })
    : evaluateIdentity({
      transport: "loopback", sessionToken: null, device: null,
      bearerToken: null, expectedDaemonToken: null, now: Date.now(),
    });
  if (!identity.ok) throw new Error(`identity refused: ${identity.reason}`);

  let captured: WSData | null = null;
  const server = {
    upgrade(_req: Request, options?: { data?: WSData }) {
      captured = options?.data ?? null;
      return true;
    },
  } as unknown as Pick<Server<WSData>, "upgrade">;

  const answer = upgradeWebSocket(
    new Request(`http://127.0.0.1:3333/ws/browser/${CTX}?client=${paneName}`),
    `/ws/browser/${CTX}`,
    server,
    { deviceId: identity.deviceId, role: identity.role },
    typeof who === "object",
  );
  expect(answer, "l'upgrade del socket del browser non e' andato a buon fine").toBeUndefined();
  if (!captured) throw new Error("upgradeWebSocket did not stamp the socket");

  const pane: Pane = {
    data: captured, readyState: 1, sent: [],
    send(payload: string) { pane.sent.push(payload); },
  };
  return pane;
}

/** A wiring under test, and the sizes the shared page actually received. */
interface Rig {
  wiring: ViewportWiring;
  applied: Array<{ width: number; height: number }>;
}

/** The wiring under test, with the sockets of the context it has to reach. */
function wireUp(panes: Pane[]): Rig {
  const applied: Rig["applied"] = [];
  const wiring = createViewportWiring({
    socketsOf: () => panes.filter((p) => p.readyState === 1),
    resize: (_contextId, width, height) => { applied.push({ width, height }); },
  });
  return { wiring, applied };
}

/**
 * A `resize` frame, as the pane really sends it. Answers the only question that
 * matters: did the shared page take this size?
 *
 * The verdict and the effect are checked against each other on every single
 * call, and that is deliberate: the reason this file exists is that the server
 * used to ASK the arbiter and then apply the size itself, two lines apart, and
 * a mutant that broke the link between them stayed green everywhere.
 */
function sendResize(rig: Rig, pane: Pane, size: [number, number], driving = false): boolean {
  const before = rig.applied.length;
  const verdict = rig.wiring.onFrame(CTX, pane.data, {
    type: "resize", width: size[0], height: size[1], driving,
  });
  const took = rig.applied.length > before;
  expect(took, `verdetto "${verdict}" e pagina che dice il contrario`).toBe(verdict === "applied");
  if (took) expect(rig.applied.at(-1)).toEqual({ width: size[0], height: size[1] });
  return took;
}

/** An `input` frame, as the pane really sends it. */
function sendInput(rig: Rig, pane: Pane, action: string): void {
  expect(rig.wiring.onFrame(CTX, pane.data, { type: "input", action })).toBe("noted");
}

const MAC_SIZE: [number, number] = [1280, 800];
const PHONE_SIZE: [number, number] = [390, 844];

/** Did anybody get asked for its size, and who. */
function askedDevices(panes: Pane[]): string[] {
  return panes
    .filter((p) => p.sent.some((payload) => payload.includes("viewport_request")))
    .map((p) => viewportClaimantOf(p.data).device);
}

test("the loopback shell has no device id, and is identified all the same", () => {
  const mac = connect("loopback");
  expect(mac.data.deviceId, "il guscio in loopback non ha un id di dispositivo").toBe(null);
  expect(mac.data.clientId, "il nome che la pane si da' non arriva al socket").toBe("pane-1");

  // The same pane on a new socket is the same claimant: that is the whole
  // point, and the socket id cannot say it.
  const reconnected = connect("loopback");
  expect(reconnected.data.id).not.toBe(mac.data.id);
  expect(viewportClaimantOf(reconnected.data).device).toBe(viewportClaimantOf(mac.data).device);

  // Another pane of that same machine is another claimant: same person, other
  // screen, and a viewport is about the screen.
  const otherWindow = connect("loopback", "pane-2");
  expect(viewportClaimantOf(otherWindow.data).device).not.toBe(viewportClaimantOf(mac.data).device);

  // The pane name is namespaced under whoever is authenticated, so a guest
  // cannot claim to be the owner's pane by sending its `?client=`.
  const phone = connect({ device: "phone-1" });
  const impostor = connect({ device: "phone-1" }, "pane-1");
  expect(viewportClaimantOf(phone.data).device).toContain("phone-1");
  expect(viewportClaimantOf(impostor.data).device).not.toBe(viewportClaimantOf(mac.data).device);

  // And a client that sends no name at all still gets the old answer, one per
  // machine, instead of an exception.
  const silent = connect("loopback", "");
  expect(viewportClaimantOf(silent.data).device).toBe(LOOPBACK_OWNER);
});

test("S1: the native pane flips to streaming and keeps the page", () => {
  // The shell was running the context itself (native pane, auto mode). Then a
  // phone opens the same context, the pane flips to shared streaming: the
  // executor socket closes and the streaming one arrives AFTER the phone.
  const nativeMac = connect("loopback", "pane-mac");
  const panes = [nativeMac];
  const rig = wireUp(panes);

  rig.wiring.onOpen(CTX, nativeMac.data);
  rig.wiring.onNativeExecutor(CTX, nativeMac.data);

  const phone = connect({ device: "phone-1" });
  panes.push(phone);
  rig.wiring.onOpen(CTX, phone.data);

  nativeMac.readyState = 3;
  rig.wiring.onClose(CTX, nativeMac.data);
  // Same pane, other socket: the shell flipped from executing to streaming.
  const streamingMac = connect("loopback", "pane-mac");
  panes.push(streamingMac);
  rig.wiring.onOpen(CTX, streamingMac.data);

  // The phone is only watching: the Mac, first to show up on this context,
  // still owns the size even though its socket is the youngest of the three.
  expect(sendResize(rig, streamingMac, MAC_SIZE)).toBe(true);
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(false);

  // Rotating the phone must not reflow the page under the Mac.
  expect(sendResize(rig, phone, [844, 390])).toBe(false);
  expect(rig.applied, "la pagina ha preso una misura dallo spettatore").toEqual([
    { width: 1280, height: 800 },
  ]);
});

test("S2: the Mac that reconnects is still the driver", () => {
  // The phone got here first and the Mac is the one using the page. Then the
  // Mac sleeps, or the server reloads, and it comes back on a new socket.
  const phone = connect({ device: "phone-1" });
  const mac = connect("loopback", "pane-mac");
  const panes = [phone, mac];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, phone.data);
  rig.wiring.onOpen(CTX, mac.data);

  sendInput(rig, mac, "click");
  expect(sendResize(rig, mac, MAC_SIZE)).toBe(true);
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(false);

  mac.readyState = 3;
  rig.wiring.onClose(CTX, mac.data);
  const mac2 = connect("loopback", "pane-mac");
  panes.push(mac2);
  rig.wiring.onOpen(CTX, mac2.data);

  expect(sendResize(rig, mac2, MAC_SIZE)).toBe(true);
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(false);
});

test("using the page takes the viewport, and the resize that claims it says so", () => {
  const mac = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [mac, phone];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, mac.data);
  rig.wiring.onOpen(CTX, phone.data);

  // Passing the cursor over a pane to READ it is not using it. If it were, a
  // shared page would resize under the hands of whoever is typing every time
  // somebody else's mouse crossed their own screen.
  sendInput(rig, phone, "mousemove");
  expect(sendResize(rig, phone, PHONE_SIZE), "il mouse che passa prende la pagina").toBe(false);

  // Scrolling on the phone hands it the page (an `input` with action `scroll`).
  sendInput(rig, phone, "scroll");
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(true);
  expect(sendResize(rig, mac, MAC_SIZE)).toBe(false);

  // And the Mac takes it back with the claim its own first input carries: the
  // input may have gone down the DataChannel, where no `input` frame exists, so
  // the claim on the `resize` is the only thing that can say it happened.
  expect(sendResize(rig, mac, MAC_SIZE, true)).toBe(true);
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(false);

  // Without that claim the same frame would have been dropped: the phone is
  // still the driver of record until somebody says otherwise.
  expect(rig.applied).toEqual([
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]);
});

test("when the driver leaves, its heir is asked for its size", () => {
  const mac = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [mac, phone];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, mac.data);
  rig.wiring.onOpen(CTX, phone.data);
  sendInput(rig, mac, "click");

  mac.readyState = 3;
  const heir = rig.wiring.onClose(CTX, mac.data);
  expect(heir, "nessun erede quando il driver esce").toBe(viewportClaimantOf(phone.data).device);
  rig.wiring.askViewportOf(CTX, heir ?? "");

  // Only the heir is asked, and the question reaches it: the heir sent that
  // size once already and deduplicates it, so silence here means the page
  // keeps the size of whoever just left.
  expect(askedDevices(panes)).toEqual([viewportClaimantOf(phone.data).device]);
  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(true);
});

test("the executor socket of the shell is not in the audience", () => {
  // A phone alone with the native executor: the executor must not queue as the
  // first arrival, or the phone (the only client actually watching) cannot
  // resize what it is looking at.
  const executor = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [executor, phone];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, executor.data);
  rig.wiring.onNativeExecutor(CTX, executor.data);
  rig.wiring.onOpen(CTX, phone.data);

  expect(sendResize(rig, phone, PHONE_SIZE)).toBe(true);
});

test("the memory of a context goes away with its last pane", () => {
  const mac = connect("loopback");
  const panes = [mac];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, mac.data);
  sendInput(rig, mac, "click");
  mac.readyState = 3;
  expect(rig.wiring.onClose(CTX, mac.data)).toBeUndefined();
  // Nothing to inherit, and nothing left behind: the next pane on this context
  // starts from an empty arbiter instead of from a driver that went home.
  expect(rig.wiring.driverDevice(CTX)).toBeUndefined();
});

test("S3: the Mac restarts under a new pane name and still finds its page", () => {
  // The updater relaunches the app (`app.restart`), or the pane is dragged out
  // into its own window: either way the webview is a new one, its session
  // storage is empty, and the name the pane gives itself is brand new. The
  // person is the same person, in front of the same screen.
  const phone = connect({ device: "phone-1" });
  const mac = connect("loopback", "pane-before");
  const panes = [phone, mac];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, phone.data);
  rig.wiring.onOpen(CTX, mac.data);
  sendInput(rig, mac, "click");

  mac.readyState = 3;
  rig.wiring.onClose(CTX, mac.data);
  const restarted = connect("loopback", "pane-after");
  panes.push(restarted);
  rig.wiring.onOpen(CTX, restarted.data);

  // It is a stranger by name, so it inherits: the seat of the pane that is
  // gone, and the steering wheel that pane was holding. Without an input.
  expect(viewportClaimantOf(restarted.data).device)
    .not.toBe(viewportClaimantOf(mac.data).device);
  expect(sendResize(rig, restarted, MAC_SIZE), "il Mac riavviato non ritrova la pagina").toBe(true);
  expect(sendResize(rig, phone, PHONE_SIZE), "il telefono che guarda tiene il viewport").toBe(false);
});

test("two panes of the same machine, both open, stay two claimants", () => {
  // The inheritance above must not become "the owner is one client": a second
  // window is a second screen, and the one that is not driving does not get to
  // reflow the page under the one that is.
  const first = connect("loopback", "pane-1");
  const second = connect("loopback", "pane-2");
  const panes = [first, second];
  const rig = wireUp(panes);
  rig.wiring.onOpen(CTX, first.data);
  rig.wiring.onOpen(CTX, second.data);

  expect(sendResize(rig, first, MAC_SIZE)).toBe(true);
  expect(sendResize(rig, second, [900, 600]), "la seconda finestra rimpagina la prima").toBe(false);
});
