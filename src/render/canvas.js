// ============================================================
// CANVAS — SIZING AND THE WORLD TRANSFORM
// ============================================================
//
// One job: make "1 unit" mean the same thing everywhere, so that
// no drawing code ever has to think about device pixel ratio,
// window size, or scaling. Every renderer draws in world units
// and this module makes that land correctly on the display.
//
// ------------------------------------------------------------
// THE CAMERA
// ------------------------------------------------------------
//
// The world is a fixed 7200×4200 and the viewport is a window onto
// it. What decides which part you are looking at is three numbers —
// `camX`, `camY`, `zoom` — and they exist only here. The simulation
// has no idea it is being watched, which is the same separation that
// lets the whole of `src/sim` run headless.
//
// ------------------------------------------------------------
// WHY THE CAMERA WRITES INTO scale/offset RATHER THAN REPLACING THEM
// ------------------------------------------------------------
//
// `begin()` and `toWorld()` are the two functions that define what a
// world coordinate *means*, and both consume exactly three fields:
// `scale`, `offsetX`, `offsetY`. So the camera does not participate
// in either. It recomputes those three and stops.
//
// That is not merely tidy. `toWorld` is the seam every pointer
// interaction goes through, and its inverse-of-`begin` property is
// asserted across four test files at a few hundred combinations of
// scale, offset, DPR and client rect. Threading a camera *through*
// the transform would have put all of that at risk to no purpose:
// a camera is a statement about where to look, and the transform
// already had a perfectly good way to express one.
//
// ------------------------------------------------------------
// WHAT ZOOM 1 MEANS
// ------------------------------------------------------------
//
// `DEFAULT_VIEW_HEIGHT` world units fill the viewport's height at
// zoom 1 — and it is 1400 because that is exactly what the old
// fixed-fit world was. A hull is therefore the same apparent size on
// screen as it was before the map grew, so none of the visual
// language — hull radii, hairline widths, the scale ladder in
// data/ships.js — had to be re-tuned when the world got nine times
// bigger. Zooming out is then a deliberate act rather than the
// default state.

import { WORLD_WIDTH, WORLD_HEIGHT } from '../core/constants.js';
import { worldWidthFor } from '../core/world.js';

/** Above 2× the extra pixels cost real time and buy almost nothing. */
const MAX_DPR = 2;

/** World units visible vertically at zoom 1 — the pre-camera framing. */
const DEFAULT_VIEW_HEIGHT = 1400;

/** How far in the camera may push. Beyond this a hull is all texture and no shape. */
const MAX_ZOOM = 3;

export class Stage {
    constructor(canvasEl) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext('2d', { alpha: false });

        this.dpr = 1;
        this.cssWidth = 0;
        this.cssHeight = 0;
        this.worldWidth = WORLD_WIDTH;
        this.worldHeight = WORLD_HEIGHT;
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;

        // ----- camera ---------------------------------------
        // Where the viewport is pointed, in world units, and how hard
        // it is pushed in. `baseScale` is the CSS-pixels-per-world-unit
        // at zoom 1; `scale` above is always `baseScale * zoom`.
        this.camX = WORLD_WIDTH * 0.5;
        this.camY = WORLD_HEIGHT * 0.5;
        this.zoom = 1;
        this.baseScale = 1;
        // False until `resize()` has read a real box off the element.
        //
        // The fallbacks below are there so the first frame draws
        // *something* rather than nothing, and they are fine for that.
        // They are not fine as the basis for the world's dimensions:
        // world width follows the viewport aspect, so a guessed box
        // produces a plausible, wrong, silently-corrected-later world.
        // Anything that must run at the final size waits on this.
        this.measured = false;

        // The world's size is decided once, on the first real
        // measurement, and never again.
        //
        // It used to follow the glass on every resize, which is
        // defensible right up until someone drags a window: the
        // battlefield reshaped under a running simulation, so hulls
        // that were happily in open space were suddenly outside the
        // bounds and `avoidEdges` herded the entire fleet back inside
        // a box that had moved. From the outside it looks exactly
        // like resizing the window pins the ships to the viewport.
        //
        // A wide display still gets a wide battlefield — that is
        // decided at load, from the shape of the window it opened in.
        // What it no longer does is renegotiate mid-run.
        this.worldLocked = false;
    }

    /**
     * Re-measure and resize the backing store.
     * Returns true when the viewport's CSS box changed.
     *
     * It used to return "did the world change shape", because the
     * world's width was derived from this measurement. It no longer
     * is — the world is a fixed size and this only decides how much
     * of it fits — so what a caller can still usefully learn here is
     * whether the *view* moved under it.
     *
     * Measures the canvas element rather than `window.innerWidth`.
     * The element is the thing we actually draw into, so its box is
     * the authoritative size — this stays correct under page zoom,
     * inside an embedded pane, and in any future layout where the
     * canvas is not the whole window. Window metrics are also not
     * always populated before first paint, which would otherwise
     * leave us with a 1×1 backing store until something resized.
     */
    resize() {
        const rect = this.canvas.getBoundingClientRect();
        // A real box, or a guess. The distinction matters to the
        // caller even though the drawing does not care — see `measured`.
        this.measured = rect.width > 0 && rect.height > 0;
        const cssW = Math.max(1, Math.round(rect.width) || window.innerWidth || 1);
        const cssH = Math.max(1, Math.round(rect.height) || window.innerHeight || 1);
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

        const changed = cssW !== this.cssWidth || cssH !== this.cssHeight;

        this.cssWidth = cssW;
        this.cssHeight = cssH;
        this.dpr = dpr;

        const pxW = Math.round(cssW * dpr);
        const pxH = Math.round(cssH * dpr);
        if (this.canvas.width !== pxW) this.canvas.width = pxW;
        if (this.canvas.height !== pxH) this.canvas.height = pxH;

        // The world takes its shape from the glass it opened in, once.
        // A wide display gets a wide battlefield; a later resize gets
        // a bigger window onto the same one. See `worldLocked`.
        let reshaped = false;
        if (!this.worldLocked) {
            const worldW = worldWidthFor(cssW / cssH);
            reshaped = worldW !== this.worldWidth;
            if (reshaped) {
                // Keep the camera where it was *proportionally*, since
                // an absolute x means something different once the
                // battlefield has changed width under it.
                this.camX = this.worldWidth > 0
                    ? (this.camX / this.worldWidth) * worldW
                    : worldW * 0.5;
                this.worldWidth = worldW;
            }
            // Only a real measurement settles it. A guessed box before
            // first paint would lock in a plausible, wrong world.
            if (this.measured) this.worldLocked = true;
        }

        this.baseScale = cssH / DEFAULT_VIEW_HEIGHT;
        this.applyCamera();

        return changed || reshaped;
    }

    // --------------------------------------------------------
    // CAMERA
    // --------------------------------------------------------

    /** The zoom at which the entire world is visible. Also the floor. */
    get minZoom() {
        if (!this.baseScale) return 1;
        const fit = Math.min(this.cssWidth / this.worldWidth, this.cssHeight / this.worldHeight);
        return fit / this.baseScale;
    }

    get maxZoom() {
        return MAX_ZOOM;
    }

    /**
     * Recompute the world transform from the camera, and keep the
     * camera somewhere legal on the way past.
     *
     * The clamp has two cases and the second is the one that is easy
     * to forget: when the viewport is showing *more* than the world
     * has on an axis — which is most of the time once you zoom out to
     * the fit — there is no legal range to clamp into, and the only
     * sensible place to be is centred. Clamping regardless would jam
     * the world against one edge and leave dead space on the other.
     */
    applyCamera() {
        this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom));
        this.scale = this.baseScale * this.zoom;

        const halfW = this.cssWidth / (2 * this.scale);
        const halfH = this.cssHeight / (2 * this.scale);

        this.camX = halfW * 2 >= this.worldWidth
            ? this.worldWidth * 0.5
            : Math.min(this.worldWidth - halfW, Math.max(halfW, this.camX));
        this.camY = halfH * 2 >= this.worldHeight
            ? this.worldHeight * 0.5
            : Math.min(this.worldHeight - halfH, Math.max(halfH, this.camY));

        this.offsetX = this.cssWidth * 0.5 - this.camX * this.scale;
        this.offsetY = this.cssHeight * 0.5 - this.camY * this.scale;
    }

    /**
     * Drag the world by a pointer movement, in CSS pixels.
     *
     * Dividing by `scale` is what makes the grab exact: the world
     * point under the cursor when the drag started is the world point
     * under it now, at every zoom. No easing and no inertia, because
     * both of them break that property — a camera that keeps moving
     * after the mouse stopped is a camera the mouse is no longer
     * holding.
     */
    panByPixels(dxCss, dyCss) {
        if (!this.scale) return;
        this.camX -= dxCss / this.scale;
        this.camY -= dyCss / this.scale;
        this.applyCamera();
    }

    /**
     * Zoom about a point in client coordinates, holding whatever is
     * under it still.
     *
     * Read the world point first, move the zoom, then shift the camera
     * by however much that point drifted. Zooming about the viewport
     * centre instead is a line shorter and feels, immediately and
     * obviously, wrong — the thing you are pointing at is the thing
     * you meant to look closer at.
     */
    zoomAt(clientX, clientY, factor) {
        const before = this.toWorld(clientX, clientY);
        this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
        this.applyCamera();
        const after = this.toWorld(clientX, clientY);
        this.camX += before.x - after.x;
        this.camY += before.y - after.y;
        this.applyCamera();
    }

    /** Frame the entire world. The overview, and the way back from being lost. */
    fitAll() {
        this.zoom = this.minZoom;
        this.camX = this.worldWidth * 0.5;
        this.camY = this.worldHeight * 0.5;
        this.applyCamera();
    }

    /**
     * Reset to the world transform. Call once at the top of a frame;
     * from that point on all coordinates are world units.
     */
    begin() {
        const s = this.scale * this.dpr;
        this.ctx.setTransform(s, 0, 0, s, this.offsetX * this.dpr, this.offsetY * this.dpr);
    }

    /**
     * World units per CSS pixel. Hairlines that should stay one
     * physical pixel wide regardless of scale use this as their
     * lineWidth — a grid line drawn at `1` world unit would thicken
     * on a large display, which reads as heavier and busier.
     */
    get pixel() {
        return 1 / this.scale;
    }

    /**
     * Convert client viewport coordinates (e.g. from mouse/pointer events)
     * to simulation world coordinates.
     *
     * Accounts for element viewport rect, DPR scaling, letterboxing/cover offsets,
     * and world aspect scaling.
     */
    toWorld(clientX, clientY) {
        if (!this.scale) return { x: 0, y: 0 };
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.offsetX) / this.scale,
            y: (clientY - rect.top - this.offsetY) / this.scale,
        };
    }
}
