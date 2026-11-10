/**
 * scripts/ui-app/walk-runner.mjs - the engine of the guided walks
 * (`ui-app-walk.mjs` for app.html, `ui-orbit-walk.mjs` for orbit.html): opens
 * the built preview in headless WebKit at 1440x900 with a fresh state, runs
 * the steps one after the other and stops on the first one that lands wrong.
 *
 * A step: what to press (`click`, a function returning a locator), or keys
 * (`keys`, a function of the page), or the browser's back button (`back`);
 * then the place expected (`screen`, `hash` exact or `prefix`) and an
 * optional `check(page, memo)` returning an error line or null. `before` runs
 * ahead of the press (to remember a count in `memo`), `expandOnly` skips the
 * place check, `shot` names a capture saved with `--shots`.
 *
 * Options read from the command line: `--theme dark`, `--video <file.webm>`
 * (a pointer is drawn into the page, since a headless browser has none),
 * `--shots <dir>`. One browser, closed at the end. Exits 1 on the first wrong
 * step or on any page error.
 */
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { webkit } from "playwright";
import { arg, collectErrors, serveDist } from "./serve.mjs";

export const theme = arg("theme") ?? "light";
export const video = arg("video") ? resolve(arg("video")) : undefined;
const shots = arg("shots") ? resolve(arg("shots")) : undefined;
const pause = video ? 700 : 0;

/* A pointer the recording can show: headless WebKit draws none. */
export const POINTER = () => {
  const add = () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(10,132,255,.35);border:2px solid #0a84ff;z-index:2147483647;pointer-events:none;transition:transform .12s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.6)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = "none"; }, true);
  };
  if (document.body) add(); else addEventListener("DOMContentLoaded", add);
};

/**
 * Runs a walk. `script` names it in the messages, `entry` is the page
 * (`app` or `orbit`), `start` the first address with its `startScreen`,
 * `startWhat` the line printed for it, `done` the closing line on success.
 */
export async function runWalk({ script, entry = "app", start, startScreen, startWhat, steps, done }) {
  const { base, close } = await serveDist(script, entry);
  const errors = [];
  let failure = null;
  const videoDir = video ? join(tmpdir(), `${script}-${process.pid}`) : undefined;
  if (shots) await mkdir(shots, { recursive: true });

  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: video ? 1 : 2,
      colorScheme: theme === "dark" ? "dark" : "light",
      ...(video ? { recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    if (video) await page.addInitScript(POINTER);
    collectErrors(page, errors);

    /** Waits for the place and checks the address; returns an error line or null. */
    const landed = async (step) => {
      if (step.screen) {
        const ok = await page.waitForSelector(`[data-screen="${step.screen}"]`, { timeout: 6000 }).then(() => true, () => false);
        if (!ok) {
          const on = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
          return `atteso ${step.screen}, c'è ${on ?? "niente"} (${await page.evaluate(() => location.hash)})`;
        }
      }
      const now = await page.evaluate(() => location.hash);
      if (step.hash && now !== step.hash) return `atteso l'indirizzo ${step.hash}, c'è ${now}`;
      if (step.prefix && !now.startsWith(step.prefix)) return `atteso un indirizzo che inizia con ${step.prefix}, c'è ${now}`;
      const on = await page.evaluate(() => document.querySelector("[data-screen]")?.getAttribute("data-screen"));
      if (on === "not-found" || on === "no-access") return `finito su ${on} (${now})`;
      return null;
    };

    await page.goto(`${base}?fresh=1&speed=0.1${theme === "dark" ? "&theme=dark" : ""}#${start}`);
    await page.waitForFunction(() => window.__demo);
    await page.evaluate(() => document.fonts.ready);
    failure = await landed({ screen: startScreen, hash: `#${start}` });
    console.log(`${failure ? "FAIL" : "ok  "}  0  inizio: ${startWhat}${failure ? ` -> ${failure}` : ""}`);

    const memo = {};
    for (const [i, step] of steps.entries()) {
      if (failure) break;
      if (step.before) await step.before(page, memo);
      if (step.back) {
        await page.goBack();
      } else if (step.keys) {
        try { await step.keys(page); } catch (e) {
          failure = `passo ${i + 1} (${step.what}): ${String(e.message).split("\n")[0]}`;
          console.log(`FAIL ${String(i + 1).padStart(2)}  ${step.what} -> ${String(e.message).split("\n")[0]}`);
          break;
        }
      } else {
        const target = step.click(page);
        const found = await target.waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false);
        if (!found) { failure = `passo ${i + 1} (${step.what}): niente da premere`; break; }
        if (video) {
          const box = await target.boundingBox();
          if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
          await page.waitForTimeout(250);
        }
        await target.click();
      }
      let wrong = step.expandOnly ? null : await landed(step);
      if (!wrong && step.check) wrong = await step.check(page, memo);
      console.log(`${wrong ? "FAIL" : "ok  "} ${String(i + 1).padStart(2)}  ${step.what}${wrong ? ` -> ${wrong}` : ""}`);
      if (wrong) { failure = `passo ${i + 1} (${step.what}): ${wrong}`; break; }
      await page.waitForTimeout(pause || 120);
      if (shots && step.shot) await page.screenshot({ path: join(shots, `${step.shot}.png`), animations: "disabled" });
    }

    if (video) await page.waitForTimeout(800);
    const recorded = video ? await page.video()?.path() : undefined;
    await context.close();
    if (recorded) {
      await mkdir(dirname(video), { recursive: true });
      /* The temp folder may sit on another disk (Windows: C: and E:), where a rename cannot go. */
      await rename(recorded, video).catch(() => copyFile(recorded, video));
      await rm(videoDir, { recursive: true, force: true });
      console.log(`video -> ${video}`);
    }
  } finally {
    await browser.close();
    close();
  }

  if (errors.length) console.error(`errori della pagina:\n  ${[...new Set(errors)].join("\n  ")}`);
  if (failure || errors.length) {
    console.error(`${script}: FAIL${failure ? `, ${failure}` : ""}`);
    process.exit(1);
  }
  console.log(done(steps.length));
}
