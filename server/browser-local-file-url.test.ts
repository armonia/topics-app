/**
 * @covers LOCALURL-01
 */
import { test, expect, describe, afterEach } from "bun:test";
import {
  localPathOf,
  toServableUrl,
  setLocalFileServing,
  isMediaRef,
  type LocalFileServing,
} from "./browser-local-file-url";

const ALLOWED = "/Users/x/.topics/media/contratto.pdf";
const OUTSIDE = "/etc/passwd";

const deps: LocalFileServing = {
  isPathAllowed: (p) => p.startsWith("/Users/x/.topics/media/"),
  resolveProjectPath: (p) => (p.startsWith("/Users/x/proj/") ? p : null),
  exists: () => true,
  origin: "https://127.0.0.1:3333",
};

afterEach(() => setLocalFileServing(null));

describe("localPathOf", () => {
  test("riconosce file:// e i path assoluti nudi", () => {
    expect(localPathOf(`file://${ALLOWED}`)).toBe(ALLOWED);
    expect(localPathOf(ALLOWED)).toBe(ALLOWED);
    expect(localPathOf(`file://localhost${ALLOWED}`)).toBe(ALLOWED);
  });

  test("gli spazi nel nome sopravvivono al giro per URL", () => {
    expect(localPathOf("file:///Users/x/.topics/media/il%20contratto.pdf")).toBe(
      "/Users/x/.topics/media/il contratto.pdf",
    );
  });

  test("non è affare suo tutto ciò che non è un file locale", () => {
    for (const raw of ["https://x.com", "http://127.0.0.1:3000", "about:blank", "data:text/html,x", "cerca questo"]) {
      expect(localPathOf(raw)).toBeNull();
    }
  });

  test("un file su un'ALTRA macchina non è un file locale", () => {
    expect(localPathOf("file://nas.local/share/x.pdf")).toBeNull();
  });
});

describe("toServableUrl", () => {
  test("un file servibile diventa un URL http di QUESTO server", () => {
    const out = toServableUrl(`file://${ALLOWED}`, deps);
    expect(out).toEqual({
      kind: "rewritten",
      url: `https://127.0.0.1:3333/api/media?path=${encodeURIComponent(ALLOWED)}`,
      ref: `/api/media?path=${encodeURIComponent(ALLOWED)}`,
      path: ALLOWED,
    });
  });

  test("lo schema NON si allenta: quello che esce è http(s), mai file", () => {
    const out = toServableUrl(`file://${ALLOWED}`, deps);
    expect(out.kind).toBe("rewritten");
    if (out.kind !== "rewritten") throw new Error("unreachable");
    expect(new URL(out.url).protocol).toBe("https:");
  });

  // Il difetto che questo chiude: il server si serve su TRE origini diverse
  // (TLS su 3333, proxy in chiaro dell'app su 13333, host di LAN per il
  // telefono). Un assoluto cablato qui è giusto per uno e bianco per gli altri
  // due, quindi il riferimento relativo è la parte che conta.
  test("il ref è relativo: lo risolve chi naviga, sulla SUA origine", () => {
    const out = toServableUrl(`file://${ALLOWED}`, deps);
    if (out.kind !== "rewritten") throw new Error("unreachable");
    expect(out.ref.startsWith("/api/media?path=")).toBe(true);
    expect(isMediaRef(out.ref)).toBe(true);
    expect(new URL(out.ref, "http://127.0.0.1:13333").toString()).toBe(
      `http://127.0.0.1:13333${out.ref}`,
    );
  });

  // Il difetto visto dal vivo: la stessa navigazione passa di qui DUE volte (la
  // rotta open-pane per annunciarla alla finestra, il dispatcher per applicarla
  // a tutti i rami). Al secondo giro il riferimento sembrava un path assoluto e
  // veniva rifiutato come «fuori dai percorsi consentiti» — un percorso appena
  // approvato. Riscrivere due volte deve essere come riscrivere una volta.
  test("riscrivere due volte è come riscriverne una", () => {
    const once = toServableUrl(`file://${ALLOWED}`, deps);
    if (once.kind !== "rewritten") throw new Error("unreachable");
    expect(toServableUrl(once.ref, deps)).toEqual({ kind: "not-local" });
    expect(toServableUrl(once.url, deps)).toEqual({ kind: "not-local" });
  });

  test("fuori dall'allowlist si rifiuta, e si dice PERCHÉ", () => {
    const out = toServableUrl(`file://${OUTSIDE}`, deps);
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") throw new Error("unreachable");
    expect(out.reason).toContain(OUTSIDE);
    expect(out.reason).toContain("outside the paths");
    // Il motivo sbagliato è il difetto che stiamo chiudendo: mai più «schema
    // non permesso» quando il vero problema è il permesso sul percorso.
    expect(out.reason).not.toContain("scheme");
  });

  test("un file dentro un progetto aperto passa dal ripiego", () => {
    const out = toServableUrl("file:///Users/x/proj/build/report.html", deps);
    expect(out.kind).toBe("rewritten");
  });

  test("«non esiste» e «non si può» sono due risposte diverse", () => {
    const out = toServableUrl(`file://${ALLOWED}`, { ...deps, exists: () => false });
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") throw new Error("unreachable");
    expect(out.reason).toContain("does not exist");
  });

  test("http/https/about/data restano fuori dalla riscrittura", () => {
    for (const raw of ["https://x.com", "about:blank", "data:text/html,x"]) {
      expect(toServableUrl(raw, deps)).toEqual({ kind: "not-local" });
    }
  });

  test("senza cablaggio non inventa: rifiuta, non riscrive", () => {
    expect(toServableUrl(`file://${ALLOWED}`, null).kind).toBe("refused");
  });

  test("il singleton è la sorgente di default", () => {
    setLocalFileServing(deps);
    expect(toServableUrl(`file://${ALLOWED}`).kind).toBe("rewritten");
  });
});
