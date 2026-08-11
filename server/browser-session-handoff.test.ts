import { test, expect } from "bun:test";
import { seedSharedFromNative, HANDOFF_TIMEOUT_MS } from "./browser-session-handoff";
import { createNativeDelegateRegistry } from "./browser-native-delegate";
import type { StorageState } from "../shared/browser-login-state";

/**
 * Registry VERO con un client finto: la risposta passa dal vero `resolveOp`,
 * quindi il percorso server→client→server è quello di produzione. `reply: null`
 * = il client non risponde mai (Mac occupato / socket morto).
 * Stesso schema di browser-native-state.test.ts.
 */
function scriptedRegistry(reply: { result?: unknown; error?: string } | null, ctx = "ctx") {
  const registry = createNativeDelegateRegistry();
  const seen: Array<{ tool: string; args: unknown }> = [];
  registry.register(ctx, (msg) => {
    seen.push({ tool: msg.tool, args: msg.args });
    if (reply) queueMicrotask(() => registry.resolveOp({ opId: msg.opId, ...reply }));
  });
  return { registry, seen };
}

/** Store in memoria con la stessa firma di browser-state-store. */
function fakeStore(initial: Record<string, StorageState> = {}) {
  const files: Record<string, StorageState> = JSON.parse(JSON.stringify(initial));
  return {
    files,
    load: async (id: string) => (files[id] ? JSON.parse(JSON.stringify(files[id])) : null),
    save: async (id: string, s: StorageState) => {
      files[id] = JSON.parse(JSON.stringify(s));
    },
  } as const;
}

const NATIVE: StorageState = {
  cookies: [{ name: "sid", value: "MAC", domain: "example.com", path: "/" }],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "tok", value: "T" }] }],
};

test("senza pane nativa viva non si tocca nulla", async () => {
  const registry = createNativeDelegateRegistry(); // nessuno registrato
  const store = fakeStore({ ctx: { cookies: [{ name: "phone", value: "p", domain: "a.com", path: "/" }], origins: [] } });
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(out).toEqual({ ok: false, skipped: "no-native-pane" });
  // Il caso normale (web, telefono da solo) non deve riscrivere il seme.
  expect(store.files.ctx!.cookies).toEqual([{ name: "phone", value: "p", domain: "a.com", path: "/" }]);
});

test("i cookie della pane nativa finiscono nel seme della sessione condivisa", async () => {
  const { registry, seen } = scriptedRegistry({ result: NATIVE });
  const store = fakeStore();
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(out).toEqual({ ok: true, cookies: 1, origins: 1 });
  expect(seen).toEqual([{ tool: "browser_save_state", args: {} }]);
  expect(store.files.ctx).toEqual(NATIVE);
});

test("il login del telefono sulla sessione condivisa sopravvive al passaggio", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE });
  const store = fakeStore({
    ctx: { cookies: [{ name: "phone_sid", value: "P", domain: "altro.com", path: "/" }], origins: [] },
  });
  await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  // Il punto: passare la sessione nativa NON è sovrascriverla sopra le altre.
  expect(store.files.ctx!.cookies.map((c) => c.name).sort()).toEqual(["phone_sid", "sid"]);
});

test("una pane nativa senza niente da dare non azzera il seme", async () => {
  const { registry } = scriptedRegistry({ result: { cookies: [], origins: [] } });
  const before: StorageState = {
    cookies: [{ name: "buono", value: "v", domain: "example.com", path: "/" }],
    origins: [],
  };
  const store = fakeStore({ ctx: before });
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(out).toEqual({ ok: false, skipped: "empty" });
  // Un barattolo vuoto che vince su uno pieno È il logout da togliere.
  expect(store.files.ctx).toEqual(before);
});

test("se la gamba nativa risponde errore il seme resta quello di prima", async () => {
  const { registry } = scriptedRegistry({ error: "no such browser pane" });
  const before: StorageState = { cookies: [{ name: "b", value: "v", domain: "e.com", path: "/" }], origins: [] };
  const store = fakeStore({ ctx: before });
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(out.ok).toBe(false);
  expect(out).toMatchObject({ skipped: "export-failed" });
  expect(store.files.ctx).toEqual(before);
});

test("uno stato malformato viene rifiutato, non scritto", async () => {
  const { registry } = scriptedRegistry({ result: { cookies: "non un array" } });
  const store = fakeStore();
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(out).toMatchObject({ ok: false, skipped: "export-failed" });
  expect(store.files.ctx).toBeUndefined();
});

test("se il Mac non risponde si molla entro il tetto, non ai 30s del registry", async () => {
  // reply=null: il client riceve l'op e non risponde MAI. Senza la corsa col
  // timeout questa await starebbe appesa al timeout del registry (30s), cioè
  // davanti al primo fotogramma del telefono.
  const { registry } = scriptedRegistry(null);
  const store = fakeStore();
  const t0 = performance.now();
  const out = await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save, timeoutMs: 40 });
  const elapsed = performance.now() - t0;
  expect(out).toMatchObject({ ok: false, skipped: "timeout" });
  expect(elapsed).toBeLessThan(1000);
  expect(store.files.ctx).toBeUndefined();
});

test("il tetto di serie sta molto sotto il timeout del registry nativo", () => {
  // Se qualcuno alzasse questo numero fino ai 30s del registry, la corsa
  // smetterebbe di servire a qualcosa senza che nessun test se ne accorga.
  expect(HANDOFF_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
});

test("il passaggio è confinato al suo contesto: un altro topic non viene toccato", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE }, "ctx-A");
  const store = fakeStore({ "ctx-B": { cookies: [{ name: "b", value: "B", domain: "b.com", path: "/" }], origins: [] } });
  await seedSharedFromNative("ctx-A", { registry, load: store.load, save: store.save });
  expect(store.files["ctx-A"]!.cookies[0]!.value).toBe("MAC");
  expect(store.files["ctx-B"]!.cookies).toEqual([{ name: "b", value: "B", domain: "b.com", path: "/" }]);
  // E un contesto senza pane nativa non eredita quella dell'altro.
  const out = await seedSharedFromNative("ctx-B", { registry, load: store.load, save: store.save });
  expect(out).toEqual({ ok: false, skipped: "no-native-pane" });
});

test("il flip che balla non cambia il seme a ogni oscillazione", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE });
  const store = fakeStore({ ctx: { cookies: [{ name: "phone", value: "P", domain: "a.com", path: "/" }], origins: [] } });
  await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  const dopoUno = JSON.stringify(store.files.ctx);
  // Il debounce da 1200ms può rimbalzare: due giri devono dare lo stesso file.
  await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  expect(JSON.stringify(store.files.ctx)).toBe(dopoUno);
});

test("il passaggio riempie i buchi e non sostituisce: non puo\' sloggare nessuno", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE });
  const store = fakeStore({
    ctx: { cookies: [{ name: "sid", value: "FRESCO-DAL-TELEFONO", domain: "example.com", path: "/" }], origins: [] },
  });
  await seedSharedFromNative("ctx", { registry, load: store.load, save: store.save });
  // Il barattolo nativo ha lo STESSO cookie (name+domain+path): potrebbe essere
  // una sessione lasciata li\' mesi fa, non scaduta ma morta. Sostituendola si
  // butterebbe fuori il login appena fatto dal telefono, e su disco, per sempre.
  expect(store.files.ctx!.cookies).toHaveLength(1);
  expect(store.files.ctx!.cookies[0]!.value).toBe("FRESCO-DAL-TELEFONO");
  // Ma cio\' che manca alla sessione condivisa arriva: e\' il punto del passaggio.
  expect(store.files.ctx!.origins).toEqual(NATIVE.origins);
});

test("se lo store non si legge si riparte dal vuoto invece di far saltare la pane", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE });
  const saved: StorageState[] = [];
  const out = await seedSharedFromNative("ctx", {
    registry,
    load: async () => { throw new Error("disco rotto"); },
    save: async (_id: string, s: StorageState) => { saved.push(s); },
  });
  expect(out).toEqual({ ok: true, cookies: 1, origins: 1 });
  expect(saved[0]).toEqual(NATIVE);
});

test("se la scrittura fallisce il chiamante lo sa e non gli esplode in mano", async () => {
  const { registry } = scriptedRegistry({ result: NATIVE });
  const out = await seedSharedFromNative("ctx", {
    registry,
    load: async () => null,
    save: async () => { throw new Error("disco pieno"); },
  });
  // Sta sul percorso di creazione del contesto: un throw qui sarebbe una pane
  // che non nasce invece di una pane sloggata.
  expect(out).toMatchObject({ ok: false, skipped: "export-failed", error: "disco pieno" });
});
