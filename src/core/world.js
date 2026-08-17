// ============================================================
// WORLD — SINGLE SOURCE OF TRUTH
// ============================================================
//
// One object holds the entire simulation state. Everything that
// mutates the sim takes a `world` and works through it; nothing
// keeps its own private copy of anything that matters.
//
// This module imports nothing from `src/render` and touches no
// browser API, which is a hard rule rather than an accident: it
// is what lets the whole simulation run headless under
// `node --test` with no DOM stubbing, and it is what makes the
// determinism test possible.

import { Rng } from './rng.js';
import { EventBus } from './events.js';
import { SpatialGrid } from './spatial.js';
import {
    SPATIAL_CELL, WORLD_WIDTH, WORLD_HEIGHT, WORLD_WIDTH_MIN, WORLD_WIDTH_MAX,
} from './constants.js';

/**
 * World width for a given viewport aspect.
 *
 * Height is fixed, so a wide display gets a wide battlefield rather
 * than the same battlefield with empty glass either side. Clamped at
 * both ends: narrow enough that a portrait window does not produce a
 * corridor, wide enough to fill 32:9 and no wider.
 */
export function worldWidthFor(aspect) {
    const w = Math.round(WORLD_HEIGHT * aspect);
    return Math.max(WORLD_WIDTH_MIN, Math.min(WORLD_WIDTH_MAX, w));
}

export class World {
    constructor({ seed = 1, width = WORLD_WIDTH, height = WORLD_HEIGHT } = {}) {
        this.seed = seed >>> 0;
        this.rng = new Rng(this.seed);
        // Effects draw from their own stream. If sparks and debris
        // shared the simulation's generator, a run with visual effects
        // attached would diverge from the same seed run headlessly —
        // and the determinism guarantee would be worthless exactly
        // where it is most useful.
        this.fxRng = this.rng.fork();
        this.width = width;
        this.height = height;

        this.time = 0;      // s of simulated time
        this.tick = 0;      // completed fixed steps

        /** Asteroid fields, owned by sim/worldgen.js. */
        this.fields = [];

        /**
         * Incursion state, owned by sim/incursion.js, plus the two
         * flags the rest of the simulation reads.
         *
         * `truce` is consulted by `isHostile` and therefore by every
         * targeting decision in the project — it lives on the world
         * rather than in a module so two worlds in one process cannot
         * share it.
         */
        this.incursion = null;
        this.truce = false;

        // No-fire bubbles, as {x, y, r}. Filled by worldgen and then
        // constant — the exchange cannot move, so rebuilding this per
        // step would be work to reach the same answer. Read by
        // `inSanctuary`, which sits inside the broadphase callback in
        // `pickTarget` and is therefore on the hottest path there is.
        this.sanctuaries = [];
        this.lastAlienAt = -1e9;

        /**
         * The conservation ledger, described in full in
         * sim/economy.js. `oreLost` is ore that was in a cargo hold
         * when its ship was destroyed — it leaves the world, and
         * pretending otherwise would make the books look balanced
         * while hiding a real sink.
         */
        this.oreExtracted = 0;
        this.oreLost = 0;
        /**
         * Ore that entered the world as a trading premium at the
         * exchange. A third way in alongside mining and salvage, and
         * declared here so the conservation test can account for it —
         * see `tradeAtHub` in sim/economy.js.
         */
        this.tradedTotal = 0;

        /** Trapped simulation and behaviour errors. */
        this.errors = [];

        this.events = new EventBus();

        // ----- entities -------------------------------------
        // Flat arrays, compacted in place. Dead entities are
        // flagged during the step and swept once at the end, so
        // nothing is ever removed while it is being iterated.
        /** @type {object[]} */ this.ships = [];
        /** @type {object[]} */ this.asteroids = [];
        /** @type {object[]} */ this.projectiles = [];
        /** @type {object[]} */ this.particles = [];
        /** @type {object[]} */ this.factions = [];

        /** id → ship. Behaviours hold ids, never object references. */
        this.byId = new Map();

        // ----- broadphase -----------------------------------
        // Two grids: ships move every step and rebuild every step;
        // asteroids are static and rebuild only when the set changes.
        this.shipGrid = new SpatialGrid(SPATIAL_CELL);
        this.rockGrid = new SpatialGrid(SPATIAL_CELL);
        this.rocksDirty = true;

        this._nextId = 1;
        this.resize(width, height);
    }

    /**
     * Ids are never reused. Behaviours store `targetId`, `parentId`
     * and so on rather than object references, so that a dead entity
     * resolves to `undefined` instead of silently keeping a corpse
     * alive through a dangling pointer.
     */
    nextId() {
        return this._nextId++;
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
        this.shipGrid.resize(width, height);
        this.rockGrid.resize(width, height);
        this.rocksDirty = true;
    }

    // --------------------------------------------------------
    // REGISTRATION
    // --------------------------------------------------------

    addShip(ship) {
        this.ships.push(ship);
        this.byId.set(ship.id, ship);
        return ship;
    }

    addAsteroid(a) {
        this.asteroids.push(a);
        this.byId.set(a.id, a);
        this.rocksDirty = true;
        return a;
    }

    addProjectile(p) {
        this.projectiles.push(p);
        return p;
    }

    addParticle(p) {
        this.particles.push(p);
        return p;
    }

    /**
     * Resolve an id to a live entity, or null.
     *
     * Ships and asteroids share one id space and one lookup, so a
     * behaviour holding `targetId` does not need to know which pool
     * the target came from. Dead entities resolve to null, which is
     * the whole reason behaviours store ids rather than references.
     */
    entity(id) {
        if (!id) return null;
        const e = this.byId.get(id);
        return e && !e.dead ? e : null;
    }

    /** As `entity`, narrowed to ships. */
    ship(id) {
        const e = this.entity(id);
        return e && e.def ? e : null;
    }

    /** As `entity`, narrowed to asteroids. */
    rock(id) {
        const e = this.entity(id);
        return e && e.shape ? e : null;
    }

    faction(id) {
        return this.factions[id];
    }

    // --------------------------------------------------------
    // MAINTENANCE
    // --------------------------------------------------------

    /**
     * Sweep flagged-dead entities out of every pool. Runs once at
     * the end of a step, after all behaviours have had their say.
     *
     * Swap-remove rather than splice: order in these arrays carries
     * no meaning, and swap-remove is O(1) per removal instead of
     * O(n).
     */
    compact() {
        const drop = (e) => this.byId.delete(e.id);
        // Any cargo still aboard a ship being removed is destroyed.
        // Accounted for here rather than at each kill site, so every
        // path that removes a ship — combat, an orphaned drone timing
        // out, anything added later — is covered by construction.
        this._sweep(this.ships, (s) => {
            if (s.cargo > 0) this.oreLost += s.cargo;
            drop(s);
        });
        const rocksBefore = this.asteroids.length;
        this._sweep(this.asteroids, drop);
        if (this.asteroids.length !== rocksBefore) this.rocksDirty = true;
        this._sweep(this.projectiles);
        this._sweep(this.particles);
    }

    _sweep(arr, onRemove) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!arr[i].dead) continue;
            if (onRemove) onRemove(arr[i]);
            arr[i] = arr[arr.length - 1];
            arr.pop();
        }
    }

    /** Rebuild broadphase. Ships every step; rocks only when the set changed. */
    refreshGrids() {
        this.shipGrid.rebuild(this.ships);
        if (this.rocksDirty) {
            this.rockGrid.rebuild(this.asteroids);
            this.rocksDirty = false;
        }
    }

    // --------------------------------------------------------
    // DETERMINISM
    // --------------------------------------------------------

    /**
     * A cheap order-independent-ish checksum of simulation state,
     * used by the determinism test: two runs from the same seed must
     * produce the same hash after the same number of steps.
     *
     * Positions are quantised to 1/16 of a world unit before hashing
     * so that the check is about *simulation* divergence rather than
     * about the last bit of a float. Anything that actually differs
     * moves far more than that within a few steps.
     */
    hash() {
        let h = 2166136261 >>> 0;
        const mix = (n) => {
            h ^= n | 0;
            h = Math.imul(h, 16777619) >>> 0;
        };
        mix(this.tick);
        mix(this.ships.length);
        mix(this.asteroids.length);
        mix(this.projectiles.length);
        for (let i = 0; i < this.factions.length; i++) mix(Math.round(this.factions[i].metal * 16));
        for (let i = 0; i < this.ships.length; i++) {
            const s = this.ships[i];
            mix(s.id);
            mix(Math.round(s.x * 16));
            mix(Math.round(s.y * 16));
            mix(Math.round(s.hp * 16));
        }
        for (let i = 0; i < this.asteroids.length; i++) {
            mix(Math.round(this.asteroids[i].ore * 16));
        }
        return h >>> 0;
    }
}
