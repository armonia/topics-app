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
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
    // The whole hash is what gets re-checked before the spawn; its head is
    // what the person reads in the question.
    expect(frozen.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.files[0].shortSha).toBe(frozen.files[0].sha256.slice(0, 8));
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

  // The title above says "does not enter the RAM" and the assertion under it
  // only says "throws": 26 MB read whole and then refused passes it. What the
  // ceiling is FOR is the size being known before the read, and the only way to
  // measure that from outside is a file that can be STATTED and not READ.
  test.skipIf(process.getuid?.() === 0)("il tetto si misura PRIMA di leggere, non sui byte gia' in RAM", () => {
    const sparse = join(root, "sparso.bin");
    const fd = openSync(sparse, "w");
    ftruncateSync(fd, 64 * 1024 * 1024);
    closeSync(fd);
    // Unreadable, statable: the old order (read, then measure) can only report
    // the permission error, the new one reports the ceiling.
    chmodSync(sparse, 0o000);
    expect(() => freezeAttachments("topic:sparso", [{ path: sparse, name: "sparso.bin" }], { root: STAGING }))
      .toThrow(/25 MB/);
    chmodSync(sparse, 0o600);
  });

  test("un allegato che non e' un file regolare e' un rifiuto, non un server fermo", () => {
    // `mkfifo report.csv` in its own worktree is one command, and a blocking
    // read of a pipe with no writer never returns: not this request, the whole
    // event loop, before anybody has been asked anything. The test proves the
    // refusal; that it does not hang is the point of it.
    const pipe = join(root, "tubo.csv");
    if (existsSync(pipe)) rmSync(pipe);
    execFileSync("mkfifo", [pipe]);
    expect(() => freezeAttachments("topic:tubo", [{ path: pipe, name: "tubo.csv" }], { root: STAGING }))
      .toThrow(OutboundStagingError);
  });

  test("una copia PIANTATA in anticipo non e' la copia che parte", () => {
    // Server and agent run under the SAME uid, so 0700 keeps other users out
    // and not the agent. What kept it out was supposed to be the name - and the
    // name was derived from the two things the agent knows best: its own
    // session key and the bytes it is about to attach. It computes the
    // directory, plants a secret in it, and calls send_mail: the copy that is
    // "already there" is the one that leaves.
    const sessionKey = "topic:piantato";
    const innocent = "contenuto innocente";
    const file = source("piantato.txt", innocent);
    const sha = createHash("sha256").update(innocent).digest("hex");
    const derived = createHash("sha256")
      .update(sessionKey).update("\x00").update(`piantato.txt:${sha}`)
      .digest("hex").slice(0, 16);
    mkdirSync(join(STAGING, derived, "0"), { recursive: true });
    writeFileSync(join(STAGING, derived, "0", "piantato.txt"), "TOKEN=segreto-rubato", "utf8");
    const frozen = freezeAttachments(sessionKey, [file], { root: STAGING });
    expect(readFileSync(frozen.files[0].path, "utf8")).toBe(innocent);
    // And no directory of this send carries a name anybody could have computed.
    expect(frozen.dir).not.toBe(join(STAGING, derived));
    discardStaging(frozen.dir);
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
