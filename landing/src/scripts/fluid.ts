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

  /* NO CEILING AND NO DITHER HERE ANY MORE — both moved to the composite pass
     at the bottom of this file, and the move was forced by a measurement.

     The cap used to be applied to this shader's own output, which bounds the
     SURFACE and says nothing about what is drawn after it. The swarm is drawn
     after it, additively, and additive blending has no ceiling of its own:
     measured on the rendered page, the surface peaked at L 0.031 and the points
     alone at 0.0795, for a composite of 0.1206 against a budget of 0.051.
     Lowering the per-point alpha would have bought one build's worth of
     compliance and re-opened the question on the next change.

     So the two passes render into a framebuffer and the cap is applied ONCE, to
     the composite, where it can actually be a guarantee. */
  /* THE SURFACE IS THE GROUND, THE SWARM IS THE SUBJECT, and 0.42 is where that
     stops being a sentence and becomes a number.

     Both passes share one contrast budget, enforced by the cap in the composite.
     With the surface painting at full strength it used the whole of it, so every
     point drawn afterwards was scaled straight back down by the cap: measured,
     the swarm changed 0.1% of the visible pixels below the hero, with a peak
     contribution of 25/255. It was, in effect, not there.

     A cap is a safety net, not a mixer. If two layers have to be arbitrated, the
     arbitration belongs in their levels — and the arbitration has an answer:
     the swarm is what the page is about. It draws Topics' own model, seven
     shapes deep, and the surface exists to give it a room to be in. So the
     surface is a wash at a quarter strength and the points get the budget. */
  /* THE LEVEL IS APPLIED IN LINEAR SPACE, and that is not pedantry — it is the
     difference between a dim blue and a dim grey.

     Mixing toward GROUND at 0.26 desaturates, because GROUND is a near-neutral
     and every step toward it takes chroma with it: the surface's brightest pixel
     came out rgb(7 36 81), a channel span of 74, which is barely over the
     threshold this page measures vividness with. Scaling the same colour in
     LINEAR space preserves the ratio between channels, so the hue survives the
     dimming: rgb(0 52 140), span 140.
     Measured on the whole page, that one change is 0.5% vivid pixels against
     33%. Saturation is free; luminance is not; and scaling in sRGB spends the
     one you were trying to keep. */
  vec3 outc = clamp(GROUND + (col - GROUND) * uGain, 0.0, 1.0);
  vec3 ol = mix(outc / 12.92, pow((outc + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), outc));
  ol *= 0.30;
  gl_FragColor = vec4(mix(ol * 12.92, 1.055 * pow(max(ol, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
                          step(vec3(0.0031308), ol)), 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE SWARM — nine thousand points that spend the page becoming seven things.

   The surface above is a ground: it has mood and no subject. This layer is the
   subject. It is one particle system whose rest positions are computed, per
   vertex, from a shape function chosen by how far down the page you are, and
   the seven shapes are Topics' own model rather than a pack of primitives:

     0  VORTEX    a funnel, everything spiralling into one place. The hero, and
                  the only shape here that is about the product as a whole.
     1  STRANDS   four helices side by side that never touch. Four worktrees on
                  one repository, which is the page's opening claim, drawn.
     2  PANES     a tiled grid. A group wrapping its tabs.
     3  COLUMNS   three stacks with gaps. The board, and the comparison.
     4  SHELL     a closed ring around an empty middle. Your machine, your data,
                  nobody in the path.
     5  BARS      a series that rises. What it costs.
     6  LINE      everything converging onto one horizontal run. Landing on main.

   Between any two the particle just interpolates, so nothing is choreographed
   and nothing can fall out of sync with the copy: the transition IS the scroll
   position. Each point keeps its identity across every shape (the same id picks
   its strand, its pane and its bar), which is what makes the change read as one
   thing rearranging rather than as a cross-fade between two pictures.

   WHY IT IS A SECOND PASS AND NOT A SECOND CANVAS
   It draws into the same context, additively, immediately after the surface.
   One canvas, one compositor layer, one resize path — and, more usefully, the
   points and the surface are the same object as far as the page is concerned,
   so `window.__field.freeze()` pins both and both gates see what a visitor sees.

   THE ALPHA IS A CONTRAST BUDGET, NOT A TASTE. Additive blending has no ceiling
   of its own: a hundred overlapping points at 0.1 is white. The surface below
   is capped at L 0.027 against a limit of 0.051, and what is left of that is
   what these may spend — hence a low per-point alpha, a hard clamp on how much
   any pixel may accumulate, and the same reading-column channel the surface
   uses. `check:painted` grades the result on the real pixels.
   ═════════════════════════════════════════════════════════════════════════ */
const P_VERT = `
precision highp float;

attribute float aId;      /* 0..1, stable identity across every shape */
attribute vec2  aSeed;    /* two decorrelated randoms, fixed per point */

uniform vec2  uRes;
uniform float uTime;
uniform float uScroll;
uniform float uPx;        /* canvas pixels per CSS pixel */
uniform float uGain;

varying vec3  vCol;
varying float vAlpha;

const vec3 COOL  = vec3(0.020, 0.430, 1.000);
const vec3 WARM  = vec3(1.000, 0.360, 0.140);

const float TAU = 6.2831853;

/* 0 — THE VORTEX. Radius grows with height and the winding is fast enough to
   read as rotation rather than as a cone drawn in outline. */
vec3 sVortex(float i, float a, float r, float t) {
  float h = i;
  float ang = a * TAU + h * 7.5 + t * 0.22;
  float rad = mix(0.05, 0.92, pow(h, 0.72)) * (0.72 + 0.28 * r);
  return vec3(cos(ang) * rad, h * 1.62 - 0.86, sin(ang) * rad);
}

/* 1 — FOUR STRANDS. The branch count is the one number on this page that is
   also in the headline, so it is four and not "some". */
vec3 sStrands(float i, float a, float r, float t) {
  float k = floor(a * 4.0);
  float ang = i * 6.4 + k * 1.9 + t * 0.3;
  float x = (k - 1.5) * 0.44 + cos(ang) * 0.085;
  float z = sin(ang) * 0.085;
  return vec3(x, i * 1.72 - 0.86, z);
}

/* OUTLINES, NOT FILLS, for everything architectural. Measured: nine thousand
   points poured into a twelve-cell grid is 750 per cell, and 750 points inside
   a 100px square is a blob — a high-frequency probe over the rendered page
   found 1,497 distinguishable points in the vortex and 104 in the pane grid,
   which is the difference between a shape and a smear. On a perimeter the same
   750 points are a drawn rectangle. It also happens to be the right register:
   a wireframe reads as a plan of something, which is what these shapes are. */
vec2 rectEdge(vec2 c, vec2 hs, float u) {
  float q = u * 4.0;
  if (q < 1.0) return c + vec2(mix(-hs.x, hs.x, q), -hs.y);
  if (q < 2.0) return c + vec2(hs.x, mix(-hs.y, hs.y, q - 1.0));
  if (q < 3.0) return c + vec2(mix(hs.x, -hs.x, q - 2.0), hs.y);
  return c + vec2(-hs.x, mix(hs.y, -hs.y, q - 3.0));
}

/* 2 — PANES. Three across, two down. Twelve cells was the first try and twelve
   rectangles at this scale, seen in perspective, overlap into noise — measured
   as a density map, the grid read as vertical stripes. Six is also the truer
   number: a group in this product holds a handful of panes, not a dozen. */
vec3 sPanes(float i, float a, float r) {
  float k = floor(a * 6.0);
  float cx = mod(k, 3.0), cy = floor(k / 3.0);
  vec2 e = rectEdge(vec2((cx - 1.0) * 0.66, (cy - 0.5) * 0.82),
                    vec2(0.29, 0.35), fract(i * 7.0 + a));
  return vec3(e + (vec2(fract(i * 53.0), r) - 0.5) * 0.022,
              (fract(a * 31.0) - 0.5) * 0.12);
}

/* 3 — COLUMNS. Three of them, and a card sitting in the middle one, because a
   board with nothing on it is a grid. */
vec3 sColumns(float i, float a, float r) {
  float k = floor(a * 3.0);
  float u = fract(a * 3.0);
  vec2 e = (u < 0.22 && k > 0.5 && k < 1.5)
    ? rectEdge(vec2(0.0, 0.30), vec2(0.17, 0.13), fract(i * 11.0))
    : rectEdge(vec2((k - 1.0) * 0.62, 0.0), vec2(0.22, 0.74), fract(i * 5.0 + a));
  return vec3(e + (vec2(r, fract(i * 91.0)) - 0.5) * 0.022,
              (fract(a * 97.0) - 0.5) * 0.16);
}

/* 4 — THE SHELL. Hollow on purpose: it is the shape for the section about
   nothing of yours leaving the machine. */
vec3 sShell(float i, float a, float r, float t) {
  float ang = a * TAU + t * 0.16;
  float rad = 0.80 + (r - 0.5) * 0.09;
  return vec3(cos(ang) * rad, sin(ang) * rad * 0.66, sin(ang * 2.0 + i * 3.0) * 0.26);
}

/* 5 — BARS. Seven, rising, drawn as outlines with a baseline under them. */
vec3 sBars(float i, float a, float r) {
  float k = floor(a * 7.0);
  float u = fract(a * 7.0);
  float top = 0.16 + 0.84 * (k / 6.0);
  vec2 e = u < 0.13
    ? vec2(mix(-1.0, 1.0, fract(i * 13.0)), -0.84)     /* the axis */
    : rectEdge(vec2((k - 3.0) * 0.29, -0.84 + top * 0.80),
               vec2(0.105, top * 0.80), fract(i * 5.0 + a));
  return vec3(e + (vec2(r, fract(i * 41.0)) - 0.5) * 0.02,
              (fract(a * 17.0) - 0.5) * 0.13);
}

/* 6 — THE LINE. */
vec3 sLine(float i, float a, float r) {
  return vec3((a - 0.5) * 2.3, (r - 0.5) * 0.07, (fract(i * 29.0) - 0.5) * 0.12);
}

vec3 shapeAt(float k, float i, float a, float r, float t) {
  if (k < 0.5) return sVortex(i, a, r, t);
  if (k < 1.5) return sStrands(i, a, r, t);
  if (k < 2.5) return sPanes(i, a, r);
  if (k < 3.5) return sColumns(i, a, r);
  if (k < 4.5) return sShell(i, a, r, t);
  if (k < 5.5) return sBars(i, a, r);
  return sLine(i, a, r);
}

void main() {
  float i = aId;
  float a = aSeed.x;
  float r = aSeed.y;
  float t = uTime;
  float s = clamp(uScroll, 0.0, 1.0);

  /* Six transitions across the page. smoothstep on the fraction so a point
     arrives and leaves at rest rather than at speed — a linear morph reads as a
     slide, an eased one reads as a thing settling. */
  float stage = s * 6.0;
  float k = floor(stage);
  float f = smoothstep(0.0, 1.0, fract(stage));
  vec3 pos = mix(shapeAt(k, i, a, r, t), shapeAt(k + 1.0, i, a, r, t), f);

  /* IT SWAYS, IT DOES NOT SPIN. The first version rotated continuously — yaw =
     t * 0.075 + s * 1.1 — and four of the seven shapes are FLAT: the pane grid,
     the columns, the bars and the line. A flat shape carried past 90 degrees is
     a line, and the grid duly read as a smear rather than as a grid at the one
     scroll position it was supposed to be legible. Rotation is not what makes
     this read as three-dimensional; the tilt, the perspective divide and the
     depth fade are. So the yaw oscillates inside ±24° and every shape faces the
     reader for the whole of its stage. */
  float yaw = sin(t * 0.11 + s * 2.2) * 0.30;
  float cy = cos(yaw), sy = sin(yaw);
  pos = vec3(pos.x * cy + pos.z * sy, pos.y, -pos.x * sy + pos.z * cy);
  float tilt = 0.30;
  pos = vec3(pos.x, pos.y * cos(tilt) - pos.z * sin(tilt), pos.y * sin(tilt) + pos.z * cos(tilt));

  /* Perspective, by hand: no matrix is worth it for one object.

     The horizontal correction is PARTIAL, and that is a decision rather than a
     shortcut. Dividing fully by the aspect keeps circles circular and leaves the
     swarm occupying the middle 42% of a 16:9 window — measured off the rendered
     page, the point density was zero outside columns 16 to 36 of 48, which is
     exactly the band the reading column occupies and exactly where a background
     should not be. At 0.62 + 0.38·aspect the shapes are gently wide, the way a
     composition for a landscape frame should be, and they reach the edges. */
  float depth = pos.z + 2.9;
  float aspect = uRes.x / uRes.y;
  vec2 proj = pos.xy / depth * 2.9;
  proj.x /= (0.62 + 0.38 * aspect);
  /* The swarm sits behind the column of text, a little above centre, and drifts
     down as the page goes so it never occupies the same band twice running. */
  proj.y += 0.12 - s * 0.16;

  gl_Position = vec4(proj, 0.0, 1.0);
  gl_PointSize = clamp(5.2 / depth, 1.1, 4.6) * uPx * (0.75 + 0.5 * r);

  /* One in seven is warm. In the product orange is the agent — it is what the
     tab bar paints Claude with — so the swarm has the same two-colour cast as
     the thing it is about, at the same ratio the app shows it. */
  vCol = mix(COOL, WARM, step(0.86, a));

  /* Nearer is brighter — the depth cue doing the work a projection matrix would
     otherwise do — but it never reaches zero. A hard fade threw away the far
     half of the cloud, which is half the coverage for no gain in legibility. */
  float near = 0.30 + 0.70 * smoothstep(4.4, 1.8, depth);

  /* THE SAME CHANNEL THE SURFACE USES. Screen x from the clip position, so the
     points thin out down the middle of the page below the hero — where the
     reading column is — and stay at full strength at the flanks. */
  float sx = proj.x * 0.5 + 0.5;
  float column = smoothstep(0.40, 0.08, abs(sx - 0.5));
  float open = smoothstep(0.04, 0.16, s);
  float channel = 1.0 - column * open * 0.66;

  /* Fade out at the very top and bottom of the shape rather than letting it be
     cut by the viewport edge. */
  float edge = smoothstep(1.15, 0.75, abs(proj.y));

  vAlpha = 0.55 * near * channel * edge * uGain;
}
`;

const P_FRAG = `
precision mediump float;
varying vec3 vCol;
varying float vAlpha;
void main() {
  /* A soft disc. A square point is the tell of a particle system that was not
     finished, and at these sizes the falloff is most of what makes the cloud
     read as light rather than as confetti. */
  vec2 d = gl_PointCoord - 0.5;
  float m = smoothstep(0.5, 0.06, length(d));
  gl_FragColor = vec4(vCol * vAlpha * m, 1.0);
}
`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE COMPOSITE — where the contrast budget is actually enforced.

   The surface and the swarm both render into a framebuffer; this pass reads it
   back, clamps its relative luminance, dithers, and writes to the screen. One
   ceiling, applied to what the visitor sees, rather than one per pass applied to
   things that then add together.

   THE NUMBER IS DERIVED, NOT TUNED. The palest reading ink on this page is
   --ink-faint #a3abbb, L 0.405. WCAG asks 4.5:1, so the brightest pixel that may
   sit behind a glyph is (0.405 + 0.05) / 4.5 − 0.05 = L 0.051. The cap is set
   below that because one layer is still painted after this one — the CSS dot
   weave, which measured +0.011 on the brightest pixel — and a ceiling has to
   leave room for what it cannot see.

   TWO CORRECTIONS ARE IN THE MATHS, both found by screenshotting rather than by
   reasoning. pow(c, 2.2) is the gamma people quote and not the curve sRGB has;
   it under-read true luminance by 22%. And scaling an sRGB triple by k does NOT
   scale its luminance by k^2.4 — the affine (c+0.055)/1.055 term breaks that
   law, so a cap of 0.030 produced pixels at 0.043 and the error grew with the
   pullback. The clamp is applied in LINEAR space, where luminance is linear by
   definition and the scale is exact.

   It is a cap on LIGHT, not on colour, and that is what lets the page still look
   like something: a saturated blue at low luminance is both legal here and VIVID
   by the channel-span measure this page's blandness was diagnosed with.
   ═════════════════════════════════════════════════════════════════════════ */
const C_VERT = `
attribute vec2 p;
varying vec2 vUv;
void main(){ vUv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }
`;

const C_FRAG = `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
varying vec2 vUv;

const vec3 GROUND = vec3(0.039, 0.051, 0.078);

float h1(vec2 p){
  p = fract(p * vec2(233.34, 851.73));
  p += dot(p, p + 23.45);
  return fract(p.x * p.y);
}

void main(){
  vec3 col = texture2D(uTex, vUv).rgb;

  vec3 c0 = clamp(col, 0.0, 1.0);
  vec3 lin = mix(c0 / 12.92, pow((c0 + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c0));
  float lumY = dot(lin, vec3(0.2126, 0.7152, 0.0722));

  /* A ROLL-OFF, NOT A CLIFF. The first version was min(1, ceil/L): everything
     over the ceiling was scaled to sit exactly on it, which is a hard clip.
     Two things were wrong with that and the second one is why this changed.

     A clip flattens: every dense cluster of points lands on the same value and
     the shape inside it disappears. And a clip makes the two passes compete —
     with the surface using most of the budget, every point drawn afterwards was
     scaled straight back down, and the swarm measured as changing 0.1% of the
     visible pixels with a peak contribution of 25/255. It was, in effect, off.

     ceil · (1 − e^(−L/ceil)) is linear where there is room and asymptotic where
     there is not. Nothing ever reaches the ceiling, so nothing is ever clipped,
     and a sparse point at a tenth of the budget passes through untouched while a
     pile of forty of them rolls off. It is the same curve a camera has, and for
     the same reason. */
  float ceilY = 0.038;
  float mapped = ceilY * (1.0 - exp(-lumY / ceilY));
  lin *= mapped / max(lumY, 0.00001);
  col = mix(lin * 12.92, 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
            step(vec3(0.0031308), lin));

  /* Dither. Eight-bit blue on near-black bands badly, and a banded gradient is
     the single most reliable way to make a shader look cheap. */
  float d = (h1(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(max(col + d, GROUND * 0.0), 1.0);
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

/* Twenty-four thousand, and the number is a COVERAGE problem rather than a
   detail one. The budget the composite enforces caps how bright any pixel may
   be; it says nothing about how many pixels the swarm may touch. At nine
   thousand points the swarm changed 0.6% of the visible pixels — every one of
   them correct and legal, and collectively invisible. Tripling the count
   triples the coverage at the same per-point brightness, which is the one lever
   that does not spend contrast.
   It is still cheap: 288KB of static buffer, and a vertex shader that evaluates
   two of the seven shapes per point per frame. Vertices are not where a page
   like this runs out of time — fragments are, and these are three pixels each. */
const COUNT = 24000;

function start(cv: HTMLCanvasElement) {
  const gl = (cv.getContext('webgl', { antialias: false, depth: false, alpha: false, powerPreference: 'low-power' }) ||
    cv.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return false;

  const prog = link(gl, VERT, FRAG);
  const pProg = link(gl, P_VERT, P_FRAG);
  const cProg = link(gl, C_VERT, C_FRAG);
  if (!prog || !pProg || !cProg) return false;

  /* ── the offscreen target ──────────────────────────────────────────────── */
  /* Both passes draw here and the composite reads it back. The alternative — a
     ceiling inside each pass — cannot work, because additive blending has no
     ceiling: two passes each individually legal add up to one that is not, and
     measured, they did (0.031 + 0.0795 = 0.1206 against a budget of 0.051).
     LINEAR filtering, because the buffer is at 55% of CSS pixels and is stretched
     to the canvas: NEAREST there gives a fluid visible pixel steps. */
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

  /* ── the surface ───────────────────────────────────────────────────────── */
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');

  const u = {
    res: gl.getUniformLocation(prog, 'uRes'),
    time: gl.getUniformLocation(prog, 'uTime'),
    scroll: gl.getUniformLocation(prog, 'uScroll'),
    ptr: gl.getUniformLocation(prog, 'uPtr'),
    ptrOn: gl.getUniformLocation(prog, 'uPtrOn'),
    gain: gl.getUniformLocation(prog, 'uGain'),
  };

  /* ── the swarm ─────────────────────────────────────────────────────────── */
  /* Identity and two randoms per point, uploaded once and never touched again:
     every shape is a pure function of those three numbers and the clock, so
     there is no position buffer to update and nothing to read back. The whole
     morph costs one uniform write per frame. */
  const ids = new Float32Array(COUNT);
  const seeds = new Float32Array(COUNT * 2);
  let sd = 0x2f6e2b1;
  const rnd = () => {
    sd ^= sd << 13; sd ^= sd >>> 17; sd ^= sd << 5;
    return ((sd >>> 0) % 100000) / 100000;
  };
  for (let n = 0; n < COUNT; n++) {
    ids[n] = n / (COUNT - 1);
    seeds[n * 2] = rnd();
    seeds[n * 2 + 1] = rnd();
  }
  const idBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, idBuf);
  gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
  const seedBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
  gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW);

  gl.useProgram(pProg);
  const pLocId = gl.getAttribLocation(pProg, 'aId');
  const pLocSeed = gl.getAttribLocation(pProg, 'aSeed');
  const pu = {
    res: gl.getUniformLocation(pProg, 'uRes'),
    time: gl.getUniformLocation(pProg, 'uTime'),
    scroll: gl.getUniformLocation(pProg, 'uScroll'),
    px: gl.getUniformLocation(pProg, 'uPx'),
    gain: gl.getUniformLocation(pProg, 'uGain'),
  };

  gl.useProgram(cProg);
  const cLoc = gl.getAttribLocation(cProg, 'p');
  const cu = {
    tex: gl.getUniformLocation(cProg, 'uTex'),
    res: gl.getUniformLocation(cProg, 'uRes'),
    time: gl.getUniformLocation(cProg, 'uTime'),
  };
  gl.uniform1i(cu.tex, 0);

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
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.useProgram(prog); gl.uniform2f(u.res, w, h);
    gl.useProgram(pProg);
    gl.uniform2f(pu.res, w, h);
    gl.uniform1f(pu.px, dpr * SCALE);
    gl.useProgram(cProg); gl.uniform2f(cu.res, w, h);
  };
  resize();
  addEventListener('resize', resize, { passive: true });

  /* THREE PASSES. Surface and swarm into the framebuffer, then one composite to
     the screen that clamps what they add up to.
     `only` exists for the gates and for measuring, not for the page: 'surface'
     draws the ground alone, 'swarm' draws the points alone on flat ink. Without
     it there is no way to attribute a pixel to one pass or the other, and the
     first attempt to measure the shapes read the SURFACE's own gradient as
     particles and reported the swarm sitting off the right-hand edge. */
  const fullscreen = (program: WebGLProgram, attr: number) => {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(attr);
    gl.vertexAttribPointer(attr, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const paint = (t: number, at: number, ptX: number, ptY: number, on: number, gain: number,
                 only?: 'surface' | 'swarm') => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);

    if (only === 'swarm') {
      gl.clearColor(0.039, 0.051, 0.078, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.useProgram(prog);
      gl.uniform1f(u.time, t);
      gl.uniform1f(u.scroll, at);
      gl.uniform2f(u.ptr, ptX, ptY);
      gl.uniform1f(u.ptrOn, on);
      gl.uniform1f(u.gain, gain);
      fullscreen(prog, loc);
    }

    if (only !== 'surface') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);    /* the points are light, so they add */
      gl.useProgram(pProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuf);
      gl.enableVertexAttribArray(pLocId);
      gl.vertexAttribPointer(pLocId, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuf);
      gl.enableVertexAttribArray(pLocSeed);
      gl.vertexAttribPointer(pLocSeed, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(pu.time, t);
      gl.uniform1f(pu.scroll, at);
      gl.uniform1f(pu.gain, gain);
      gl.drawArrays(gl.POINTS, 0, COUNT);
      gl.disableVertexAttribArray(pLocId);
      gl.disableVertexAttribArray(pLocSeed);
      gl.disable(gl.BLEND);
    }

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
    paint(t, scroll, px, py, ptrOn, Math.min(1, t / 1.1));
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
  const drawOnce = (t: number, at: number, pointerAt?: [number, number],
                    only?: 'surface' | 'swarm') =>
    paint(t, at, pointerAt ? pointerAt[0] : -9999, pointerAt ? pointerAt[1] : -9999,
          pointerAt ? 1 : 0, 1, only);

  (window as unknown as { __field?: unknown }).__field = {
    freeze(t: number, at: number, pointer?: [number, number], only?: 'surface' | 'swarm') {
      cancelAnimationFrame(raf);
      raf = 0;
      const dpr = Math.min(devicePixelRatio || 1, 1.5) * SCALE;
      drawOnce(t, at, pointer ? [pointer[0] * dpr, (innerHeight - pointer[1]) * dpr] : undefined, only);
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
