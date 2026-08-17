// ============================================================
// ENTITIES — FACTORIES
// ============================================================
//
// Flat objects, built once, mutated in place. No classes and no
// inheritance: a ship is a bag of fields and its *behaviour*
// comes from the registry keyed by `role`, not from its type.
// That is what lets a new hull class reuse an existing AI without
// touching `sim/`.
//
// Every field a ship will ever hold is declared here even when it
// only applies to one role — `metal` on a fighter is always 0.
// Uniform shape means V8 keeps a single hidden class for every
// ship in the world, which matters more at a few hundred entities
// than the handful of wasted bytes does.

import { SHIP_TYPES } from '../data/ships.js';
import { WEAPON_TYPES } from '../data/weapons.js';
import {
    ASTEROID_RADIUS_MIN, ASTEROID_RADIUS_MAX, ASTEROID_RADIUS_FLOOR,
    ASTEROID_ORE_MIN, ASTEROID_ORE_MAX,
    MAX_PARTICLES, MAX_PROJECTILES,
} from '../core/constants.js';
import { makeMounts } from './turrets.js';
import { lerp } from '../core/math.js';

// ------------------------------------------------------------
// SHIPS
// ------------------------------------------------------------

export function makeShip(world, typeId, factionId, x, y, angle = 0) {
    const def = SHIP_TYPES[typeId];
    if (!def) throw new Error('unknown ship type: ' + typeId);

    return {
        id: world.nextId(),
        type: typeId,
        def,
        role: def.role,
        factionId,

        // --- transform -------------------------------------
        x, y,
        vx: 0, vy: 0,
        ax: 0, ay: 0,            // steering accumulator, zeroed each step
        angle,

        // Previous-step transform. The renderer blends prev→current
        // so a 60 Hz simulation looks smooth on any display.
        prevX: x, prevY: y, prevAngle: angle,

        // --- condition -------------------------------------
        hp: def.hp,
        maxHp: def.hp,
        shield: 0,               // seam: no shields in v1, always 0
        lastHitAt: -1e9,         // world time of the last damage taken

        radius: def.radius,

        // --- behaviour -------------------------------------
        state: '',
        stateTime: 0,
        // Ids, never object references — a dead entity must resolve
        // to null rather than keep a corpse reachable.
        targetId: 0,
        parentId: 0,
        homeId: 0,
        claimId: -1,             // index into world.fields; -1 = unclaimed
        retargetAt: 0,           // world time the next target search is due
        escortId: 0,             // friendly ship this escort is shadowing
        escortAt: 0,
        // Which berth in the escort formation this hull holds, and how
        // many berths there are. Recomputed with `escortId`, not per
        // step: a slot that reshuffles every frame is not a formation,
        // it is a hull being told to be somewhere else sixty times a
        // second. -1 while this ship is escorting nothing.
        escortSlot: -1,
        escortSlots: 0,
        // Cached position of whatever this ship is guarding. Every
        // targeting and pursuit decision is bounded relative to it —
        // see ENGAGE_LEASH in core/constants.js.
        anchorX: x,
        anchorY: y,
        droneCount: 0,           // children alive, refreshed once per step
        lastLaunch: 0,
        threatCheckAt: 0,        // world time of the next hostile scan
        lastThreatAt: -1e9,      // world time an enemy was last seen nearby
        // Which way round this hull circles, and which side it slices
        // past a target on. Fighters pick both at spawn and flip
        // `passDir` between attack runs; nothing else reads them.
        orbitDir: 1,             // +1 / -1
        passDir: 1,              // +1 / -1
        // Whether this hull belongs to the strike detachment — the
        // half of a fleet that presses an advantage against the
        // enemy's miners while the other half stays on escort. Rolled
        // once at spawn rather than decided per step, so a squadron
        // has a stable composition instead of re-forming itself sixty
        // times a second.
        striker: false,
        /**
         * Standing duty: 'garrison' | 'escort' | 'striker'. Rolled once
         * at spawn and kept for life — see the note on GARRISON_SHARE.
         * Empty for anything that is not an armed mobile hull.
         */
        duty: '',
        /**
         * Which escort post this hull holds — 'close', 'picket' or
         * 'outrider'. Assigned with the formation slot, so a squadron
         * always has a spread of jobs rather than three copies of one.
         */
        post: '',
        /**
         * The wave a swarm hull arrived with. Its squadron for life —
         * see `squadLeader` in behaviors/fighter.js. Zero for natives,
         * who organise around miners instead.
         */
        squadId: 0,
        // Heading of the lazy drift in `wander`, carried between steps
        // so the drift is a slow curve rather than per-frame jitter.
        // null until the first wander seeds it from the world's rng.
        wanderAngle: null,       // rad, or null

        // --- economy ---------------------------------------
        cargo: 0,
        cargoMax: def.cargo,
        /**
         * How much premium this hull has already drawn on its current
         * load. Reset when it fills up again.
         *
         * Carried on the ship rather than worked out at the hub
         * because the trade is rate-limited over several steps, and
         * without a running total a hauler parked alongside would keep
         * earning the premium for as long as it sat there.
         */
        tradeGained: 0,

        // --- weapon ----------------------------------------
        weapon: def.weapon ? WEAPON_TYPES[def.weapon] : null,
        /**
         * Independently-aiming gun mounts, built from the hull class.
         * Empty for everything that fires along its nose. See
         * sim/turrets.js.
         */
        mounts: makeMounts(def),
        burstLeft: 0,
        nextShotAt: 0,           // world time the next round in a burst is due
        readyAt: 0,              // world time the weapon leaves cooldown
        beamTargetId: 0,         // asteroid currently being mined
        beamOn: 0,               // 0..1, eased so beams fade rather than blink

        // Cargo tether, shown while unloading. Behaviours set these;
        // the renderer draws them without needing to know which state
        // machine or which state produced them.
        transferId: 0,
        transferOn: 0,

        // --- production (mothership only) ------------------
        buildType: null,
        // Why nothing is being built, or '' when something is. Held
        // rather than recomputed because the condition is true for
        // minutes at a time and its *announcement* fires on change —
        // see the note in core/events.js. `?debug=1` prints it.
        buildBlocked: '',
        buildStart: 0,
        buildEnd: 0,
        buildDoneAt: -1,         // world time a finished arc should stop showing
        spin: 0,                 // cosmetic ring rotation

        // --- feel ------------------------------------------
        //
        // One field per engine, each holding the fraction of that
        // engine's budget actually spent last step. The renderer
        // draws exactly these, so a plume can never show thrust the
        // physics did not apply. See applyMotion in sim/steering.js.
        throttle: 0,             // 0..1  main drive, smoothed
        rcsLat: 0,               // -1..1 flank jets; sign is the push direction
        rcsRetro: 0,             // 0..1  retro pack at the nose
        bank: 0,                 // rad, visual roll into a turn
        // When set, the hull points here instead of along its
        // velocity — a ship holding its nose on a target while
        // strafing around it. Cleared to null to resume flying
        // nose-first. See applyMotion in sim/steering.js.
        aimAngle: null,
        recoil: 0,               // world units of firing kickback
        hitFlash: 0,             // 0..1 cosmetic flash, decays after a hit
        warpT: 0,                // 1..0 while a hull is shedding arrival speed
        fade: 0,                 // 0..1 spawn fade-in; nothing pops into being
        fadeOut: false,          // set by a behaviour that wants to fade away instead

        // --- error containment -----------------------------
        quarantined: false,
        quarantineError: '',

        // --- lifecycle -------------------------------------
        spawnAt: world.time,
        dead: false,
    };
}

// ------------------------------------------------------------
// ASTEROIDS
// ------------------------------------------------------------

/**
 * Rocks are irregular polygons generated once at creation and
 * stored as per-vertex radius multipliers. Drawing them from a
 * fixed shape rather than re-jittering each frame is what keeps
 * them looking like solid objects instead of boiling noise.
 */
export function makeAsteroid(world, x, y, ore = null) {
    const rng = world.rng;
    const amount = ore == null ? rng.range(ASTEROID_ORE_MIN, ASTEROID_ORE_MAX) : ore;

    const verts = rng.int(7, 10);
    const shape = new Float32Array(verts);
    for (let i = 0; i < verts; i++) shape[i] = rng.range(0.80, 1.16);

    return {
        id: world.nextId(),
        x, y,
        ore: amount,
        oreMax: amount,
        // Bigger rocks hold more, so size reads as value before you
        // have looked at a single number.
        radiusMax: lerp(
            ASTEROID_RADIUS_MIN, ASTEROID_RADIUS_MAX,
            (amount - ASTEROID_ORE_MIN) / (ASTEROID_ORE_MAX - ASTEROID_ORE_MIN),
        ),
        shape,
        angle: rng.angle(),
        spin: rng.spread(0.045),   // rad/s — barely perceptible, but not frozen
        fieldId: -1,
        fade: 0,                   // 0..1 in, and back down to 0 when depleted
        depleting: false,
        dead: false,
    };
}

/** Current radius, shrinking with remaining ore. */
export function asteroidRadius(a) {
    const t = a.oreMax > 0 ? a.ore / a.oreMax : 0;
    return a.radiusMax * lerp(ASTEROID_RADIUS_FLOOR, 1, t);
}

// ------------------------------------------------------------
// PROJECTILES
// ------------------------------------------------------------

export function makeProjectile(world, x, y, vx, vy, weapon, factionId, ownerId, targetId = 0) {
    // Hard cap. Under pressure we drop the oldest round rather than
    // dropping frames — a missing tracer is invisible, a stutter is not.
    if (world.projectiles.length >= MAX_PROJECTILES) {
        world.projectiles[0].dead = true;
    }
    return {
        id: world.nextId(),
        x, y,
        prevX: x, prevY: y,      // swept-collision segment for this step
        vx, vy,
        damage: weapon.damage,
        weapon,
        factionId,
        ownerId,
        /**
         * What a guided round is chasing. Zero for everything else —
         * a torpedo is deliberately dumb and a tracer has no opinion.
         */
        targetId,
        life: weapon.range / weapon.speed,
        maxLife: weapon.range / weapon.speed,
        dead: false,
    };
}

// ------------------------------------------------------------
// PARTICLES
// ------------------------------------------------------------
//
// One shape for every visual effect, discriminated by `kind`.
// A single pool means one cap, one sweep, and one draw pass
// instead of four of each.
//
//   spark   fast tiny streak from an impact
//   shard   a fragment of a dead hull, drifting and spinning
//   ring    an expanding outline: impact, or a death bloom
//   muzzle  the flash at a barrel

function pushParticle(world, p) {
    if (world.particles.length >= MAX_PARTICLES) world.particles[0].dead = true;
    world.particles.push(p);
    return p;
}

export function makeSpark(world, x, y, vx, vy, life, factionId) {
    return pushParticle(world, {
        kind: 'spark',
        x, y, prevX: x, prevY: y, vx, vy,
        life, maxLife: life,
        size: 1,
        angle: 0, spin: 0,
        factionId,
        shape: null,
        dead: false,
    });
}

export function makeShard(world, x, y, vx, vy, shape, angle, spin, life, factionId) {
    return pushParticle(world, {
        kind: 'shard',
        x, y, prevX: x, prevY: y, vx, vy,
        life, maxLife: life,
        size: 1,
        angle, spin,
        factionId,
        shape,
        dead: false,
    });
}

export function makeRing(world, x, y, size, life, factionId) {
    return pushParticle(world, {
        kind: 'ring',
        x, y, prevX: x, prevY: y, vx: 0, vy: 0,
        life, maxLife: life,
        size,
        angle: 0, spin: 0,
        factionId,
        shape: null,
        dead: false,
    });
}

export function makeMuzzle(world, x, y, angle, size, life, factionId) {
    return pushParticle(world, {
        kind: 'muzzle',
        x, y, prevX: x, prevY: y, vx: 0, vy: 0,
        life, maxLife: life,
        size,
        angle, spin: 0,
        factionId,
        shape: null,
        dead: false,
    });
}

/**
 * A small convex fragment for hull debris: a wedge of the original
 * silhouette, so shards read as pieces *of that ship* rather than
 * as generic confetti.
 */
export function makeShardShape(rng, radius) {
    const n = rng.int(3, 4);
    const pts = new Float32Array(n * 2);
    const start = rng.angle();
    const sweep = rng.range(0.7, 1.5);
    for (let i = 0; i < n; i++) {
        const a = start + (sweep * i) / (n - 1);
        const r = radius * rng.range(0.35, 0.85);
        pts[i * 2] = Math.cos(a) * r;
        pts[i * 2 + 1] = Math.sin(a) * r;
    }
    return pts;
}
