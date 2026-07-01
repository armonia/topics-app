import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/e2e/global-setup.ts",
  testDir: "./tests/e2e",
  testMatch: "*.spec.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // sequential to avoid race conditions on shared DB
  workers: 1, // single worker: shared DB + capped CPU (avoids the headless-Chrome swarm that pegs the machine)
  retries: 1,
  reporter: [
    ["html", { outputFolder: "test-results/html-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: "http://localhost:13334",
    video: "on", // always record video
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    viewport: { width: 1280, height: 800 },
    launchOptions: { slowMo: 300 }, // 300ms between actions for watchable videos
    permissions: ["clipboard-read", "clipboard-write"],
  },
  outputDir: "test-results/artifacts",
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 375, height: 812 },
        isMobile: true,
      },
      testMatch: "mobile-*.spec.ts",
    },
  ],
});
