/**
 * Does a menu in the landing demo hide what is behind it?
 *
 * A `.glass-surface` menu paints 72% translucent over a 24px backdrop blur.
 * In a plain browser the blur does not reach the panes behind, so the seam
 * between two panes (terminal | browser) showed through the menu as a sharp
 * step. Either a real blur (a gradient) or a solid fill (no step) is fine; a
 * sharp step is the defect.
 *
 * Method: with the menu open, shoot its rectangle twice, once with the menu
 * hidden (what is behind) and once shown. Find the strongest vertical edge
 * behind it, then compare the luminance step across that same x in both
 * shots. The step is the MEDIAN over rows, so text rows of the menu do not
 * count. The menu must keep at most STEP_RATIO of the step behind it.
 *
 * Imported by scripts/check-demo.mjs; not run on its own.
 */
const MIN_STEP = 10;     // luminance levels (0-255) the seam must show to be measurable
const STEP_RATIO = 0.12; // a bare 72% fill leaks 0.28 of the step
const BAND = [2, 8];     // columns, on each side of the edge, averaged

const MENU = '[data-testid="profile-menu"].glass-surface'; // the identity menu

const DECODE = async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      row[x] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    rows.push(Array.from(row));
  }
  return rows;
};

const mean = (row, from, to) => {
  let t = 0;
  for (let x = from; x < to; x++) t += row[x];
  return t / (to - from);
};
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const stepAt = (rows, x) =>
  median(rows.map((r) => Math.abs(mean(r, x + BAND[0], x + BAND[1]) - mean(r, x - BAND[1], x - BAND[0]))));

async function shoot(page, decoder, clip) {
  const png = await page.screenshot({ clip });
  return decoder.evaluate(DECODE, png.toString('base64'));
}

/** One scheme: returns { behind, with, x } or null when the seam is too faint to judge. */
async function measureOnce(page, decoder, clip) {
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => { e.style.visibility = 'hidden'; }), MENU);
  await page.waitForTimeout(150);
  const behind = await shoot(page, decoder, clip);
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => { e.style.visibility = ''; }), MENU);
  await page.waitForTimeout(150);
  const shown = await shoot(page, decoder, clip);

  const width = behind[0].length;
  let best = { x: -1, step: 0 };
  for (let x = BAND[1]; x < width - BAND[1]; x++) {
    const s = stepAt(behind, x);
    if (s > best.step) best = { x, step: s };
  }
  if (best.step < MIN_STEP) return null;
  return { x: best.x, behind: best.step, with: stepAt(shown, best.x) };
}

/**
 * @returns {Promise<string[]>} problems; empty when the menu hides the seam.
 */
export async function glassProblems(page, browser) {
  const problems = [];
  const menu = page.locator(MENU).first();
  if (!(await menu.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) {
    return ['glass: the identity menu is not open, so the seam under it could not be measured'];
  }
  const box = await menu.boundingBox();
  if (!box) return ['glass: the menu has no box'];
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height) };
  const decoder = await browser.newPage();
  await decoder.setContent('<canvas></canvas>');
  try {
    const wasDark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    for (const dark of [wasDark, !wasDark]) {
      const name = dark ? 'dark' : 'light';
      await page.evaluate((d) => document.documentElement.classList.toggle('dark', d), dark);
      await page.waitForTimeout(300);
      const m = await measureOnce(page, decoder, clip);
      if (!m) {
        // The theme the demo boots in has to be measurable; the flipped one may have a faint seam.
        if (dark === wasDark) problems.push(`glass (${name}): no seam of at least ${MIN_STEP} levels behind the menu, nothing to measure`);
        else console.log(`check:demo glass (${name}): seam too faint behind the menu, skipped`);
        continue;
      }
      console.log(`check:demo glass (${name}): step behind ${m.behind.toFixed(1)}, through the menu ${m.with.toFixed(1)}`);
      if (m.with > m.behind * STEP_RATIO) {
        problems.push(`glass (${name}): the seam behind the menu shows through as a sharp step (${m.with.toFixed(1)} of ${m.behind.toFixed(1)} luminance levels at x=${m.x}); the menu must blur or cover it`);
      }
    }
  } finally {
    await decoder.close();
  }
  return problems;
}
