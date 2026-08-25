/**
 * Handing a browser session between the native pane and the shared server
 * context: the storage state is merged, never zeroed, and the wait gives up in time.
 * @covers BROWSER-CHAT-01
 */
import { test, expect } from "bun:test";
import { seedSharedFromNative, seedNativeFromShared, HANDOFF_TIMEOUT_MS } from "./browser-session-handoff";
import { createNativeDelegateRegistry } from "./browser-native-delegate";
import type { StorageState } from "../shared/browser-login-state";
import type { BrowserStorageState } from "./browser-state-store";

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

// ─────────────────────────────────────────────────────────────────────────────
// IL VERSO OPPOSTO — sessione condivisa → WKWebView nativa.
//
// Il passaggio sopra è mezza storia: «mi loggo sul Mac, il telefono apre la
// stessa scheda ed è dentro». L'altra metà — «mi loggo dal telefono, torno sul
// Mac e sono ancora fuori» — non aveva NESSUN codice: `seedSharedFromNative`
// esiste in un verso solo, e il barattolo della pane nativa non l'ha mai letto
// nessuno all'indietro.
// ─────────────────────────────────────────────────────────────────────────────

const CONDIVISO: StorageState = {
  cookies: [{ name: "sid", value: "DAL-TELEFONO", domain: "example.com", path: "/" }],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "tok", value: "T" }] }],
};

/** Memo pulita per ogni test: il modulo ne tiene una sua di processo. */
const memoNuova = () => new Map<string, string>();

/**
 * Un `loadStorageState` finto con la FIRMA VERA dello store: prende il
 * contextId e può restituire `null` (nessun barattolo su disco). Scritto come
 * `async () => X` compilava soltanto dove passava per l'`any` di JSON.parse —
 * qui il tipo è quello di produzione, così un cambio di firma dello store si
 * vede subito invece di scivolare via.
 */
const barattolo =
  (s: StorageState | null) =>
  async (_topicId: string): Promise<BrowserStorageState | null> =>
    s as never;

test("[⟲] senza pane nativa viva non si delega niente", async () => {
  const registry = createNativeDelegateRegistry(); // nessuno registrato
  const out = await seedNativeFromShared("ctx", {
    registry,
    load: barattolo(CONDIVISO),
    memo: memoNuova(),
  });
  expect(out).toEqual({ ok: false, skipped: "no-native-pane" });
});

test("[⟲] i cookie della sessione condivisa arrivano sulla WKWebView", async () => {
  const { registry, seen } = scriptedRegistry({ result: { cookies: 1, origins: 0 } });
  const out = await seedNativeFromShared("ctx", {
    registry,
    load: barattolo(CONDIVISO),
    memo: memoNuova(),
  });
  expect(out).toEqual({ ok: true, cookies: 1 });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.tool).toBe("browser_load_state");
});

test("[⟲] NON naviga la pane dell'utente per posare il localStorage", async () => {
  // `browser_load_state` lato nativo, per seminare il localStorage, VISITA ogni
  // origine e poi torna indietro. Fatto a mano dall'agente va benissimo; fatto
  // da solo a ogni flip vorrebbe dire strappare la pagina sotto gli occhi di
  // chi guarda. Qui passano solo i cookie — che sono la sessione, per la quasi
  // totalità dei login.
  const { registry, seen } = scriptedRegistry({ result: { cookies: 1, origins: 0 } });
  await seedNativeFromShared("ctx", { registry, load: barattolo(CONDIVISO), memo: memoNuova() });
  const args = seen[0]!.args as { state: StorageState };
  expect(args.state.origins).toEqual([]);
  expect(args.state.cookies).toEqual(CONDIVISO.cookies);
});

test("[⟲] un barattolo vuoto non viene applicato", async () => {
  const { registry, seen } = scriptedRegistry({ result: { cookies: 0, origins: 0 } });
  const vuoto = await seedNativeFromShared("ctx", {
    registry, load: barattolo({ cookies: [], origins: [] }), memo: memoNuova(),
  });
  expect(vuoto).toEqual({ ok: false, skipped: "empty" });
  const assente = await seedNativeFromShared("ctx", {
    registry, load: barattolo(null), memo: memoNuova(),
  });
  expect(assente).toEqual({ ok: false, skipped: "empty" });
  expect(seen).toHaveLength(0);
});

test("[⟲] rifarlo con lo stesso barattolo non ri-tocca la pane", async () => {
  // Il gancio è `register_native_executor`, che riparte a ogni RICONNESSIONE
  // del socket: senza memoria, ogni riconnessione sarebbe una scrittura di
  // cookie sulla pane viva.
  const { registry, seen } = scriptedRegistry({ result: { cookies: 1, origins: 0 } });
  const memo = memoNuova();
  const load = barattolo(CONDIVISO);
  expect(await seedNativeFromShared("ctx", { registry, load, memo })).toEqual({ ok: true, cookies: 1 });
  expect(await seedNativeFromShared("ctx", { registry, load, memo })).toEqual({ ok: false, skipped: "unchanged" });
  expect(seen).toHaveLength(1);
});

test("[⟲] ma un login NUOVO dal telefono riparte", async () => {
  const { registry, seen } = scriptedRegistry({ result: { cookies: 1, origins: 0 } });
  const memo = memoNuova();
  let jar: StorageState = CONDIVISO;
  const load = async (_topicId: string): Promise<BrowserStorageState | null> => jar as never;
  await seedNativeFromShared("ctx", { registry, load, memo });
  jar = { cookies: [{ name: "sid", value: "LOGIN-NUOVO", domain: "example.com", path: "/" }], origins: [] };
  expect(await seedNativeFromShared("ctx", { registry, load, memo })).toEqual({ ok: true, cookies: 1 });
  expect(seen).toHaveLength(2);
});

test("[⟲] il Mac che non risponde non appende il flip", async () => {
  const { registry } = scriptedRegistry(null); // il client non risponde mai
  const t0 = performance.now();
  const out = await seedNativeFromShared("ctx", {
    registry, load: barattolo(CONDIVISO), timeoutMs: 40, memo: memoNuova(),
  });
  expect(out).toMatchObject({ ok: false, skipped: "timeout" });
  expect(performance.now() - t0).toBeLessThan(1000);
});

test("[⟲] un errore del client non diventa un'eccezione, e non viene memorizzato", async () => {
  const { registry, seen } = scriptedRegistry({ error: "pane sparita" });
  const memo = memoNuova();
  const load = barattolo(CONDIVISO);
  expect(await seedNativeFromShared("ctx", { registry, load, memo })).toMatchObject({
    ok: false, skipped: "apply-failed", error: "pane sparita",
  });
  // Non memorizzato ⇒ al prossimo giro ci riprova invece di dirsi già a posto.
  await seedNativeFromShared("ctx", { registry, load, memo });
  expect(seen).toHaveLength(2);
});

test("[⟲] se lo store non si legge non salta nulla in aria", async () => {
  const { registry } = scriptedRegistry({ result: { cookies: 1, origins: 0 } });
  const out = await seedNativeFromShared("ctx", {
    registry, load: async (_topicId: string): Promise<BrowserStorageState | null> => { throw new Error("disco rotto"); }, memo: memoNuova(),
  });
  expect(out).toEqual({ ok: false, skipped: "empty" });
});

test("[⟲] confinato al suo contesto", async () => {
  const { registry, seen } = scriptedRegistry({ result: { cookies: 1, origins: 0 } }, "ctx-A");
  const memo = memoNuova();
  await seedNativeFromShared("ctx-A", { registry, load: barattolo(CONDIVISO), memo });
  const altro = await seedNativeFromShared("ctx-B", { registry, load: barattolo(CONDIVISO), memo });
  expect(altro).toEqual({ ok: false, skipped: "no-native-pane" });
  expect(seen).toHaveLength(1);
});
