/**
 * @covers SITEDATA-01
 */
import { test, expect } from "bun:test";
import type { BrowserStorageState } from "./browser-state-store";
import {
  cookieSilo,
  originSilo,
  siteDataRecords,
  originsOfSilos,
  forgetSilosInState,
} from "./browser-site-data";

function cookie(domain: string, name = "sid"): BrowserStorageState["cookies"][number] {
  return {
    name,
    value: "v",
    domain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  };
}

function origin(
  url: string,
  ls: { name: string; value: string }[] = [],
  idb: unknown[] = [],
): BrowserStorageState["origins"][number] {
  return { origin: url, localStorage: ls, ...(idb.length ? { indexedDB: idb } : {}) } as BrowserStorageState["origins"][number];
}

const state = (parts: Partial<BrowserStorageState>): BrowserStorageState =>
  ({ cookies: [], origins: [], ...parts }) as BrowserStorageState;

test("il punto iniziale del dominio non fa due barattoli", () => {
  expect(cookieSilo(".github.com")).toBe("github.com");
  expect(cookieSilo("GitHub.com")).toBe("github.com");
  // Il `www.` resta: `www.example.com` è davvero un altro silo.
  expect(cookieSilo("www.example.com")).toBe("www.example.com");
});

test("di un origin conta l'host, non lo schema", () => {
  expect(originSilo("https://app.foo.io")).toBe("app.foo.io");
  expect(originSilo("http://app.foo.io")).toBe("app.foo.io");
  expect(originSilo("non-una-url")).toBe("");
});

test("cookie e origin dello stesso host sono UNA riga con due tipi", () => {
  const records = siteDataRecords(
    state({
      cookies: [cookie(".example.com")],
      origins: [origin("https://example.com", [{ name: "k", value: "v" }])],
    }),
  );
  expect(records).toEqual([{ displayName: "example.com", types: ["cookies", "localStorage"] }]);
});

test("indexedDB compare come tipo suo, e i nomi tornano in ordine", () => {
  const records = siteDataRecords(
    state({
      cookies: [cookie("zeta.dev")],
      origins: [origin("https://alfa.dev", [], [{ name: "db", version: 1, stores: [] }])],
    }),
  );
  expect(records).toEqual([
    { displayName: "alfa.dev", types: ["indexedDB"] },
    { displayName: "zeta.dev", types: ["cookies"] },
  ]);
});

test("un origin visitato ma VUOTO non è un sito da dimenticare", () => {
  // Playwright elenca l'origin anche quando non ci ha salvato niente. Una riga
  // per lui sarebbe un tasto che non cancella nulla.
  expect(siteDataRecords(state({ origins: [origin("https://vuoto.dev")] }))).toEqual([]);
});

test("stato assente o illeggibile: nessun record, nessun errore", () => {
  expect(siteDataRecords(null)).toEqual([]);
  expect(siteDataRecords(undefined)).toEqual([]);
  expect(siteDataRecords(state({}))).toEqual([]);
});

test("un sottodominio è un silo SUO: dimenticare il padre non lo tocca", () => {
  // È la differenza col nativo, ed è il motivo per cui qui i nomi si possono
  // dare precisi: WebKit metterebbe tutto sotto `google.com`.
  const s = state({
    cookies: [cookie(".google.com"), cookie("mail.google.com")],
    origins: [origin("https://mail.google.com", [{ name: "draft", value: "x" }])],
  });
  expect(siteDataRecords(s).map((r) => r.displayName)).toEqual(["google.com", "mail.google.com"]);
  const { state: after, removed } = forgetSilosInState(s, ["google.com"]);
  expect(removed).toBe(1);
  expect(siteDataRecords(after)).toEqual([
    { displayName: "mail.google.com", types: ["cookies", "localStorage"] },
  ]);
});

test("si cancella per NOME: i due nomi mostrati, e solo quelli", () => {
  const s = state({
    cookies: [cookie(".example.com"), cookie("altro.dev")],
    origins: [
      origin("https://example.com", [{ name: "k", value: "v" }]),
      origin("https://altro.dev", [{ name: "k", value: "v" }]),
    ],
  });
  const { state: after, removed } = forgetSilosInState(s, ["example.com"]);
  expect(removed).toBe(1);
  expect(after.cookies.map((c) => c.domain)).toEqual(["altro.dev"]);
  expect(after.origins.map((o) => o.origin)).toEqual(["https://altro.dev"]);
});

test("un nome che nel barattolo non c'era non si conta come cancellato", () => {
  const s = state({ cookies: [cookie("example.com")] });
  expect(forgetSilosInState(s, ["mai-visto.dev"]).removed).toBe(0);
  expect(forgetSilosInState(s, []).removed).toBe(0);
  // Lista vuota: lo stato torna com'era, senza copie inutili.
  expect(forgetSilosInState(s, []).state).toBe(s);
});

test("gli origin di un silo tornano con tutti i loro schemi", () => {
  const s = state({
    origins: [
      origin("https://foo.io", [{ name: "k", value: "v" }]),
      origin("http://foo.io", [{ name: "k", value: "v" }]),
      origin("https://bar.io", [{ name: "k", value: "v" }]),
    ],
  });
  expect(originsOfSilos(s, ["foo.io"]).sort()).toEqual(["http://foo.io", "https://foo.io"]);
  expect(originsOfSilos(s, [])).toEqual([]);
});
