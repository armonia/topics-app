/**
 * Config per le verifiche contro l'app Windows INSTALLATA, non contro un banco
 * locale: nessun webServer, nessun globalSetup: il server e' quello vero, gia'
 * in esecuzione sul PC e raggiunto via tunnel ssh. Vedi l'intestazione di
 * tests/manual/windows-ui-verify.spec.ts.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/manual",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.TOPICS_WIN_BASE ?? "http://127.0.0.1:51156",
  },
});
