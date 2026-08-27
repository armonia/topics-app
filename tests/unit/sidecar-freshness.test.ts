/**
 * @covers UPDATER-02
 *
 * AN UPDATE THAT DECLARES ITSELF SUCCESSFUL MUST HAVE ARRIVED WHOLE.
 *
 * Measured on a real Windows machine on 2026-08-27, updating 2.2.173 to 2.2.176
 * with the app open and a terminal in use: app.exe, topics-server.exe and
 * webrtc-bridge.exe were replaced, pty-bridge.exe was not. The registry and
 * app.exe both reported 2.2.176. The one file left behind was the only one that
 * was RUNNING: the NSIS installer cannot overwrite a file in use, in silent mode
 * it skips it, and it exits 0.
 *
 * Tauri's template closes exactly one process before copying
 * (`CheckIfAppIsRunning` looks for `${MAINBINARYNAME}.exe` and nothing else), so
 * the sidecars stay alive by construction. The cure lives in two places, and
 * these tests keep them tied to each other:
 *   . `desktop-tauri/src-tauri/installer-hooks.nsh` closes the sidecars before
 *     the copy and, afterwards, fails when one is still locked;
 *   . the shell compares, at startup, the fingerprints of the binaries beside it
 *     with the ones the build shipped, and the version popover says so.
 *
 * What these tests prevent is not the locked file: it is the silence. Add a
 * fourth sidecar to `externalBin` without listing it in the hooks and that
 * binary goes back to being skipped with nobody the wiser.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RADICE = resolve(import.meta.dir, "../..");
const leggi = (p: string) => readFileSync(resolve(RADICE, p), "utf8");

const CONF = JSON.parse(leggi("desktop-tauri/src-tauri/tauri.conf.json"));
const HOOKS = leggi("desktop-tauri/src-tauri/installer-hooks.nsh");
const BUILD_RS = leggi("desktop-tauri/src-tauri/build.rs");
const INTEGRITY_RS = leggi("desktop-tauri/src-tauri/src/sidecar_integrity.rs");
const LIB_RS = leggi("desktop-tauri/src-tauri/src/lib.rs");
const CLIENT = leggi("client/src/lib/sidecarIntegrity.ts");
const POPOVER = leggi("client/src/components/Sidebar/VersionPopover.tsx");
const IT = leggi("client/src/lib/i18n.ts");
const EN = leggi("client/src/lib/i18n-en.ts");

/** The base names declared in `bundle.externalBin` (without `binaries/`). */
const SIDECARS: string[] = (CONF.bundle.externalBin as string[]).map((p) => p.split("/").pop()!);

describe("l'installer Windows non puo' saltare un sidecar in silenzio", () => {
  it("gli hook NSIS sono agganciati alla configurazione", () => {
    expect(CONF.bundle.windows?.nsis?.installerHooks).toBe("installer-hooks.nsh");
  });

  it("OGNI sidecar di externalBin e' chiuso prima della copia", () => {
    // The point of this test: `externalBin` and the hooks are TWO lists, and two
    // lists drift. A sidecar added here and forgotten there is the 27/08 case
    // all over again.
    for (const nome of SIDECARS) {
      expect(HOOKS).toContain(`"${nome}.exe"`);
    }
    expect(HOOKS).toContain("!macro NSIS_HOOK_PREINSTALL");
    expect(HOOKS).toContain("!macro NSIS_HOOK_PREUNINSTALL");
    expect(HOOKS).toContain("KillProcessCurrentUser");
  });

  it("dopo la copia un file rimasto bloccato fa FALLIRE l'installazione", () => {
    // Without this the installer exits 0 on a half applied update, which is the
    // real defect. The locked file is only how it starts.
    expect(HOOKS).toContain("!macro NSIS_HOOK_POSTINSTALL");
    expect(HOOKS).toContain("TopicsVerifySidecar");
    expect(HOOKS).toMatch(/SetErrorLevel\s+[1-9]/);
  });
});

describe("il guscio verifica le impronte, non solo il numero di versione", () => {
  it("la build registra un'impronta per gli stessi sidecar", () => {
    for (const nome of SIDECARS) {
      expect(BUILD_RS).toContain(`"${nome}"`);
    }
    expect(BUILD_RS).toContain("TOPICS_SIDECAR_FINGERPRINTS");
    expect(INTEGRITY_RS).toContain("TOPICS_SIDECAR_FINGERPRINTS");
  });

  it("il confronto byte a byte vale solo dove i byte sono quelli costruiti", () => {
    // On macOS the same sidecar is lipo'd into a universal binary and signed:
    // its bytes legitimately differ from the ones in `binaries/`, and a check
    // that cries wolf at every launch gets turned off. The failure we are after
    // is the NSIS one anyway.
    expect(BUILD_RS).toContain('if !target.contains("windows")');
  });

  it("una build senza impronte non accusa nessuno", () => {
    // A check that cries wolf in dev is off within the week: with no manifest
    // the verdict is "not checked", never "broken".
    expect(INTEGRITY_RS).toContain("fn unchecked");
    expect(CLIENT).toContain("report.checked");
  });

  it("il comando esposto dal guscio e quello chiamato dal client hanno lo stesso nome", () => {
    // Two different names switch the check off without breaking anything: the
    // call fails, the client reads `null` and shows nothing.
    expect(LIB_RS).toContain("fn sidecar_integrity()");
    expect(LIB_RS).toContain("            sidecar_integrity,");
    expect(CLIENT).toContain("tauriInvoke<SidecarReport>('sidecar_integrity')");
  });
});

describe("un aggiornamento a meta' si vede dove si legge la versione", () => {
  it("il popover mostra l'avviso quando il verdetto e' negativo", () => {
    expect(POPOVER).toContain("shouldWarnAboutSidecars");
    expect(POPOVER).toContain("version-incomplete-install");
  });

  it("il messaggio esiste in entrambe le lingue e nomina i componenti", () => {
    for (const testo of [IT, EN]) {
      expect(testo).toContain("'version.incompleteInstall'");
      expect(testo).toContain("'version.incompleteInstallDetail'");
    }
    expect(IT).toContain("{names}");
    expect(EN).toContain("{names}");
  });
});
