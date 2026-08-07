/* ═══════════════════════════════════════════════════════════════════════════
   THE FIELD — the arch of light from the reference's intro, measured off the
   reference and rebuilt as a shader.

   ── WHAT THE REFERENCE ACTUALLY IS ─────────────────────────────────────────
   The "shader" in the hero of nextsaas ai-solutions is a VIDEO. It was checked
   rather than assumed, because the whole point of this round was to stop
   inventing: the page has 0 canvas elements and 1 video, and no three / gl /
   pixi script anywhere; paused at currentTime = 2.0 the best-matching frame of
   all 210 is frame 061, which is 2.0s x 30fps; and where nothing is painted
   over it, the browser's pixels equal the file's to 1/255.
   colorflow-animation.mp4, 1920x1440, 30fps, 7.00s, 210 frames, served by
   Elementor and drawn with object-fit: cover into a 1440x1136 section.

   So there was no shader to copy. There was a picture to measure.

   ── WHAT WAS MEASURED ──────────────────────────────────────────────────────
   Every number below is in the coordinates a visitor SEES at 1440x900 — the
   file's own frame put through that cover crop (x inset 2.48% then scaled by
   0.9505, y scaled by 1136/900) — because what is being copied is what is on
   screen, not what is in the file. The first pass of this work quoted the curve
   in the video's own coordinates and had the apex at 40% instead of 54%.

   The composition is an ARCH. Light fills the bottom of the frame and its edge
   rises to a peak, off centre to the right:

       x     0     9    18    27    36    45    55    64    73    82    91   100  %
       y  81.5  75.8  66.6  64.8  61.9  59.0  56.0  54.0  57.9  63.5  70.3  74.6  %

   apex at x 64%, y 54%; 24 points of arch between the corners and the peak; a
   near-white core (253,253,255) at (69%, 81%); mean luminance 104/255, constant
   to +/-2 across the whole loop.

   AND IT IS ALMOST STILL. The crest breathes at most 10.6 points over the 7s
   loop, and at the two edges it does not move at all (0.3 points). Everything
   built here before moved far more than that, which is most of why none of it
   read as this. The quality is in the composition and in the stillness.

   ── WHAT IT REPLACES ───────────────────────────────────────────────────────
   Three attempts, all deleted, all invented rather than measured: a domain-
   warped height field, a swarm of 24,000 points morphing through seven shapes,
   and a lit body throwing a halo. The verdict each time was some form of
   "figo, però non ci siamo", and each time it was right.

   ── HOW THE ARCH IS DRAWN ──────────────────────────────────────────────────
   The twelve measured points are carried by a quintic least-squared onto them,
   whose largest error is 2.2 points — SMALLER THAN THE CURVE'S OWN BREATHING,
   so the fit sits inside the measurement rather than beside it. Below that line
   the light rises with the profile the reference has (13% of full at the crest,
   66% a tenth of a frame under it, plateau by a fifth), brighter toward the
   flank the core is on, exactly as measured along the bottom row.

   ── WHERE THE CORE GOES, AND WHY IT IS AFFORDABLE ──────────────────────────
   The reference's core is never actually seen: a 1290x605 photograph starts at
   y531 and the core at y716 sits 185px inside it. That is what lets a near-
   white survive in a picture — it is behind the subject, and what reaches the
   eye is the bloom around it.

   This page has the same subject in the same place. The app frame runs
   y626-1304 across x178-1262, and the measured core at (69%, 81%) is x994,
   y731 — inside it. So the core is kept where the reference put it and the page
   covers it, which is the only reason a page whose luminance ceiling is L 0.036
   can have a hot centre at all.

   ── THE SCROLL ─────────────────────────────────────────────────────────────
   The reference has none: its video lives in the hero and the page moves on.
   This field is fixed to the window for 14,081px, so below the hero the apex
   walks across the frame and the whole arch lifts — continuously, never staged,
   and never back to a picture already shown. It also has to step out of the
   reading column, which is the one thing the reference never had to do.

   ── THE BUDGET ─────────────────────────────────────────────────────────────
   The field renders into a framebuffer and a composite pass rolls its luminance
   off against a ceiling derived from the palest reading ink on the page. Both
   are documented where they are applied.
   ═════════════════════════════════════════════════════════════════════════ */

export {};

const fieldCanvas = document.querySelector<HTMLCanvasElement>('#field');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

/* NOTE — every shader here is a template literal. A backtick anywhere inside
   one, INCLUDING inside a comment, ends the string and breaks the build. It has
   cost five builds; that is why it is written down. */
const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform float uScroll;
uniform vec2  uPtr;
uniform float uPtrOn;
uniform float uGain;

/* WHITE AND TOPICS BLUE, which is what was asked for. GROUND is the page's own
   #0a0d14 and it happens to be the reference's own top-of-frame to within three
   values (11,17,22). BLUE is the brand at full chroma and low light —
   saturation is free on a near-black ground and luminance is not, and the
   composite caps the second one. PALE is the heart: the reference's is
   253,253,255, ours is biased blue so that what survives the cap is a colour
   rather than a grey. */
const vec3 GROUND = vec3(0.039, 0.051, 0.078);
const vec3 BLUE   = vec3(0.000, 0.290, 1.000);
const vec3 PALE   = vec3(0.680, 0.820, 1.000);

const float PI = 3.14159265;

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

/* ── THE ARCH ──────────────────────────────────────────────────────────────
   The reference's crest, as a quintic least-squared onto the twelve measured
   points. It returns the height of the edge of the light, as a fraction of the
   window, measured DOWN FROM THE TOP:

     x  0     9    18    27    36    45    55    64    73    82    91   100  %
     y 81.5  75.8  66.6  64.8  61.9  59.0  56.0  54.0  57.9  63.5  70.3  74.6 %

   The fit's largest error is 2.2 points, against a curve that breathes by up to
   10.6 — so this is inside the measurement, not an approximation of it. The
   coefficients are not adjustable by taste: change them and check:field says
   the arch has left the reference. */
float archAt(float x){
  float c = clamp(x, 0.0, 1.0);
  float y = 0.82147 + c * (-1.32360 + c * (5.26663 + c * (-14.00114 +
                       c * (16.88941 + c * (-6.90486)))));
  /* AND THEN IT IS DEEPENED BY A FIFTH, because the curve that is DRAWN is not
     the curve that is SEEN. The composite rolls luminance off against a ceiling,
     so equal steps of light are not equal steps on screen, and the contour the
     eye reads as the edge of the light lands flatter than the arch that
     generated it. Measured on the rendered page, the drawn 24.1-point arch came
     back as 18.9. The gain is around the curve's own mean (0.6549), so it
     deepens the arch without moving the picture up or down, and the number is
     the one that made the RENDERING match — 1.20 puts the peak within 1.8 points
     and both corners within 1.5. Check it with check:field, never by eye. */
  return 0.6549 + (y - 0.6549) * 1.20;
}

void main(){
  vec2  frag = gl_FragCoord.xy;
  vec2  uv   = frag / uRes;
  float sx   = uv.x;
  float sy   = 1.0 - uv.y;              /* 0 at the TOP, like the measurements */
  float s    = clamp(uScroll, 0.0, 1.0);
  float t    = uTime;
  float wide = (uRes.x / uRes.y) / 1.6; /* the curve was measured at 1440x900 */

  /* ── THE SCROLL ───────────────────────────────────────────────────────────
     The reference has no scroll behaviour: its video lives in its hero and the
     page moves on to a white section. This canvas is fixed to the window for
     14,081px, so it has to keep being a picture the whole way down without ever
     being the same picture twice.
     Two continuous terms only. The apex WALKS across the frame — which is also
     what hands the reading column back, since the brightest flank is wherever
     the apex is — and the whole arch LIFTS, so the light claims more of the
     frame the further down you are. Both are zero in the hero, where the
     composition is the reference's exactly. */
  float drift = smoothstep(0.03, 0.14, s) * 0.42 * sin(s * 2.6);
  float lift  = s * 0.12;
  float ax    = sx + drift;

  /* ── THE BREATH ───────────────────────────────────────────────────────────
     Nailed to the reference's own loop: 7.00s, so 2*PI/7 = 0.8976 rad/s. The
     amplitude goes to nothing at both edges because theirs does — measured, the
     crest at x=0 and x=100% moves 0.3 points across the entire loop while the
     middle moves 10.6. That stillness is the single property every earlier
     version of this background got wrong. */
  float env    = pow(max(sin(PI * clamp(sx, 0.0, 1.0)), 0.0001), 0.9);
  float breath = 0.046 * env * sin(t * 0.8976 + sx * 2.4);

  float crest = archAt(ax) - lift + breath;

  /* The pointer LIFTS THE CREST toward the cursor rather than adding a lamp on
     top of the picture. A separate light can look pasted on; a light that is
     the same light, reaching, cannot. */
  vec2  pt   = uPtr / uRes;
  vec2  pd   = vec2((sx - pt.x) * wide, sy - (1.0 - pt.y));
  float lamp = uPtrOn * exp(-dot(pd, pd) * 26.0);
  /* Half of what it was. At 0.055 the cursor lifted the crest far enough that a
     narrow window with a fine pointer put body copy over the bright side of the
     arch — the only four contrast failures left were all of them, and all of
     them under the cursor. A pointer that changes the picture that much is not
     an affordance, it is a second light. */
  crest -= lamp * 0.026;

  /* ── THE RISE ─────────────────────────────────────────────────────────────
     Measured off the file as a fraction of each column's own maximum: 0.13 at
     the crest, 0.33 three points under it, 0.46 at six, 0.66 at ten, 0.85 at
     fifteen, plateau by twenty. One smoothstep over 0.33 of the frame lands
     within a few points of that the whole way down. */
  float lit = smoothstep(-0.085, 0.245, sy - crest);

  /* ── AND IT LEANS ─────────────────────────────────────────────────────────
     The reference is not an even wash under its arch. Along its bottom row,
     left to right: 0.58 0.61 0.63 0.66 0.86 0.93 0.96 0.97 0.98 0.99 1.00 — the
     mass is half again as bright on the flank the core is on. That asymmetry is
     most of why the picture reads as a light source and not as a gradient, and
     it is also why there is no symmetric vignette here: one would fight the
     brightest corner the reference has. */
  float hg = 0.58 + 0.42 * smoothstep(0.28, 0.55, ax);

  /* ── THE CHANNEL ──────────────────────────────────────────────────────────
     The reading column runs down the middle of this page, so a light brightest
     in the middle spends its contrast budget on exactly the pixels that cannot
     afford it. It steps aside below the hero only: over the first screen the
     things above it are 66px display type and the opaque frame of the app.
     Both terms open by s = 0.105, which is where the hero ends — 1,437px of a
     14,081px page. A slower ramp left the light still near the middle over the
     first section below the fold, and the gate measured 1.37x there.
     It multiplies a whole COLUMN evenly, so it cannot move the crest: the shape
     gate and this term are independent by construction. */
  float column  = smoothstep(0.40, 0.07, abs(sx - 0.5));
  float opened  = smoothstep(0.035, 0.105, s);
  float channel = 1.0 - column * opened * 0.80;

  float mass = lit * hg * channel;

  /* ── COMPOSITE ────────────────────────────────────────────────────────────
     THE VALUES ARE KEPT UNDER 1.0 ON PURPOSE, and this is the trap the whole
     composite architecture nearly fell into once already. The framebuffer is
     RGBA8: anything above 1.0 is CLIPPED THERE, before the tone-map ever sees
     it. A mass composed above 1.0 does not roll off gracefully — it saturates
     the blue channel in the buffer, arrives at the composite flat, and gets
     scaled down to a desaturated grey. Measured, on the version that made that
     mistake, the supposedly brightest part of the picture read rgb(30 58 58)
     while the glow an inch outside it read rgb(4 40 133).
     At 0.70 the brightest pixel lands at L 0.080, about 2.2x the composite's
     ceiling: far enough in to use the roll-off, near enough out that the
     gradient underneath it survives. */
  vec3 col = GROUND + BLUE * mass * 0.70;

  /* ── THE CORE ─────────────────────────────────────────────────────────────
     The reference's is near-white (253,253,255) and it is NEVER SEEN: a
     1290x605 photograph starts at y531 and the core at y716 sits 185px inside
     it. That is the whole trick — a page can afford a white heart if its
     subject stands in front of it, because what reaches the eye is the bloom.
     This page has its subject in the same place. The app frame runs y626-1304
     across x178-1262 and the core at (69%, 81%) is x994, y731: inside it.
     It is a MIX toward pale, not an addition of white. A white clamped to the
     reading ceiling is a grey; what survives a luminance cap is hue and
     saturation, so below the hero the core is the palest thing here rather than
     the brightest, and it stays a colour.

     AND IT IS WHAT MAKES THE PICTURE BRIGHT, which is not a preference either.
     Raising the ceiling stopped paying long before the glow read like the
     reference: from 0.090 to 0.170 the peak moved 75 to 88 out of 255, because
     the limit had stopped being the cap and become the COLOUR. Topics blue is
     (0, 0.29, 1.0) and its relative luminance is 0.121 — the blue channel is
     worth 0.0722 of it. A saturated blue cannot be bright; that is arithmetic.
     The reference's own core is 253,253,255. So the light in this picture comes
     from the same place theirs does — the heart going pale — and everything
     around it stays the brand's blue. White and Topics blue, which is the brief. */
  vec2  cp   = vec2(0.692 - drift, 0.812);
  float cd   = length(vec2((sx - cp.x) * wide, sy - cp.y));
  float core = exp(-cd * 3.9) * lit * channel;
  col = mix(col, PALE, core * 0.62);

  col += BLUE * lamp * 0.05 * channel;

  /* A grain of light, so the falloff is a material and not a ramp. Eight-bit
     blue on near-black bands, and a banded gradient is the most reliable way to
     make a shader look cheap. */
  col += BLUE * (noise(frag * 0.9 + t * 3.0) - 0.5) * 0.012 * mass;

  gl_FragColor = vec4(GROUND + (col - GROUND) * uGain, 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE COMPOSITE — where the contrast budget is enforced.

   The body renders into a framebuffer; this pass reads it back, rolls its
   luminance off against a ceiling, dithers, and writes to the screen.

   THE NUMBER IS DERIVED, NOT TUNED. The palest reading ink on this page is
   --ink-faint #a3abbb, L 0.405. WCAG asks 4.5:1, so the brightest pixel that
   may sit behind a glyph is (0.405 + 0.05) / 4.5 - 0.05 = L 0.051. The ceiling
   sits below that because one layer is still painted after this one — the CSS
   dot weave, measured at +0.011 on the brightest pixel — and a ceiling has to
   leave room for what it cannot see.

   A ROLL-OFF, NOT A CLIFF. ceil * (1 - e^(-L/ceil)) is linear where there is
   room and asymptotic where there is not, so nothing reaches the ceiling and
   nothing is clipped. A hard clamp flattens: every bright region lands on the
   same value and the modelling inside it disappears, which on a lit body means
   losing the terminator — the one cue that makes it look round.

   TWO CORRECTIONS ARE IN THE MATHS, both found by screenshotting rather than by
   reasoning. pow(c, 2.2) is the gamma people quote and not the curve sRGB has;
   it under-read true luminance by 22%. And scaling an sRGB triple by k does NOT
   scale its luminance by k^2.4 — the affine (c+0.055)/1.055 term breaks that
   law, so a cap of 0.030 produced pixels at 0.043. The clamp is applied in
   LINEAR space, where luminance is linear by definition.

   It is a cap on LIGHT, not on colour, and that is what lets the page still
   look like something: a saturated blue at low luminance is both legal here and
   VIVID by the channel-span measure this page's blandness was diagnosed with.
   ═════════════════════════════════════════════════════════════════════════ */
const C_VERT = `
attribute vec2 p;
varying vec2 vUv;
void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }
`;

const C_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform float uTime;
uniform float uHero;
varying vec2 vUv;

float h1(vec2 p){
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

void main(){
  vec3 c0 = clamp(texture2D(uTex, vUv).rgb, 0.0, 1.0);
  vec3 lin = mix(c0 / 12.92, pow((c0 + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c0));
  float lumY = dot(lin, vec3(0.2126, 0.7152, 0.0722));

  /* ── TWO CEILINGS, AND THE SCROLL IS WHAT CHOOSES ───────────────────────
     One number could not do this job, and the measurement is what proved it.
     With a single ceiling high enough for the glow to read like the reference,
     check:painted failed in forty places — every one of them BELOW the hero,
     16px body copy in --ink-mute over the lit half of the frame. With a ceiling
     low enough for that copy, the field peaks at 54/255 against the reference's
     253 and the whole picture is a dark blue wash: the composition was right and
     the LIGHT was not there, which is exactly the verdict it got.

     So the light goes where the reference puts it. Its glow is a HERO element —
     a video in the first screen, and then a white page. Ours is one fixed canvas
     behind 14,081px of prose, and asking it to be a hero and a backdrop at once
     is what kept it dim. Bright over the first screen, down to the reading
     ceiling by the time the hero ends, continuously.

     The reading ceiling is DERIVED, not chosen: --ink-faint is #a3abbb, L 0.405,
     and WCAG asks 4.5:1, so the brightest pixel allowed behind a glyph is
     L 0.051 — less the CSS dot weave painted after this pass, measured at +0.011
     on the brightest pixel. The hero ceiling is what the hero can afford, and
     what it can afford is set by one row: nothing else up there is small and
     pale, and the app frame is opaque over the brightest part.

     THE FADE IS MEASURED IN SCREENS, NOT IN PAGE FRACTIONS, and that is a bug
     already paid for. At 1440 the hero is 1,495px of a 14,081px page — 10.6% —
     and at 390 the same hero is a much larger share of a much longer page, so a
     single fraction that ended at the hero on a desktop was still two thirds
     open a screen further down on a phone. check:painted found it there and
     nowhere else. uHero counts viewport heights. */
  float ceilY = mix(0.170, 0.036, clamp(uHero, 0.0, 1.0));
  float mapped = ceilY * (1.0 - exp(-lumY / ceilY));
  lin *= mapped / max(lumY, 0.00001);

  vec3 col = mix(lin * 12.92, 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), lin));

  /* Dither. Eight-bit blue on near-black bands badly, and a banded gradient is
     the single most reliable way to make a shader look cheap. */
  float d = (h1(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col + d, 1.0);
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

function link(gl: WebGLRenderingContext, vsrc: string, fsrc: string) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[field]', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function start(cv: HTMLCanvasElement) {
  const gl = (cv.getContext('webgl', { antialias: false, depth: false, alpha: false, powerPreference: 'low-power' }) ||
    cv.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return false;

  const prog = link(gl, VERT, FRAG);
  const cProg = link(gl, C_VERT, C_FRAG);
  if (!prog || !cProg) return false;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  gl.useProgram(prog);
  const loc = gl.getAttribLocation(prog, 'p');
  const u = {
    res: gl.getUniformLocation(prog, 'uRes'),
    time: gl.getUniformLocation(prog, 'uTime'),
    scroll: gl.getUniformLocation(prog, 'uScroll'),
    ptr: gl.getUniformLocation(prog, 'uPtr'),
    ptrOn: gl.getUniformLocation(prog, 'uPtrOn'),
    gain: gl.getUniformLocation(prog, 'uGain'),
  };

  gl.useProgram(cProg);
  const cLoc = gl.getAttribLocation(cProg, 'p');
  const cu = {
    tex: gl.getUniformLocation(cProg, 'uTex'),
    time: gl.getUniformLocation(cProg, 'uTime'),
    hero: gl.getUniformLocation(cProg, 'uHero'),
  };
  gl.uniform1i(cu.tex, 0);

  /* The offscreen target. LINEAR filtering, because it is rendered at 55% of
     CSS pixels and stretched: NEAREST shows the body's edge as steps. */
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  /* 0.55 of CSS pixels, DPR capped at 1.5. The body has one soft edge and no
     detail finer than the falloff around it, so full resolution buys heat. */
  const SCALE = 0.55;
  let w = 0, h = 0;
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const nw = Math.max(2, Math.round(innerWidth * dpr * SCALE));
    const nh = Math.max(2, Math.round(innerHeight * dpr * SCALE));
    if (nw === w && nh === h) return;
    w = cv.width = nw;
    h = cv.height = nh;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.useProgram(prog);
    gl.uniform2f(u.res, w, h);
  };
  resize();
  addEventListener('resize', resize, { passive: true });

  const fullscreen = (program: WebGLProgram, attr: number) => {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const paint = (t: number, at: number, ptX: number, ptY: number, on: number, gain: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog);
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.scroll, at);
    gl.uniform2f(u.ptr, ptX, ptY);
    gl.uniform1f(u.ptrOn, on);
    gl.uniform1f(u.gain, gain);
    fullscreen(prog, loc);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.useProgram(cProg);
    gl.uniform1f(cu.time, t);
    /* How far past the first screen we are, in viewport heights, from the same
       page position the body was drawn at. Derived here rather than passed in so
       that freeze(t, at) still fully determines the frame — the gates depend on
       that — while the fade stays measured in screens rather than in a fraction
       of a page whose length depends on the width. */
    const span = document.documentElement.scrollHeight - innerHeight;
    gl.uniform1f(cu.hero, Math.min(1, (at * Math.max(0, span)) / (innerHeight * 1.1)));
    fullscreen(cProg, cLoc);
  };

  /* Scroll and pointer are read here rather than pushed from v3.ts: this is the
     only consumer, and a uniform write is cheaper than a custom event. Both are
     smoothed, because a uniform that jumps makes a body look like a slideshow. */
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
     body arrives, it does not appear. */
  const t0 = performance.now();
  let raf = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const t = (now - t0) / 1000;
    scroll += (scrollTo - scroll) * 0.085;
    ptrOn += (ptrTo - ptrOn) * 0.06;
    paint(t, scroll, px, py, ptrOn, Math.min(1, t / 1.2));
  };

  /* ── ONE FRAME, ON DEMAND ─────────────────────────────────────────────────
     Two callers, and the second is why this is a public handle.

     Reduced motion draws once, and again on each scroll: the body is still
     there and still answers the page, it simply does not move.

     The gates are the other. `check:painted` reads the pixels actually painted
     behind every text run and `check:field` diffs the layer against a page
     without it — both meaningless against a rAF loop, because two screenshots a
     frame apart are of two different backgrounds. With this they pin time and
     page position and measure something that reproduces. */
  (window as unknown as { __field?: unknown }).__field = {
    freeze(t: number, at: number, pointer?: [number, number]) {
      cancelAnimationFrame(raf);
      raf = 0;
      const dpr = Math.min(devicePixelRatio || 1, 1.5) * SCALE;
      paint(t, at,
            pointer ? pointer[0] * dpr : -9999,
            pointer ? (innerHeight - pointer[1]) * dpr : -9999,
            pointer ? 1 : 0, 1);
    },
  };

  if (reduce) {
    paint(6, scrollTo, -9999, -9999, 0, 1);
    addEventListener('scroll', () => paint(6, scrollTo, -9999, -9999, 0, 1), { passive: true });
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
