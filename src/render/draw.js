// ============================================================
// DRAW — PRIMITIVES
// ============================================================
//
// The small vocabulary every renderer is built from. Two ideas
// carry most of the weight:
//
// 1. Shapes are flat coordinate arrays, in local space, with
//    forward = +X. Callers translate and rotate; shapes never
//    know where they are. That keeps `hulls.js` a pure list of
//    silhouettes.
//
// 2. Glow is *layered strokes*, never `shadowBlur`.
//
// The second one deserves its own note, because it is the
// difference between this project looking designed and looking
// generated.
//
// ------------------------------------------------------------
// WHY LAYERED STROKES INSTEAD OF shadowBlur
// ------------------------------------------------------------
//
// `ctx.shadowBlur` is the obvious way to make something glow and
// it is wrong here for three reasons. It is genuinely slow — a
// full gaussian per draw call, and we have hundreds. It produces
// a soft symmetric smear that reads as *blurry*, which at small
// sizes is indistinguishable from being out of focus. And it
// gives you no control over the falloff curve.
//
// Stroking the same path three times — wide and faint, medium,
// then thin and bright — costs three cheap strokes, stays
// perfectly crisp at the core, and lets the falloff be authored.
// The eye reads the bright thin core as the object and the wide
// faint pass as its light. It is the same trick a printer uses to
// suggest a halo, and it is why the weapon fire has an edge to it
// rather than a fog.
//
// The layer recipes themselves live in `data/themes.js` under
// `theme.fx`, because how many layers and at what alpha is a
// property of the *light model*, and the two themes model light
// completely differently.

import { rgba } from '../core/color.js';
import { TAU } from '../core/math.js';

// ------------------------------------------------------------
// PATHS
// ------------------------------------------------------------

/**
 * Build a closed path from a flat [x0,y0,x1,y1,...] array.
 * Does not fill or stroke — the caller decides what to do with it,
 * which is what makes layering possible.
 */
export function tracePoly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
}

/** Regular n-gon centred on the origin, as a fresh path. */
export function traceRegular(ctx, sides, radius, rotation = 0) {
    ctx.beginPath();
    traceRegularInto(ctx, sides, radius, rotation);
}

/**
 * Add a regular n-gon to the *current* path without starting a new
 * one. Two of these plus an even-odd fill make an annulus in a
 * single fill call — which is how the mothership's ring is drawn.
 */
export function traceRegularInto(ctx, sides, radius, rotation = 0) {
    for (let i = 0; i < sides; i++) {
        const a = rotation + (i / sides) * TAU;
        const x = Math.cos(a) * radius;
        const y = Math.sin(a) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

export function fillPoly(ctx, pts, style, alpha = 1) {
    tracePoly(ctx, pts);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = style;
    ctx.fill();
    ctx.globalAlpha = 1;
}

// ------------------------------------------------------------
// LAYERED GLOW
// ------------------------------------------------------------

/**
 * Stroke the current path once per layer, widest and faintest
 * first. The final layer is the core: it uses `coreColor` when the
 * theme wants a hot centre (`void`) and the base colour when it
 * does not (`paper`, where a near-white core would simply vanish
 * into the stock).
 *
 * The path is built by the caller and reused across all layers —
 * `stroke()` does not consume it, so three layers cost three
 * strokes and one path build.
 *
 * @param {object} spec   {widths, alphas} from theme.fx
 * @param {string} color  base colour
 * @param {?string} core  hot-core colour, or null to use `color` throughout
 * @param {number} scale  master alpha multiplier (fades, pulses, distance)
 */
export function layeredStroke(ctx, spec, color, core, scale = 1) {
    const { widths, alphas } = spec;
    const last = widths.length - 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i <= last; i++) {
        const a = alphas[i] * scale;
        if (a <= 0.002) continue;
        ctx.lineWidth = widths[i];
        ctx.strokeStyle = rgba(i === last && core ? core : color, a);
        ctx.stroke();
    }
}

// ------------------------------------------------------------
// SOFT BLOOMS
// ------------------------------------------------------------
//
// Layered strokes are right for *lines* — a tracer wants a crisp
// core, and three passes give one. They are wrong for *points*.
//
// The first version of the thruster plume was three concentric
// discs from the same recipe, and it read as a murky grey circle
// rather than as light: hard-edged rings band visibly instead of
// falling off, and a 10%-alpha teal added to a near-black ground
// barely moves it, so the shape reads as a solid object rather
// than as a glow. It made every ship look like it was towing a
// stone.
//
// A point light needs a genuine radial falloff. So blooms are
// stamped from a pre-rendered radial-gradient brush: the gradient
// is built once per colour into a small offscreen canvas, and each
// use is a single `drawImage`. That gets a smooth profile with no
// per-frame gradient allocation, and stretching the stamp into an
// ellipse costs nothing — which is how the thruster gets its
// teardrop.

/** Brush resolution. 64px is well past what any bloom is drawn at. */
const BRUSH_SIZE = 64;

/** @type {Map<string, HTMLCanvasElement>} */
const _brushes = new Map();

/**
 * A soft radial brush in `color`, cached forever.
 *
 * The stops approximate an inverse-square falloff: a compact
 * bright core carrying most of the energy, then a long faint
 * skirt. A plain linear gradient looks like a fogged circle.
 */
function brush(color) {
    let canvas = _brushes.get(color);
    if (canvas) return canvas;

    canvas = document.createElement('canvas');
    canvas.width = canvas.height = BRUSH_SIZE;

    const g = canvas.getContext('2d');
    const c = BRUSH_SIZE / 2;
    const grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0.00, rgba(color, 1.00));
    grad.addColorStop(0.12, rgba(color, 0.82));
    grad.addColorStop(0.30, rgba(color, 0.38));
    grad.addColorStop(0.55, rgba(color, 0.12));
    grad.addColorStop(0.80, rgba(color, 0.03));
    grad.addColorStop(1.00, rgba(color, 0.00));

    g.fillStyle = grad;
    g.fillRect(0, 0, BRUSH_SIZE, BRUSH_SIZE);

    _brushes.set(color, canvas);
    return canvas;
}

/** A soft circular bloom centred on (x, y). */
export function softDot(ctx, x, y, radius, color, alpha) {
    if (alpha <= 0.004 || radius <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(brush(color), x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
}

/**
 * The same bloom stretched into an ellipse — `rx` along the local
 * X axis, `ry` across it. Used for thruster plumes, which are
 * teardrops rather than circles.
 */
export function softEllipse(ctx, x, y, rx, ry, color, alpha) {
    if (alpha <= 0.004 || rx <= 0.01 || ry <= 0.01) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(brush(color), x - rx, y - ry, rx * 2, ry * 2);
    ctx.globalAlpha = 1;
}

// ------------------------------------------------------------
// COMET SPRITE — THE TRACER
// ------------------------------------------------------------
//
// Tracers get their own pre-rendered sprite rather than the
// layered strokes used for beams and rings, and the distinction is
// worth understanding before changing either.
//
// Layered strokes work beautifully for a *beam*: it is long and
// thin, so a wide faint pass alongside a bright thin one reads
// exactly as a line with a halo around it.
//
// They fail for a tracer, because a tracer is short. At sixteen
// world units long and seven wide, the "halo" pass is nearly as
// wide as the whole effect is long — so instead of a glow you get
// a hard-edged capsule, and adding ten percent of a colour to a
// near-black ground yields a *muddy* capsule at that. On screen it
// read as a dark pill with a white bar inside it: unmistakably a
// solid object, which is the one thing a bolt of light must not
// look like.
//
// So the comet is built once, offscreen, by stamping the radial
// brush along an axis with a rising alpha and radius ramp. Every
// edge inherits the brush's falloff, the overlapping stamps
// accumulate into a smooth tail, and drawing one costs a single
// rotated `drawImage`.
//
// The sprite is built in the *theme's own* compositing mode, so on
// `void` the stamps add into light with a white-hot head, and on
// `paper` they layer into saturated ink with no white anywhere.

const COMET_W = 192;
const COMET_H = 64;
const COMET_STAMPS = 26;

/** @type {Map<string, HTMLCanvasElement>} */
const _comets = new Map();

function comet(color, core, composite) {
    const key = color + '|' + core + '|' + composite;
    let canvas = _comets.get(key);
    if (canvas) return canvas;

    canvas = document.createElement('canvas');
    canvas.width = COMET_W;
    canvas.height = COMET_H;

    const g = canvas.getContext('2d');
    g.globalCompositeOperation = composite;

    const cy = COMET_H / 2;
    const headX = COMET_W - cy;
    const tailX = cy * 0.4;
    const b = brush(color);

    for (let i = 0; i < COMET_STAMPS; i++) {
        const t = i / (COMET_STAMPS - 1);          // 0 tail → 1 head
        const x = tailX + (headX - tailX) * t;
        // Radius and alpha both ramp steeply, so the tail is a thin
        // whisper and the head is compact and dense.
        const r = COMET_H * (0.10 + 0.32 * t * t);
        const a = 0.13 * Math.pow(t, 2.0);
        g.globalAlpha = a;
        g.drawImage(b, x - r, cy - r, r * 2, r * 2);
    }

    // The head itself: two tight stamps in the core colour. On
    // `paper` `core` is the ink colour, so this stays ink.
    const hot = core || color;
    const hb = brush(hot);
    g.globalAlpha = 0.75;
    g.drawImage(hb, headX - COMET_H * 0.26, cy - COMET_H * 0.26, COMET_H * 0.52, COMET_H * 0.52);
    g.globalAlpha = 1;
    g.drawImage(hb, headX - COMET_H * 0.13, cy - COMET_H * 0.13, COMET_H * 0.26, COMET_H * 0.26);

    _comets.set(key, canvas);
    return canvas;
}

/**
 * Stamp a comet with its head at (x, y), pointing along `angle`.
 *
 * `length` is the full visible extent in world units; width follows
 * the sprite's aspect so the head stays round.
 */
export function cometStamp(ctx, x, y, angle, length, color, core, composite, alpha, girth = 1) {
    if (alpha <= 0.004 || length <= 0.01) return;
    const sprite = comet(color, core, composite);
    // Height is normally locked to length by the sprite's aspect, so
    // every round in the game was the same shape at different sizes —
    // a torpedo read as a long pulse round rather than as a different
    // class of object. `girth` unlocks the short axis so heavy
    // ordnance can be *fat* as well as long, which is most of what
    // makes it look like it weighs something.
    const h = length * (COMET_H / COMET_W) * girth;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.globalAlpha = alpha;
    // Head sits at the local origin: the sprite's head is half its
    // height in from the right edge.
    ctx.drawImage(sprite, -(length - h / 2), -h / 2, length, h);
    ctx.restore();
    ctx.globalAlpha = 1;
}

/** Layered ring — an expanding outline, for impacts and death blooms. */
export function layeredRing(ctx, x, y, radius, spec, color, core, scale = 1) {
    if (radius <= 0.05) return;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    layeredStroke(ctx, spec, color, core, scale);
}
