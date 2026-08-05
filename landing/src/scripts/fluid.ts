/* ═══════════════════════════════════════════════════════════════════════════
   THE FIELD — one lit body, low in the frame, and the halo it throws.

   ── WHAT THE REFERENCES ACTUALLY DO ────────────────────────────────────────
   Both were opened, rendered and measured rather than remembered, and neither
   is what it looks like:

     ai-solutions   the "shader" in its hero is a VIDEO: colorflow-animation.mp4,
                    1920x1440, a 7s loop. Sampled, it is 40% pure black and 22%
                    near-white with violet flanks (192,192,224 · 160,160,224 ·
                    224,192,224), and its bright centroid sits at 53%, 77% —
                    low centre. Rendered as a density map it is a luminous DOME
                    rising off the bottom edge, black above, with a soft arched
                    crest that undulates across the loop.

     tranquil       a WebGL2 canvas plus draco_wasm_wrapper.js — a Draco-
                    compressed 3D mesh, not a particle system. What it draws is
                    a globe-like body with a glowing pattern on it, and it moves
                    continuously: 78.5% of pixels change in 1.2s, 93.8% in 2.4s.

   ── WHAT THIS IS ───────────────────────────────────────────────────────────
   The two joined, which is what was asked for: ai-solutions' halo, moving the
   way tranquil's body moves. One object. A closed body sitting low in the
   frame, lit by a moving key, whose silhouette is a sum of harmonics that turn
   and open — so it is never the same shape twice and never jumps — and whose
   light spills upward into black as the dome.

   ── WHAT IT REPLACES ───────────────────────────────────────────────────────
   Two layers, both deleted: a domain-warped height field, and a swarm of
   24,000 points that morphed through seven shapes. The verdict on them was
   "figo, però non ben definito", and it was right about both. A warped surface
   has mood and no subject. The swarm had subjects — seven of them — but a
   background that becomes seven things is a background you cannot name, and
   under this page's contrast budget it never got to be more than a texture:
   measured, it changed 2% of the visible pixels.

   One body you can point at beats seven you cannot see.

   ── WHY IT IS NOT RAYMARCHED ───────────────────────────────────────────────
   It reads as three-dimensional and it is drawn in two. The silhouette is an
   implicit curve; the normal is taken from it the way a sphere's is
   (z = sqrt(1 - x^2 - y^2)), so the body gets a real key light, a real
   terminator and a real fresnel rim, which is the whole of what the eye uses to
   call something round. A sphere-traced SDF would spend forty evaluations per
   pixel arriving at the same three cues.

   ── THE SCROLL ─────────────────────────────────────────────────────────────
   Continuous, never staged. Page progress lifts the body through the frame,
   opens and closes its harmonics, turns the key light through 200 degrees, and
   moves the hue from the brand's blue toward the agent ember and back. Nothing
   snaps, because there is nothing to snap between.

   ── THE BUDGET ─────────────────────────────────────────────────────────────
   The body renders into a framebuffer and a composite pass rolls its luminance
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

/* The palette is the product's. GROUND is the page's own #0a0d14. CORE is the
   brand at full chroma and low light — saturation is free on a near-black
   ground and luminance is not, and the composite caps the second one. EMBER is
   #d97757, the colour the app's tab bar paints a Claude session with. */
const vec3 GROUND = vec3(0.039, 0.051, 0.078);
const vec3 CORE   = vec3(0.000, 0.290, 1.000);
const vec3 RIMCOL = vec3(0.360, 0.660, 1.000);
const vec3 EMBER  = vec3(1.000, 0.360, 0.140);

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

float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++){
    v += a * noise(p);
    p = p * 2.03 + vec2(8.3, 2.8);
    a *= 0.5;
  }
  return v;
}

/* THE SILHOUETTE. Four harmonics on the radius, each turning at its own rate.
   Four is where the outline stops reading as an ellipse and starts reading as a
   body, and it is below where it starts reading as a splat. The amplitudes open
   with the scroll, so the body is nearly round at the top of the page and most
   itself in the middle of it. */
float radiusAt(float ang, float t, float open) {
  float r = 1.0;
  r += 0.115 * open * sin(ang * 2.0 + t * 0.23);
  r += 0.075 * open * sin(ang * 3.0 - t * 0.31 + 1.7);
  r += 0.045 * open * sin(ang * 5.0 + t * 0.19 + 4.1);
  r += 0.026 * open * sin(ang * 8.0 - t * 0.27 + 2.3);
  return r;
}

void main(){
  vec2 frag = gl_FragCoord.xy;
  vec2 uv   = frag / uRes;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;

  float s = clamp(uScroll, 0.0, 1.0);
  float t = uTime;

  /* ── the scroll terms, all continuous ─────────────────────────────────── */
  float open  = 0.35 + 0.65 * sin(s * 3.14159);        /* how deformed */
  /* The reference's bright centroid is at 77% down the frame, measured off the
     video: visible, not cropped. At -0.80 the body sat at 90% and all that was
     on screen was its halo, which is why the middle of the frame read as darker
     than the flanks — those were not the flanks of the body, they were the
     shoulders of the dome above it. */
  float rise  = -0.56 + s * 0.46;                      /* the body climbs */
  float scale = 0.56 + 0.16 * sin(s * 3.14159 * 0.8);  /* and breathes */
  float key   = 1.05 + s * 3.5;                        /* the light turns */
  float warm  = smoothstep(0.20, 0.44, s) * (1.0 - smoothstep(0.58, 0.84, s));

  /* The body's centre. Low in the frame at the top of the page — exactly where
     the reference's dome sits on the bottom edge — and climbing as you go. */
  /* AND IT MOVES OFF THE COLUMN. Below the hero the body swings between the
     left and right thirds of the frame, and that is a legibility decision
     before it is a compositional one: the reading column runs down the middle,
     so a light centred there is a light aimed at the text. Measured with the
     body centred, the field's mean contribution in the reading column was up to
     2.09x its mean in the gutters — the opposite of what the channel term is
     for. Over the hero it stays central, because what is over it there is 66px
     display type and the opaque frame of the app. */
  float swing = smoothstep(0.035, 0.105, s) * 0.92 * sin(s * 3.6 + 0.5);
  vec2 c = vec2(0.06 * sin(t * 0.07) + swing, rise);
  vec2 q = (p - c) / scale;

  float ang = atan(q.y, q.x);
  float rad = length(q);
  float R   = radiusAt(ang, t, open);
  float d   = rad - R;

  /* ── THE BODY ───────────────────────────────────────────────────────────
     Inside, the surface is a hemisphere over the silhouette: the normal is the
     one a sphere would have, which is all the eye needs to call it round. */
  float inside = smoothstep(0.03, -0.05, d);
  float u2 = clamp(rad / max(R, 0.001), 0.0, 1.0);
  float nz = sqrt(max(0.0, 1.0 - u2 * u2));
  vec3 n = normalize(vec3(q.x / max(R, 0.001), q.y / max(R, 0.001), nz + 0.12));

  vec3 L = normalize(vec3(cos(key), 0.42 + 0.35 * sin(key * 0.6), 0.72));
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 11.0);
  /* Fresnel. The edge of a translucent body is its brightest part, and it is
     what makes the shape read as a volume rather than as a filled outline. */
  float fres = pow(1.0 - clamp(nz, 0.0, 1.0), 2.6);

  /* A slow interior flow, so the body is not a painted ball. Sampled in the
     body's own frame, so it turns with the silhouette. */
  float flow = fbm(q * 2.1 + vec2(t * 0.06, -t * 0.045)) * 0.55 + 0.45;

  /* ── THE HALO ───────────────────────────────────────────────────────────
     The whole point of the reference, and the reason the body sits low: the
     light does not stop at the edge, it spills, and it spills UPWARD more than
     sideways. Two falloffs — a tight one hugging the silhouette and a wide one
     that becomes the dome — plus a vertical stretch, so the glow rises the way
     it does in the reference rather than ringing the shape evenly. */
  /* Built from the CREST rather than from the silhouette, and that is the whole
     difference between a halo and a fog. A radial falloff around the body rings
     it evenly and, stretched enough to rise, fills the frame: measured, the top
     row of the viewport sat at rgb(9 21 53) against a ground of rgb(10 13 20) —
     there was no black left for the light to be light against.
     Two exponentials instead. One upward from the crest, one sideways past a
     half-width that OPENS with height, which is what a glow does. Under the
     crest both are 1, so the bottom of the frame is fully lit the way the
     reference's is, and by a third of the way up there is nothing. */
  float rScale = R * scale;
  float crest = c.y + rScale * 0.90;
  float above = p.y - crest;
  float up    = exp(-max(above, 0.0) * 1.75);
  float halfw = rScale * (1.0 + max(above, 0.0) * 1.25);
  float side  = exp(-max(abs(p.x - c.x) - halfw, 0.0) * 1.05);
  float dome  = up * side;

  /* And a tight one hugging the silhouette, which is the body's own bloom. */
  float near = exp(-max(d, 0.0) * 6.5 / max(scale, 0.001));

  /* The pointer is a third light rather than a separate layer, so it obeys the
     same falloff and cannot look pasted on. */
  vec2 pt = (uPtr / uRes - 0.5) * vec2(aspect, 1.0) * 2.0;
  float lamp = uPtrOn * exp(-length(p - pt) * 2.6) * 0.30;

  /* ── THE CHANNEL ────────────────────────────────────────────────────────
     The reading column runs down the middle of this page, so a light brightest
     in the middle spends its contrast budget on exactly the pixels that cannot
     afford it. It steps aside below the hero only: over the first screen the
     things above it are 66px display type and the opaque frame of the app. */
  float column  = smoothstep(0.40, 0.07, abs(uv.x - 0.5));
  /* Both of these open by s = 0.105, which is where the hero ends: 1,437px of a
     14,081px page. A slower ramp left the body still near the middle over the
     first section below the fold, and the gate measured 1.37x there. */
  float opened  = smoothstep(0.035, 0.105, s);
  float channel = 1.0 - column * opened * 0.80;

  /* ── COMPOSITE ──────────────────────────────────────────────────────────── */
  vec3 col = GROUND;

  /* THE WHOLE COMPOSITION IS SIZED TO THE CEILING, not to taste. A pure blue
     reaches the composite's L 0.036 at roughly B = 0.55, so every value above
     that is in the asymptote of the roll-off and every gradient inside it gets
     squeezed flat. Composed to 0.98 at its brightest, half the body's modelling
     was happening in the part of the curve that cannot represent it: the
     interior measured 130-138 in blue across its entire width, a dome with no
     terminator in it. Summed to about 0.62 the top compresses gently and the
     rest of the range is linear, which is where the shape lives. */
  col += CORE * dome * 0.27 * channel;
  col += CORE * near * 0.08 * channel;
  col += CORE * lamp * 0.6 * channel;

  /* BRIGHTEST AT THE CORE, and that is the reference rather than a preference.
     The first version weighted the fresnel rim at 0.80 and the interior at
     CORE * 0.8 — so the edge was brighter than the middle and the body read as
     a dark shape silhouetted against its own glow. Measured against the video
     frames, ai-solutions is the opposite: its brightest value is a near-white
     224,224,224 at the centre of the mass, with the violet at the flanks. A
     glowing volume is brightest where you look through most of it. */
  /* NO WHITE HEART. The reference's brightest value is a near-white 224,224,224
     and this page cannot have one: the composite caps relative luminance at
     0.036 so that 12px ink stays legible over it, and a white clamped to 0.036
     is a GREY. Measured, that is exactly what happened — the body's interior
     came out rgb(30 58 58), a grey-green hole in the middle of a blue field,
     while the halo just outside it was rgb(4 40 133).
     So the core is the most SATURATED thing rather than the lightest. Under a
     luminance cap that is the only kind of brightness left, and by this page's
     own vividness measure it is the better one anyway. */
  float core = pow(max(nz, 0.0), 1.5);
  /* THE VALUES ARE KEPT UNDER 1.0 ON PURPOSE, and this is the trap the whole
     composite architecture nearly fell into. The framebuffer is RGBA8: anything
     above 1.0 is CLIPPED THERE, before the tone-map ever sees it. So a body
     composed at CORE * 2.4 does not roll off gracefully — it saturates the blue
     channel to 255 in the buffer, arrives at the composite as a flat white-blue,
     and gets scaled down to a desaturated grey. Measured, the body's interior
     read rgb(1 60 61) while the halo an inch outside it read rgb(4 40 133): the
     supposedly brightest part of the picture was its dullest.
     A roll-off can only compress what it can hold. The terms below are sized so
     the composition lands just under 1.0 at its brightest point, which leaves
     the tone-map compressing a real gradient instead of a clipped one. */
  vec3 bodyCol = CORE * (0.04 + 0.30 * core * (0.38 + 0.62 * diff * flow));
  bodyCol += RIMCOL * spec * 0.10;
  bodyCol += RIMCOL * fres * 0.07;
  bodyCol = mix(bodyCol, EMBER * (0.5 + 0.6 * diff), warm * 0.38);
  col = mix(col, col + bodyCol, inside * channel);

  /* A grain of light on the halo, so the falloff is a material and not a ramp. */
  col += CORE * (noise(frag * 0.9 + t * 3.0) - 0.5) * 0.012 * (dome + inside);

  /* Vignette toward the ground at the corners, so the frame has an edge to end
     on rather than being cropped by the window. */
  float vig = smoothstep(1.45, 0.34, length((uv - 0.5) * vec2(1.30, 1.0)));
  col = mix(GROUND, col, 0.42 + 0.58 * vig);

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

  float ceilY = 0.036;
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
