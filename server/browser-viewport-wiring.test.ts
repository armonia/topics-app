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
import { createViewportWiring, LOOPBACK_OWNER, viewportClaimantOf } from "./browser-viewport-wiring";

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

/** The wiring under test, with the sockets of the context it has to reach. */
function wireUp(panes: Pane[]) {
  return createViewportWiring({ socketsOf: () => panes.filter((p) => p.readyState === 1) });
}

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
  const wiring = wireUp(panes);

  wiring.onOpen(CTX, nativeMac.data);
  wiring.onNativeExecutor(CTX, nativeMac.data);

  const phone = connect({ device: "phone-1" });
  panes.push(phone);
  wiring.onOpen(CTX, phone.data);

  nativeMac.readyState = 3;
  wiring.onClose(CTX, nativeMac.data);
  // Same pane, other socket: the shell flipped from executing to streaming.
  const streamingMac = connect("loopback", "pane-mac");
  panes.push(streamingMac);
  wiring.onOpen(CTX, streamingMac.data);

  // The phone is only watching: the Mac, first to show up on this context,
  // still owns the size even though its socket is the youngest of the three.
  expect(wiring.onResize(CTX, streamingMac.data, false)).toBe(true);
  expect(wiring.onResize(CTX, phone.data, false)).toBe(false);

  // Rotating the phone must not reflow the page under the Mac.
  expect(wiring.onResize(CTX, phone.data, false)).toBe(false);
});

test("S2: the Mac that reconnects is still the driver", () => {
  // The phone got here first and the Mac is the one using the page. Then the
  // Mac sleeps, or the server reloads, and it comes back on a new socket.
  const phone = connect({ device: "phone-1" });
  const mac = connect("loopback", "pane-mac");
  const panes = [phone, mac];
  const wiring = wireUp(panes);
  wiring.onOpen(CTX, phone.data);
  wiring.onOpen(CTX, mac.data);

  wiring.onInput(CTX, mac.data, "click");
  expect(wiring.onResize(CTX, mac.data, false)).toBe(true);
  expect(wiring.onResize(CTX, phone.data, false)).toBe(false);

  mac.readyState = 3;
  wiring.onClose(CTX, mac.data);
  const mac2 = connect("loopback", "pane-mac");
  panes.push(mac2);
  wiring.onOpen(CTX, mac2.data);

  expect(wiring.onResize(CTX, mac2.data, false)).toBe(true);
  expect(wiring.onResize(CTX, phone.data, false)).toBe(false);
});

test("using the page takes the viewport, and the resize that claims it says so", () => {
  const mac = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [mac, phone];
  const wiring = wireUp(panes);
  wiring.onOpen(CTX, mac.data);
  wiring.onOpen(CTX, phone.data);

  // Scrolling on the phone hands it the page (an `input` with action `scroll`).
  wiring.onInput(CTX, phone.data, "scroll");
  expect(wiring.onResize(CTX, phone.data, false)).toBe(true);
  expect(wiring.onResize(CTX, mac.data, false)).toBe(false);

  // And the Mac takes it back with the claim its own first input carries.
  expect(wiring.onResize(CTX, mac.data, true)).toBe(true);
  expect(wiring.onResize(CTX, phone.data, false)).toBe(false);
});

test("when the driver leaves, its heir is asked for its size", () => {
  const mac = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [mac, phone];
  const wiring = wireUp(panes);
  wiring.onOpen(CTX, mac.data);
  wiring.onOpen(CTX, phone.data);
  wiring.onInput(CTX, mac.data, "click");

  mac.readyState = 3;
  const heir = wiring.onClose(CTX, mac.data);
  expect(heir, "nessun erede quando il driver esce").toBe(viewportClaimantOf(phone.data).device);
  wiring.askViewportOf(CTX, heir ?? "");

  // Only the heir is asked, and the question reaches it: the heir sent that
  // size once already and deduplicates it, so silence here means the page
  // keeps the size of whoever just left.
  expect(askedDevices(panes)).toEqual([viewportClaimantOf(phone.data).device]);
  expect(wiring.onResize(CTX, phone.data, false)).toBe(true);
});

test("the executor socket of the shell is not in the audience", () => {
  // A phone alone with the native executor: the executor must not queue as the
  // first arrival, or the phone (the only client actually watching) cannot
  // resize what it is looking at.
  const executor = connect("loopback");
  const phone = connect({ device: "phone-1" });
  const panes = [executor, phone];
  const wiring = wireUp(panes);
  wiring.onOpen(CTX, executor.data);
  wiring.onNativeExecutor(CTX, executor.data);
  wiring.onOpen(CTX, phone.data);

  expect(wiring.onResize(CTX, phone.data, false)).toBe(true);
});

test("the memory of a context goes away with its last pane", () => {
  const mac = connect("loopback");
  const panes = [mac];
  const wiring = wireUp(panes);
  wiring.onOpen(CTX, mac.data);
  wiring.onInput(CTX, mac.data, "click");
  mac.readyState = 3;
  expect(wiring.onClose(CTX, mac.data)).toBeUndefined();
  // Nothing to inherit, and nothing left behind: the next pane on this context
  // starts from an empty arbiter instead of from a driver that went home.
  expect(wiring.driverDevice(CTX)).toBeUndefined();
});
