// ============================================================
// SPATIAL — UNIFORM GRID BROADPHASE
// ============================================================
//
// Almost every question the simulation asks is "what is near
// here?" — the nearest enemy, rocks inside a miner's radius, who
// this tracer might have hit, which hulls are crowding me. Done
// naively that is O(n²) per step and the frame budget is gone by
// a hundred ships.
//
// A uniform grid is the right structure here rather than a
// quadtree: entity density is broadly even (no deep clustering),
// entities move every step so rebuild cost matters more than
// query elegance, and the grid rebuilds in one linear pass with
// zero allocation after warm-up.
//
// The grid is rebuilt from scratch every step. That sounds
// wasteful and is in fact cheaper than incremental updates at our
// entity counts, and it cannot drift out of sync with reality.

export class SpatialGrid {
    constructor(cellSize) {
        this.cellSize = cellSize;
        this.cols = 0;
        this.rows = 0;
        this.originX = 0;
        this.originY = 0;

        /** Bucket per cell. Reused across rebuilds — cleared, never reallocated. */
        /** @type {Array<Array<object>>} */
        this.cells = [];

        /**
         * Indices of the cells that currently hold anything.
         *
         * The grid has 1,848 cells at a 130-unit pitch over the full
         * map and the simulation runs about sixty hulls, so clearing
         * every bucket to empty a few dozen was, measured, **49% of
         * total simulation time** — far and away the most expensive
         * thing the sim did, and all of it spent writing zero to a
         * length that was already zero.
         *
         * Keeping the occupied list turns the clear from "every cell
         * on the map" into "the cells something was actually in".
         */
        this.used = [];
    }

    /**
     * Size the grid to the world. Called on start and whenever the
     * viewport resize changes world width.
     */
    resize(width, height, originX = 0, originY = 0) {
        this.originX = originX;
        this.originY = originY;
        this.cols = Math.max(1, Math.ceil(width / this.cellSize));
        this.rows = Math.max(1, Math.ceil(height / this.cellSize));

        const n = this.cols * this.rows;
        this.cells.length = n;
        for (let i = 0; i < n; i++) {
            if (this.cells[i]) this.cells[i].length = 0;
            else this.cells[i] = [];
        }
        // Cell indices mean something different now, so the old
        // occupied list is not merely stale, it is wrong.
        this.used.length = 0;
    }

    clear() {
        for (let i = 0; i < this.used.length; i++) this.cells[this.used[i]].length = 0;
        this.used.length = 0;
    }

    _col(x) {
        const c = ((x - this.originX) / this.cellSize) | 0;
        return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    }

    _row(y) {
        const r = ((y - this.originY) / this.cellSize) | 0;
        return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
    }

    /** Insert an entity by its point position. */
    insert(ent) {
        const i = this._row(ent.y) * this.cols + this._col(ent.x);
        const bucket = this.cells[i];
        // First thing into this cell since the last clear, so it is now
        // one of the cells that will need emptying. Recorded here
        // rather than in `rebuild` so a direct `insert` cannot leave a
        // bucket that `clear` will never visit.
        if (bucket.length === 0) this.used.push(i);
        bucket.push(ent);
    }

    /** Rebuild from a list, skipping anything flagged dead. */
    rebuild(entities) {
        this.clear();
        for (let i = 0; i < entities.length; i++) {
            const e = entities[i];
            if (!e.dead) this.insert(e);
        }
    }

    /**
     * Visit every entity in cells overlapping the circle (x,y,r).
     *
     * This is a *broadphase*: it hands the callback candidates from
     * overlapping cells, which includes some that fall outside the
     * circle. Callers do their own exact test. Keeping the precise
     * test at the call site avoids paying for a distance check that
     * many callers would only redo with different criteria.
     */
    queryCircle(x, y, r, fn) {
        const c0 = this._col(x - r), c1 = this._col(x + r);
        const r0 = this._row(y - r), r1 = this._row(y + r);
        for (let row = r0; row <= r1; row++) {
            const base = row * this.cols;
            for (let col = c0; col <= c1; col++) {
                const bucket = this.cells[base + col];
                for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
            }
        }
    }

    /**
     * Nearest entity to (x,y) within `maxR` that satisfies `accept`.
     *
     * Searches in expanding rings of cells and stops as soon as the
     * ring it is about to examine cannot possibly contain anything
     * closer than the best found so far. On a populated grid that
     * usually means looking at nine cells instead of the world.
     */
    nearest(x, y, maxR, accept) {
        const maxRing = Math.ceil(maxR / this.cellSize);
        const cx = this._col(x), cy = this._row(y);
        let best = null;
        let bestD2 = maxR * maxR;

        for (let ring = 0; ring <= maxRing; ring++) {
            // Anything in this ring is at least (ring-1)*cell away. Once
            // that floor exceeds our current best, no later ring can win.
            const floor = (ring - 1) * this.cellSize;
            if (best && floor > 0 && floor * floor > bestD2) break;

            const r0 = cy - ring, r1 = cy + ring;
            const c0 = cx - ring, c1 = cx + ring;

            for (let row = r0; row <= r1; row++) {
                if (row < 0 || row >= this.rows) continue;
                const onHorizontalEdge = row === r0 || row === r1;
                const base = row * this.cols;

                for (let col = c0; col <= c1; col++) {
                    if (col < 0 || col >= this.cols) continue;
                    // Interior cells were covered by previous rings.
                    if (!onHorizontalEdge && col !== c0 && col !== c1) continue;

                    const bucket = this.cells[base + col];
                    for (let i = 0; i < bucket.length; i++) {
                        const e = bucket[i];
                        if (!accept(e)) continue;
                        const dx = e.x - x, dy = e.y - y;
                        const d2 = dx * dx + dy * dy;
                        if (d2 < bestD2) { bestD2 = d2; best = e; }
                    }
                }
            }
        }
        return best;
    }
}
