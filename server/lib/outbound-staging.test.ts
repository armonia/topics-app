/**
 * THE COPIES THE CONFIRMATION IS ABOUT.
 *
 * The route-level proof that a file swapped during the wait does not leave is
 * in `routes/outbound.test.ts`; what is measured here is what that copy costs
 * when nobody answers - because the bridge polls, and a naive freeze would
 * write the same attachment 600 times and leave it behind for good.
 * @covers OUTBOUND-04
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardStaging, freezeAttachments, OutboundStagingError } from "./outbound-staging";

const root = realpathSync(mkdtempSync(join(tmpdir(), "outbound-staging-")));
const STAGING = join(root, "staging");
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function source(name: string, content: string): { path: string; name: string } {
  const path = join(root, name);
  writeFileSync(path, content, "utf8");
  return { path, name };
}

describe("freezeAttachments", () => {
  test("i byte congelati sono una COPIA fuori dal workspace, con la loro impronta", () => {
    const file = source("preventivo.pdf", "%PDF-finto");
    const frozen = freezeAttachments("topic:uno", [file], { root: STAGING });
    expect(frozen.files).toHaveLength(1);
    expect(frozen.files[0].path.startsWith(STAGING)).toBe(true);
    expect(frozen.files[0].path).not.toBe(file.path);
    expect(frozen.files[0].name).toBe("preventivo.pdf");
    expect(frozen.files[0].bytes).toBe(10);
    expect(frozen.files[0].sha256).toMatch(/^[0-9a-f]{8}$/);
    expect(readFileSync(frozen.files[0].path, "utf8")).toBe("%PDF-finto");
    discardStaging(frozen.dir);
    expect(existsSync(frozen.dir)).toBe(false);
  });

  test("le gambe successive non fanno una copia per gamba, i byte cambiati si", () => {
    // 600 legs of 25 seconds is four hours of the same question: a fresh
    // directory per leg would be 600 copies of the same attachment.
    const file = source("relazione.txt", "versione uno");
    const first = freezeAttachments("topic:due", [file], { root: STAGING });
    const second = freezeAttachments("topic:due", [file], { root: STAGING });
    expect(second.dir).toBe(first.dir);
    writeFileSync(file.path, "versione DUE", "utf8");
    const third = freezeAttachments("topic:due", [file], { root: STAGING });
    // Other bytes, other directory - and upstream, other digest and a new
    // question: the person is asked about the file that exists now.
    expect(third.dir).not.toBe(first.dir);
    expect(third.files[0].sha256).not.toBe(first.files[0].sha256);
    expect(readFileSync(first.files[0].path, "utf8")).toBe("versione uno");
    discardStaging(first.dir);
    discardStaging(third.dir);
  });

  test("due allegati omonimi restano due file, col nome che la persona ha letto", () => {
    mkdirSync(join(root, "sotto"), { recursive: true });
    const a = source("nota.txt", "prima");
    const b = { path: join(root, "sotto", "nota.txt"), name: "nota.txt" };
    writeFileSync(b.path, "seconda", "utf8");
    const frozen = freezeAttachments("topic:tre", [a, b], { root: STAGING });
    expect(frozen.files.map((f) => f.name)).toEqual(["nota.txt", "nota.txt"]);
    expect(readFileSync(frozen.files[0].path, "utf8")).toBe("prima");
    expect(readFileSync(frozen.files[1].path, "utf8")).toBe("seconda");
    discardStaging(frozen.dir);
  });

  test("quello che nessuna casella accetterebbe non entra nella RAM del server", () => {
    // Before the freeze the size of an attachment was the CLI's problem; now
    // the bytes come through this process, and 25 MB is where a mailbox stops
    // anyway.
    const big = join(root, "enorme.bin");
    writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
    expect(() => freezeAttachments("topic:quattro", [{ path: big, name: "enorme.bin" }], { root: STAGING }))
      .toThrow(OutboundStagingError);
  });

  test("le copie di una conferma che nessuno ha mai chiuso non restano li' per sempre", () => {
    const file = source("vecchio.txt", "residuo");
    const stale = freezeAttachments("topic:cinque", [file], { root: STAGING });
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(stale.dir, sevenHoursAgo, sevenHoursAgo);
    // The next freeze is the only moment this code runs again: a server killed
    // between the question and the answer comes back through here or nowhere.
    const fresh = freezeAttachments("topic:sei", [source("nuovo.txt", "vivo")], { root: STAGING });
    expect(existsSync(stale.dir)).toBe(false);
    expect(existsSync(fresh.dir)).toBe(true);
    discardStaging(fresh.dir);
  });

  test("un file che sparisce fra la scelta e il congelamento e' un rifiuto, non un invio a meta'", () => {
    expect(() => freezeAttachments("topic:sette", [{ path: join(root, "mai-esistito.txt"), name: "mai-esistito.txt" }], { root: STAGING }))
      .toThrow(OutboundStagingError);
  });

  test("nessun allegato, nessuna cartella", () => {
    const frozen = freezeAttachments("topic:otto", [], { root: join(root, "mai-creata") });
    expect(frozen).toEqual({ dir: "", files: [] });
    expect(existsSync(join(root, "mai-creata"))).toBe(false);
  });
});

describe("discardStaging", () => {
  test("una cartella gia' sparita non e' un errore", () => {
    expect(() => discardStaging(join(STAGING, "mai-esistita"))).not.toThrow();
    expect(() => discardStaging("")).not.toThrow();
    // And the staging root survives its own tenants.
    expect(readdirSync(STAGING).length >= 0).toBe(true);
  });
});
