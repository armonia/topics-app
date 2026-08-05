/* ═══════════════════════════════════════════════════════════════════════════
   THE FIELD — one fluid, lit like a solid, driven by the scroll.

   WHAT THIS REPLACES AND WHY
   The page used to be four opaque ink bands with a CSS aurora clipped into
   each, separated by 240px gradient blocks. Three things were wrong with it and
   they were all the same thing: the background was made of PIECES.

     · Four bands meant four glows, each sized to its band, so the light ran out
       in the middle of a long section — act 3 measured 0.49% vivid pixels while
       act 1 measured 3.85%.
     · The joins had to be dissolved over 960px of empty gradient, and the far
       end of a dissolve to paper IS paper, so the bottom half of every seam was
       white on its way to a white section: 240px of page that says nothing.
     · Two grounds meant two palettes, and a reader crossing a seam sees the
       colour scheme change for reasons that belong to the CSS, not the argument.

   One surface, continuous from the first pixel to the last, removes all three.
   There is nothing to join, the light never runs out because it is regenerated
   per frame at the viewport, and the palette has one story.

   HOW IT READS AS THREE-DIMENSIONAL
   It is a height field, not a picture of one. Two rounds of domain warping
   (`fbm(p + fbm(p + fbm(p)))`) give the flow its curl — that is what stops it
   looking like blurred blobs. The height is then LIT: the normal comes from
   finite differences of the same field and feeds a specular term, so the ridges
   catch a highlight and the troughs go to ink. A blurred gradient can be
   beautiful; only a lit surface has a direction the eye can follow.

   WHAT THE SCROLL ACTUALLY CHANGES
   Not the position — a background that only translates is a parallax trick and
   the eye reads it as a poster sliding past. Five things are functions of page
   progress, so the surface at 70% is not the surface at 10% moved down:

     flow      how far the field warps itself   0.55 → 1.30 → 0.70
     light     the azimuth of the key light     rotates ~150°
     ember     the agent hue, absent at both ends, present through the acts
     lift      vertical drift, the only term that is a translation
     calm      near the close the octaves settle and the surface goes glassy

   COST
   Rendered at 55% of CSS pixels and stretched: a fluid has no edges to alias,
   so the only thing full resolution buys is heat. DPR is capped at 1.5 for the
   same reason. Roughly 16 noise taps per pixel at ~0.55 scale is about a third
   of the fragment work of the same shader at DPR 2 and full scale.

   It stops when it is not being looked at (`document.hidden`), it never starts
   if the visitor asked for less motion (one static frame instead), and if WebGL
   is missing the CSS field underneath is already a complete picture.
   ═════════════════════════════════════════════════════════════════════════ */

export {};

const fieldCanvas = document.querySelector<HTMLCanvasElement>('#field');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

/* The palette is the brand's, not a shader author's idea of blue:
   #0a0d14 ground · #0066ff brand · #4d94ff its dark step · #d97757 the agent
   ember, which is the colour the product's own tab bar paints Claude with. */
const FRAG = `
/* NOTE — this is a template literal. A backtick anywhere inside it, including
   inside a comment, ends the string and breaks the build. Written down because
   it has now cost four builds. */
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform float uScroll;
uniform vec2  uPtr;
uniform float uPtrOn;
uniform float uGain;

/* SATURATION IS FREE, LUMINANCE IS NOT, and this palette is that sentence.
   The cap at the bottom of main() fixes how much LIGHT the surface may put
   behind a glyph. It says nothing about chroma — and blue carries only 7% of
   the luminance weight — so the way to a surface that is both legal and
   coloured is to spend the whole budget on the bluest blue rather than on a
   lighter one.
   Measured, on the page's own vivid-pixel test (channel span > 70/255): the
   body target was #0066ff and the field's brightest pixel came out rgb(27 46 82),
   span 55, which is BELOW the threshold — a field with plenty of hue and no
   vivid pixels at all, and the middle third of the page measured 0.0%. The same
   luminance spent on this deeper blue lands at rgb(0 34 128), span 128.
   DEEP is not the brand step and is not meant to be: the brand is what the
   buttons are painted with, at full strength, where the click goes. This is the
   same hue with the light taken out of it. */
const vec3 GROUND = vec3(0.039, 0.051, 0.078);
const vec3 DEEP   = vec3(0.000, 0.230, 1.000);
const vec3 BRAND  = vec3(0.000, 0.400, 1.000);
const vec3 BRIGHT = vec3(0.180, 0.520, 1.000);
const vec3 EMBER  = vec3(0.890, 0.380, 0.220);

float hash(vec2 p){
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

/* Three octaves is enough under this much warping — the warp supplies the
   detail that extra octaves would, at a fraction of the taps. */
float fbm3(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++){
    v += a * noise(p);
    p = p * 2.02 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return v;
}

float fbm4(vec2 p, float calm){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){
    v += a * noise(p);
    p = p * 2.03 + vec2(8.3, 2.8);
    a *= 0.5 + calm * 0.06;
  }
  return v;
}

/* The height field: q is the first warp, r the second. Two rounds rather than
   one because a single warp curls the field and a second one folds it, and the
   fold is what stops the result reading as blurred blobs. */
float surface(vec2 p, float t, float flow, float calm){
  vec2 q = vec2(fbm3(p + vec2(0.0, t * 0.13)),
                fbm3(p + vec2(5.2, 1.3) - vec2(t * 0.11, 0.0)));
  vec2 r = vec2(fbm3(p + flow * q + vec2(1.7, 9.2) + t * 0.07),
                fbm3(p + flow * q + vec2(8.3, 2.8) - t * 0.05));
  return fbm4(p + flow * r, calm);
}

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 uv   = frag / uRes;
  /* Aspect-corrected so the flow is not stretched on a wide window. */
  vec2 p = (frag - 0.5 * uRes) / min(uRes.x, uRes.y);

  float s = clamp(uScroll, 0.0, 1.0);
  float t = uTime;

  /* ── the five scroll terms ─────────────────────────────────────────────
     flow peaks in the middle of the page, which is where the five acts are:
     the surface is at its most turbulent exactly where the argument is. */
  float flow  = 0.55 + 1.05 * sin(s * 3.14159) * (0.55 + 0.45 * s) ;
  float light = 0.55 + s * 2.6;
  float calm  = smoothstep(0.68, 1.0, s);
  float ember = smoothstep(0.12, 0.36, s) * (1.0 - smoothstep(0.62, 0.86, s));
  /* TWO RATES, and separating them is what fixed a real defect.
     lift translates the NOISE, and it used to be the same 1.35 that moves the
     pools. Over a 12,400px page that is 1.35 units of a field whose features are
     about 0.6 units across, so the whole page showed barely two features' worth
     of the surface — and a trough in the noise therefore lasted thousands of
     pixels. Measured: from the third act to the limits, four consecutive
     screens, the brightest pixel anywhere on screen had a channel span of 70
     against 120 in the hero and 122 at the close. The field was not weaker
     there by design; the page was simply sitting in a low patch for 3,600px.
     At 3.6 the surface turns over roughly six times between the top and the
     bottom, which is also the honest reading of "evolves as you scroll" — the
     same light moved down is a parallax, a different part of the field is a
     different picture.
     The POOLS keep the slower rate: they are the composition, and a composition
     that changes six times is not one. */
  float lift  = s * 2.4;
  float drift = s * 1.35;

  vec2 sp = p * (1.9 - 0.35 * calm) + vec2(0.0, lift);

  float h = surface(sp, t, flow, calm);

  /* The normal, from the same field two taps away. The epsilon is in the same
     units as the sample point, so the relief keeps scale as the field zooms. */
  float e = 0.014;
  float hx = surface(sp + vec2(e, 0.0), t, flow, calm) - surface(sp - vec2(e, 0.0), t, flow, calm);
  float hy = surface(sp + vec2(0.0, e), t, flow, calm) - surface(sp - vec2(0.0, e), t, flow, calm);
  vec3  n  = normalize(vec3(-hx, -hy, 0.115));

  vec3 L = normalize(vec3(cos(light), sin(light), 0.75));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float diff = max(dot(n, L), 0.0);
  /* A SHEEN, NOT A GLINT. The exponent was 26 rising to 60, which is a hard
     specular: a highlight a few pixels wide, on a normal that is itself derived
     from noise, at a render scale of 0.55. Measured, that term ALONE was the
     whole of the surface's roughness — turning it off dropped the adjacent-pixel
     step from 6/255 to 2 at every one of the seven samples, and 6 is a value the
     eye reads as stepping and a moving frame reads as shimmer.
     A broad exponent spreads the same energy over a wider band, so the ridges
     still catch the light and the gradient between neighbours stays gentle. */
  float spec = pow(max(dot(n, normalize(L + V)), 0.0), 9.0 + 7.0 * calm);
  /* Fresnel-ish rim: the steeper the slope the more it catches, which is what
     makes the ridges read as edges of a body rather than as brighter paint. */
  float rim  = pow(1.0 - max(n.z, 0.0), 2.4);

  /* ── THE CHANNEL ────────────────────────────────────────────────────────
     The reading column runs down the MIDDLE of this page, so a glow that is
     brightest in the middle spends its contrast budget on exactly the pixels
     that cannot afford it. Measured, before this term existed: the long-tail
     prose at 16px painted 2.00:1 over rgb(70 119 208), and 74 runs failed.

     The channel opens only BELOW the hero. In the hero the middle can be as
     bright as the references are, because everything over it there is either
     66px display type at 17:1 or the opaque frame of the app; from the first
     section down, everything over it is 13-to-16px prose. The hue and the
     motion stay: it is the amplitude that steps aside, which is why the page
     still reads as one continuous surface rather than as a light with a hole
     in it. */
  float column = smoothstep(0.42, 0.06, abs(uv.x - 0.5));
  float open   = smoothstep(0.04, 0.16, s);
  float channel = 1.0 - column * open * 0.72;

  /* ── the body ───────────────────────────────────────────────────────────
     Two pools, so the light has somewhere to be and somewhere not to be, and
     they move at different rates: the surface never repeats within a scroll. */
  /* THE POOLS MOVE OUTWARD AS THE CHANNEL OPENS, and that is not decoration —
     it is the other half of the same decision. The channel dims the surface
     down the middle to protect the reading column; if the light stays where it
     was, the result is a page whose glow is exactly where it is being turned
     off. Measured before this: the middle four screens of the page, from the
     third act to the limits, showed 0.0-1.1% vivid pixels while the hero showed
     25% and the close showed 37% — the light was behind the content, and the
     gutters, where it would have been seen, were empty.
     So below the hero the two pools slide toward the flanks. At 1440 that puts
     their centres near x 135 and x 1417, which is the margin either side of the
     1,180px column. Same lights, moved to where there is nothing in front of
     them. */
  float spread = 1.0 + open * 0.58;
  float d1 = length(p - vec2((-0.42 + 0.12 * sin(t * 0.09)) * spread, 0.30 - drift * 0.55));
  float d2 = length(p - vec2(( 0.50 + 0.10 * cos(t * 0.07)) * spread, -0.34 + drift * 0.35));
  float p1 = smoothstep(1.05, 0.02, d1);
  float p2 = smoothstep(0.95, 0.05, d2) * 0.72;
  float pool = p1 + p2;

  /* The pointer is a third pool rather than a separate layer, so it obeys the
     same lighting and cannot look pasted on. */
  float dp = length((frag - uPtr) / min(uRes.x, uRes.y));
  pool += uPtrOn * smoothstep(0.55, 0.0, dp) * 0.55;

  /* A SMOOTHSTEP, NOT A CLAMP, and the difference is visible.
     This was clamp(h * 1.35 - 0.32, 0.0, 1.0), which is flat at zero below the
     threshold and rises at the noise's own gradient the instant it crosses —
     a shoreline. Where flow peaks, in the middle of the page, that gradient is
     steepest, and check:field measured a 6/255 step between adjacent pixels
     at exactly the two samples where flow is highest while the rest of the page
     sat at 3 and 4. Raising the render resolution changed the number by nothing,
     which is what proved it was in the field rather than in the sampling.
     A smoothstep has zero derivative at both ends, so the surface arrives out
     of the ground instead of beginning at it. */
  /* THE POOLS SET THE LEVEL, THE NOISE SHAPES IT. This was a full product —
     smoothstep(h) * pool — which means a patch where the noise happens to sit
     low is a patch with no surface in it at all. That is not a theoretical
     worry: measured, four consecutive screens in the middle of the page had a
     brightest channel span of 69 against 120 in the hero, and 70 is the
     threshold this page's own vividness test uses. The page was not dimmer
     there by design, it was sitting in a trough of the noise for 3,600px.
     A floor of 0.42 makes the composition the thing that decides how lit a
     screen is, and the noise the thing that decides its shape. The ridges and
     hollows are just as visible: what is gone is the possibility of a whole
     screen falling into a hollow. */
  float body = clamp(pool, 0.0, 1.6) * (0.42 + 0.58 * smoothstep(0.18, 0.80, h));

  body *= channel;

  /* Weighted toward BRAND rather than BRIGHT, and that is the whole trick of
     this palette: #0066ff is a fully saturated hue at a LOW luminance, so it
     buys colour without buying light. #4d94ff costs three times as much
     luminance for less chroma. The bright step is kept for the lit face only,
     where the diffuse term already says the surface is turning toward the
     light. */
  vec3 col = GROUND;
  col = mix(col, DEEP,   clamp(body * 1.00, 0.0, 1.0));
  col = mix(col, BRIGHT, clamp(body * diff * 0.34, 0.0, 1.0));
  /* TWO LIGHTS, NOT ONE MUDDY ONE. The ember used to be mixed into every pixel
     the blue had already coloured, weighted by scroll — and orange into blue is
     grey. Measured on the page's own vividness test, that is exactly what it
     produced: the five screens where the ember term sits at 1.0 had a brightest
     channel span of 69-75 against 122 above and 126 below them, and the middle
     of the page read as 0.0% vivid while the ends read 25-37%. The hue was
     there; the CHROMA had been cancelled.
     So the ember belongs to the second pool rather than to the frame. Where
     pool 2 dominates, the light is warm; where pool 1 does, it stays blue; in
     between there is a boundary rather than an average. A room with a warm lamp
     and a cool one, which is what the product's own palette is — Topics blue,
     Claude's #d97757 — instead of the colour halfway between them. */
  float warm = ember * p2 / max(pool, 0.0001);
  col = mix(col, EMBER,  clamp(body * warm * 0.62, 0.0, 1.0));
  col += BRIGHT * spec * (0.30 + 0.30 * calm) * clamp(pool, 0.0, 1.0);
  col += DEEP   * rim  * 0.12 * clamp(pool, 0.0, 1.0) * channel;

  /* Vignette toward the ground at the corners, so the surface has an edge to
     end on rather than being cropped by the window. */
  float vig = smoothstep(1.32, 0.30, length((uv - 0.5) * vec2(1.35, 1.0)));
  col = mix(GROUND, col, 0.30 + 0.70 * vig);

  /* ── THE CEILING ────────────────────────────────────────────────────────
     A hard cap on relative luminance, and it is derived rather than tuned.

     The palest reading ink on this page is --ink-faint #a3abbb, L 0.405. WCAG
     asks 4.5:1, so the brightest pixel that may sit behind a glyph is
     (0.405 + 0.05) / 4.5 − 0.05 = L 0.051.

     The cap is set at 0.027, not 0.051, because the canvas is not the last
     thing painted. The dot weave sits on top of it in CSS and adds roughly
     0.011 of luminance to the brightest pixel — at its original strength it
     added 0.021, which is a third of the whole budget spent on a texture. Both
     numbers come from screenshotting the layers separately; neither is
     visible in the shader, which is exactly why the cap has to leave room for
     something it cannot see. 0.027 plus the weave measures 0.038, and
     --ink-faint over that is 5.2:1.

     Two corrections are in the maths, and both were found by screenshotting the
     layers separately rather than by reasoning about them.

     The transfer: the first version used pow(c, 2.2), which is the gamma people
     quote rather than the curve sRGB has, and it under-read true luminance by
     22% — the cap said 0.043 and the pixels measured 0.0527.

     The scaling: the second version scaled the sRGB triple toward the ground
     colour by pow(ceil/L, 1/2.4), on the assumption that scaling a colour by k
     scales its luminance by k^2.4. That law holds for a pure power curve and
     NOT for sRGB, whose affine (c+0.055)/1.055 term breaks it — a cap of 0.030
     produced pixels at 0.043, and the error grows as the pullback gets
     stronger. The clamp is applied in LINEAR space, where luminance is linear
     by definition and the scale is exact, and converted back afterwards.

     It is a cap on LIGHT, not on colour, and the difference is the whole
     reason the page can still look like something. A saturated blue at low
     luminance — rgb(0 60 190) — is both legal here and VIVID by the channel-
     span measure that this page's blandness was diagnosed with; a pale blue at
     the same chroma is neither. So the terms above lean on the brand's own
     #0066ff and this clamps whatever they add up to.

     Doing it here rather than by tuning six coefficients is deliberate: a cap
     on the composite cannot be defeated by a later change to any one term, and
     the next person to make the ember stronger does not have to re-derive the
     contrast budget to do it. */
  vec3 c0 = clamp(col, 0.0, 1.0);
  vec3 lin = mix(c0 / 12.92, pow((c0 + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c0));
  float lumY = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  float ceilY = 0.027;
  lin *= min(1.0, ceilY / max(lumY, 0.00001));
  col = mix(lin * 12.92, 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
            step(vec3(0.0031308), lin));

  /* Dither. Eight-bit blue on near-black bands badly, and a banded gradient is
     the single most reliable way to make a shader look cheap. */
  float dith = (hash(frag + fract(t)) - 0.5) / 255.0;

  gl_FragColor = vec4(GROUND + (col - GROUND) * uGain + dith, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[field]', gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

function start(cv: HTMLCanvasElement) {
  const gl = (cv.getContext('webgl', { antialias: false, depth: false, alpha: false, powerPreference: 'low-power' }) ||
    cv.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return false;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[field]', gl.getProgramInfoLog(prog));
    return false;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const u = {
    res: gl.getUniformLocation(prog, 'uRes'),
    time: gl.getUniformLocation(prog, 'uTime'),
    scroll: gl.getUniformLocation(prog, 'uScroll'),
    ptr: gl.getUniformLocation(prog, 'uPtr'),
    ptrOn: gl.getUniformLocation(prog, 'uPtrOn'),
    gain: gl.getUniformLocation(prog, 'uGain'),
  };

  /* 0.55 of CSS pixels, DPR capped at 1.5. See the cost note at the top. */
  const SCALE = 0.55;
  let w = 0, h = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const nw = Math.max(2, Math.round(innerWidth * dpr * SCALE));
    const nh = Math.max(2, Math.round(innerHeight * dpr * SCALE));
    if (nw === w && nh === h) return;
    w = cv.width = nw;
    h = cv.height = nh;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(u.res, w, h);
  };
  resize();
  addEventListener('resize', resize, { passive: true });

  /* Scroll and pointer are read here rather than pushed from v3.ts: this is the
     only consumer, and a uniform write is cheaper than a custom event. Both are
     smoothed, because a uniform that jumps makes a fluid look like a slideshow. */
  let scroll = 0, scrollTo = 0;
  let px = -9999, py = -9999, ptrOn = 0, ptrTo = 0;
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    scrollTo = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  };
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });

  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    addEventListener('pointermove', (e) => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5) * SCALE;
      px = e.clientX * dpr;
      py = (innerHeight - e.clientY) * dpr;   // GL's origin is bottom-left
      ptrTo = 1;
    }, { passive: true });
    addEventListener('pointerleave', () => { ptrTo = 0; }, { passive: true });
    document.addEventListener('mouseleave', () => { ptrTo = 0; }, { passive: true });
  }

  /* The fade-in exists so the first frame is not a hard cut from flat ink: the
     surface arrives, it does not appear. */
  const t0 = performance.now();
  let raf = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = (now - t0) / 1000;
    scroll += (scrollTo - scroll) * 0.085;
    ptrOn += (ptrTo - ptrOn) * 0.06;
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.scroll, scroll);
    gl.uniform2f(u.ptr, px, py);
    gl.uniform1f(u.ptrOn, ptrOn);
    gl.uniform1f(u.gain, Math.min(1, t / 1.1));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  /* ── ONE FRAME, ON DEMAND ─────────────────────────────────────────────────
     Two callers, and the second one is the reason this is a public handle.

     Reduced motion draws once and then once more per scroll: the surface is
     still there and still answers the page, it simply does not move.

     `check:painted` is the other. It reads the pixels actually painted behind
     every text run and fails the build when the background spends contrast —
     and a background on a rAF loop is a different background in every run, so
     the gate would be sampling a random frame and reporting a number that does
     not reproduce. With this it pins time and page position and grades the
     surface at chosen moments, including the ones it is brightest at. A gate
     that cannot reproduce its own finding is a coin toss with a log file. */
  const drawOnce = (t: number, at: number, pointerAt?: [number, number]) => {
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.scroll, at);
    gl.uniform2f(u.ptr, pointerAt ? pointerAt[0] : -9999, pointerAt ? pointerAt[1] : -9999);
    gl.uniform1f(u.ptrOn, pointerAt ? 1 : 0);
    gl.uniform1f(u.gain, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  (window as unknown as { __field?: unknown }).__field = {
    freeze(t: number, at: number, pointer?: [number, number]) {
      cancelAnimationFrame(raf);
      raf = 0;
      const dpr = Math.min(devicePixelRatio || 1, 1.5) * SCALE;
      drawOnce(t, at, pointer ? [pointer[0] * dpr, (innerHeight - pointer[1]) * dpr] : undefined);
    },
  };

  if (reduce) {
    drawOnce(6, scrollTo);
    addEventListener('scroll', () => drawOnce(6, scrollTo), { passive: true });
  } else {
    raf = requestAnimationFrame(frame);
    addEventListener('pagehide', () => cancelAnimationFrame(raf));
  }

  document.body.classList.add('has-field');
  return true;
}

if (fieldCanvas) {
  try {
    if (!start(fieldCanvas)) fieldCanvas.remove();
  } catch {
    fieldCanvas.remove();   // the CSS field underneath is a complete picture
  }
}
