// ============================================================
// MATH
// ============================================================
//
// Scalars, angles, easing and a few 2D helpers. Nothing here
// allocates: vectors are passed as loose x/y pairs and results
// are written into caller-supplied objects or returned as
// scalars. That keeps the per-step allocation count at zero,
// which is most of why the sim holds its frame budget with a few
// hundred entities alive.

export const TAU = Math.PI * 2;

// ------------------------------------------------------------
// SCALARS
// ------------------------------------------------------------

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Frame-rate independent exponential smoothing.
 *
 * The naive `x += (target - x) * 0.1` is tempting but its speed
 * depends on how often you call it. This form is stable for any
 * dt: `rate` is the fraction of the remaining gap closed per
 * second.
 */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

// ------------------------------------------------------------
// EASING
// ------------------------------------------------------------
// Gospel rule 5: everything eases. These are the only two curves
// the project uses, and that is deliberate — a house style with a
// small vocabulary reads as considered, and a grab-bag of easings
// reads as whatever each call site felt like that day. Add one
// only when neither of these can express the motion.

export const easeOutQuad = (t) => t * (2 - t);
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// ------------------------------------------------------------
// ANGLES
// ------------------------------------------------------------

/** Wrap to (-PI, PI]. The workhorse behind every turn calculation. */
export function wrapAngle(a) {
    a = (a + Math.PI) % TAU;
    if (a < 0) a += TAU;
    return a - Math.PI;
}

/** Shortest signed angular distance from `from` to `to`. */
export const angleDelta = (from, to) => wrapAngle(to - from);

/**
 * Rotate `from` toward `to` by at most `maxStep` radians.
 * This is what gives every ship a finite turn rate — nothing in
 * this project snaps to a heading (gospel rule 5).
 */
export function turnToward(from, to, maxStep) {
    const d = angleDelta(from, to);
    if (d > maxStep) return wrapAngle(from + maxStep);
    if (d < -maxStep) return wrapAngle(from - maxStep);
    return to;
}

/** Interpolate between two angles the short way round. */
export function lerpAngle(a, b, t) {
    return wrapAngle(a + angleDelta(a, b) * t);
}

// ------------------------------------------------------------
// 2D
// ------------------------------------------------------------

export const dist2 = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

/**
 * Shortest distance from point P to the segment A→B, squared.
 * Used by swept projectile collision: a tracer's whole path over
 * one step is a segment, and a hull is a circle, so "did it hit"
 * reduces to this against the hull radius. Testing the segment
 * rather than the endpoint is what stops fast rounds tunnelling
 * clean through thin ships.
 */
export function segPointDist2(ax, ay, bx, by, px, py) {
    const vx = bx - ax, vy = by - ay;
    const wx = px - ax, wy = py - ay;
    const len2 = vx * vx + vy * vy;
    // Degenerate segment (the projectile did not move) → point test.
    const t = len2 > 1e-9 ? clamp01((wx * vx + wy * vy) / len2) : 0;
    const dx = ax + vx * t - px;
    const dy = ay + vy * t - py;
    return dx * dx + dy * dy;
}

/**
 * First-order intercept: where to aim so a shot of `speed` meets a
 * target moving at (tvx,tvy). Returns the lead point via `out`.
 *
 * Solving properly means a quadratic in time-to-impact; we use the
 * cheaper fixed-point form (estimate flight time from present
 * distance, then re-estimate once). Two iterations is visually
 * indistinguishable from exact at our speeds and never produces
 * the NaN that an unguarded quadratic can when the target
 * outruns the projectile.
 */
export function interceptPoint(sx, sy, tx, ty, tvx, tvy, speed, out) {
    let t = dist(sx, sy, tx, ty) / speed;
    for (let i = 0; i < 2; i++) {
        t = dist(sx, sy, tx + tvx * t, ty + tvy * t) / speed;
    }
    out.x = tx + tvx * t;
    out.y = ty + tvy * t;
    return out;
}
