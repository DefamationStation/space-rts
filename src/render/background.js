// ============================================================
// BACKGROUND — GROUND AND GRID
// ============================================================
//
// Flat ground plus a faint grid. That is the entire backdrop, and
// the restraint is deliberate.
//
// Starfields and nebulae are the obvious thing to reach for and
// the wrong one: they add high-frequency detail across the whole
// frame, which is exactly the region of the image where the ships
// and their weapon fire need to be the only thing moving. A
// background that competes is a background that has failed.
//
// The grid earns its place by doing a job nothing else does — it
// gives the eye a fixed reference so motion reads as motion, and
// it makes distance legible at a glance. It is one hairline
// weight, one alpha, no major/minor emphasis, drawn beneath
// everything and never noticed.
//
// To remove it entirely: set GRID_ALPHA to 0 in core/constants.js.

import { GRID_SPACING, GRID_ALPHA } from '../core/constants.js';

/**
 * Paint ground and grid. Runs under the world transform, so all
 * coordinates here are world units.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} theme  resolved palette from data/themes.js
 * @param {import('./canvas.js').Stage} stage
 */
export function drawBackground(ctx, theme, stage, clear = true) {
    const w = stage.worldWidth;
    const h = stage.worldHeight;

    // Clear the whole backing store, ignoring the world transform.
    //
    // Filling in world coordinates only guarantees a clean frame
    // while the transform happens to cover the canvas. The moment it
    // does not — a zoomed inspection view, a future camera, a world
    // narrower than the viewport — the uncovered margin keeps last
    // frame's pixels and the scene ghosts. Clearing in device space
    // is one save/restore and cannot be got wrong later.
    //
    // `clear: false` is for callers compositing several views onto
    // one canvas (dev/fx.js), which paint their own panel ground.
    if (clear) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = theme.ground;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.restore();
    }

    if (GRID_ALPHA <= 0) return;

    ctx.save();
    ctx.globalAlpha = GRID_ALPHA;
    ctx.strokeStyle = theme.grid;
    // One CSS pixel regardless of display scale — a grid line that
    // thickens on a 4K panel reads as heavier and busier.
    ctx.lineWidth = stage.pixel;

    // A single path for every line: one stroke call instead of ~40.
    ctx.beginPath();
    for (let x = GRID_SPACING; x < w; x += GRID_SPACING) {
        // The half-pixel offset lands the hairline on a pixel centre
        // rather than straddling two, which is the difference between
        // a crisp line and a soft grey smear.
        const px = Math.round(x) + stage.pixel * 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, h);
    }
    for (let y = GRID_SPACING; y < h; y += GRID_SPACING) {
        const py = Math.round(y) + stage.pixel * 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(w, py);
    }
    ctx.stroke();
    ctx.restore();
}
