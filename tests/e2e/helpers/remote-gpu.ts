/**
 * Chromium launched by `pw-remote` (~/bin) on the Windows PC, on its real GPU.
 *
 * Headless Chromium draws with SwiftShader: a GPU emulated on the CPU. The PC
 * has an NVIDIA card, and with ANGLE on D3D11 the browser's CPU time drops by
 * about 45% (31-47 s -> 19-21 s per round, measured 2026-11-08 on the Topics
 * demo). The price is the picture: 57% of the pixels change (3.2% by more than
 * 10%), so a spec that compares pixels with `toHaveScreenshot` stays on
 * SwiftShader through `SOFTWARE_RENDER_LAUNCH`.
 *
 * Only with `PW_TEST_CONNECT_WS_ENDPOINT` (pw-remote). In CI (Ubuntu, no GPU)
 * and on a local run the args are empty and nothing changes. The args do reach
 * the remote browser: Playwright's `browser` fixture sends the launch options
 * in the `x-playwright-launch-options` header and `run-server` keeps `args`
 * (`filterLaunchOptions` in playwright-core/lib/remote/playwrightServer.js).
 *
 * `PW_REMOTE_GPU=0` goes back to SwiftShader on the PC too.
 */

const SLOWMO = process.env.E2E_SLOWMO === "1";

export const REMOTE_GPU_ARGS: string[] =
  !!process.env.PW_TEST_CONNECT_WS_ENDPOINT && process.env.PW_REMOTE_GPU !== "0"
    ? ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist"]
    : [];

/** Launch options of the Chromium projects: GPU on the PC, no args elsewhere. */
export const CHROMIUM_LAUNCH = {
  ...(SLOWMO ? { slowMo: 300 } : {}),
  args: REMOTE_GPU_ARGS,
};

/** For specs with `toHaveScreenshot`: SwiftShader everywhere. */
export const SOFTWARE_RENDER_LAUNCH = {
  ...(SLOWMO ? { slowMo: 300 } : {}),
  args: [] as string[],
};
