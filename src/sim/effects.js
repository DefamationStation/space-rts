// ============================================================
// EFFECTS — COSMETIC STATE
// ============================================================
//
// Particles are spawned from simulation *events* and stepped by
// the simulation clock, but they never feed anything back. No
// behaviour reads them, no collision consults them, and
// `world.hash()` ignores them entirely.
//
// Two consequences worth stating plainly, because they are the
// reason this file sits in `sim/` rather than in `render/`:
//
//   · Particles move on the fixed timestep like everything else,
//     so they interpolate correctly and never wobble.
//   · They draw from `world.fxRng`, a stream forked off the main
//     generator. Nothing here can shift the sequence the
//     simulation itself consumes, so a headless run and a
//     rendered run from the same seed stay identical.
//
// This module imports nothing from `render/`.

import {
    makeSpark, makeShard, makeRing, makeMuzzle, makeShardShape,
} from './entities.js';
import { EV } from '../core/events.js';
import { weaponHeft } from '../data/weapons.js';
import {
    SPARKS_PER_HIT, SPARK_LIFE_MIN, SPARK_LIFE_MAX, WARP_STREAK,
    SPARK_SPEED_MIN, SPARK_SPEED_MAX, SPARK_DRAG,
    DEBRIS_SHARDS_MIN, DEBRIS_SHARDS_MAX, DEBRIS_LIFE, DEBRIS_DRIFT, DEBRIS_SPIN,
    MUZZLE_LIFE, IMPACT_LIFE, IMPACT_RADIUS, SHOCKWAVE_RADIUS, SHOCKWAVE_LIFE,
    DEATH_RING_LIFE, DEATH_RING_RADIUS,
} from '../core/constants.js';

/**
 * Subscribe the effect spawners to the event bus. Called once when
 * a world is built; safe to skip entirely for headless runs.
 */

export function attachEffects(world) {
    // Muzzle bloom scales with the round leaving the barrel.
    //
    // Derived from damage rather than authored per weapon, so a gun
    // added tomorrow gets a flash proportional to its punch without
    // anyone remembering to set one. A pulse round sits near the old
    // fixed size; a lance shell blooms half again as large and
    // lingers, which is what makes a broadside land as an event.
    world.events.on(EV.SHOT_FIRED, (e) => {
        const heft = weaponHeft(e.weapon);
        makeMuzzle(world, e.x, e.y, e.angle, 3.4 * heft, MUZZLE_LIFE * heft, e.faction);
    });

    world.events.on(EV.SHOT_HIT, (e) => spawnImpact(world, e.x, e.y, e.angle, e.faction, e.weapon));

    world.events.on(EV.SHIP_DIED, (e) => spawnWreck(world, e.ship));

    // A hull dropping out of warp: one hard flash at the drop point,
    // a ring, and a spray of motes thrown *backward* along its track.
    //
    // Backward is the whole trick. Sparks thrown forward read as an
    // explosion the ship is flying out of; thrown behind, they read as
    // the wake of something that has just shed an enormous amount of
    // speed — which is exactly what happened.
    world.events.on(EV.WARP_IN, (e) => {
        makeMuzzle(world, e.x, e.y, e.angle, 13, WARP_STREAK * 0.5, e.ship.factionId);
        makeRing(world, e.x, e.y, IMPACT_RADIUS * 3.4, WARP_STREAK, e.ship.factionId);

        const rng = world.fxRng;
        for (let i = 0; i < 9; i++) {
            const a = e.angle + Math.PI + rng.spread(0.7);
            const v = rng.range(SPARK_SPEED_MIN, SPARK_SPEED_MAX * 1.8);
            makeSpark(world, e.x, e.y,
                Math.cos(a) * v + e.ship.vx * 0.35,
                Math.sin(a) * v + e.ship.vy * 0.35,
                rng.range(SPARK_LIFE_MIN, SPARK_LIFE_MAX * 1.7), e.ship.factionId);
        }
    });
}

/**
 * An impact: one expanding ring plus a small spray of sparks.
 *
 * The sparks are biased backward along the round's travel, so a hit
 * throws material back the way the shot came from. Getting that
 * direction right is most of why a hit reads as an impact rather
 * than as a firework.
 */
export function spawnImpact(world, x, y, angle, factionId, weapon = null) {
    const rng = world.fxRng;
    const heft = weaponHeft(weapon);
    makeRing(world, x, y, IMPACT_RADIUS * heft, IMPACT_LIFE * heft, factionId);

    // A second ring for capital ordnance: wider, slower, and behind
    // the first.
    //
    // `weaponHeft` already scales the flash, the ring and the spark
    // count with damage, so a lance shell was a bigger pulse round and
    // a torpedo was a bigger lance shell — the same event at three
    // volumes. Volume is not the difference. What separates a capital
    // hit is that the *shape* of it outlives the flash: the impact
    // flares, and then a shockwave keeps going after the sparks have
    // gone out.
    //
    // Gated on `heavy` rather than on damage, so it stays a statement
    // about weapon class made in one place — the same flag the retreat
    // guard in tests/guards.test.js already reads.
    if (weapon && weapon.heavy) {
        makeRing(world, x, y,
            IMPACT_RADIUS * heft * SHOCKWAVE_RADIUS,
            IMPACT_LIFE * heft * SHOCKWAVE_LIFE, factionId);
    }

    const sparks = Math.round(SPARKS_PER_HIT * heft);
    for (let i = 0; i < sparks; i++) {
        const a = angle + Math.PI + rng.spread(1.05);
        const speed = rng.range(SPARK_SPEED_MIN, SPARK_SPEED_MAX);
        makeSpark(world, x, y,
            Math.cos(a) * speed, Math.sin(a) * speed,
            rng.range(SPARK_LIFE_MIN, SPARK_LIFE_MAX), factionId);
    }
}

/**
 * A death: the hull fractures.
 *
 * Explicitly *not* a fireball. A few polygon shards carrying the
 * ship's own momentum, drifting apart and spinning down, plus one
 * soft ring. Debris that inherits the victim's velocity is what
 * makes a kill read as a thing that broke rather than as a sprite
 * that was deleted.
 */
export function spawnWreck(world, ship) {
    const rng = world.fxRng;
    makeRing(world, ship.x, ship.y, ship.radius * DEATH_RING_RADIUS, DEATH_RING_LIFE, ship.factionId);

    const n = rng.int(DEBRIS_SHARDS_MIN, DEBRIS_SHARDS_MAX);
    for (let i = 0; i < n; i++) {
        const a = rng.angle();
        const drift = rng.range(DEBRIS_DRIFT * 0.4, DEBRIS_DRIFT);
        makeShard(world,
            ship.x, ship.y,
            ship.vx * 0.5 + Math.cos(a) * drift,
            ship.vy * 0.5 + Math.sin(a) * drift,
            makeShardShape(rng, ship.radius),
            rng.angle(),
            rng.spread(DEBRIS_SPIN),
            DEBRIS_LIFE * rng.range(0.75, 1.1),
            ship.factionId);
    }
}

/**
 * Advance every particle. Pure motion and ageing — nothing here
 * makes a decision.
 */
export function stepEffects(world, dt) {
    trailWakes(world, dt);

    const list = world.particles;
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.prevX = p.x;
        p.prevY = p.y;

        if (p.kind === 'spark') {
            // Sparks decelerate hard, so the spray blooms outward and
            // stops rather than drifting off across the map.
            const drag = Math.exp(-SPARK_DRAG * dt);
            p.vx *= drag;
            p.vy *= drag;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.spin) p.angle += p.spin * dt;

        p.life -= dt;
        if (p.life <= 0) p.dead = true;
    }
}

/**
 * Drop wake puffs behind rounds that carry a drive.
 *
 * Emitted from here rather than from the renderer because they are
 * world objects with a lifetime, not a drawing: they stay where they
 * were made while the round flies on, which is what makes the trail a
 * trail. Effects run from a forked RNG stream and are skipped
 * entirely in headless runs, so this cannot perturb the simulation —
 * see `attachEffects`.
 *
 * Timed off the round's own remaining life so the spacing is even in
 * *distance* regardless of frame rate, and so no per-projectile
 * bookkeeping field is needed.
 */
function trailWakes(world, dt) {
    const rounds = world.projectiles;
    for (let i = 0; i < rounds.length; i++) {
        const p = rounds[i];
        const gap = p.weapon.wake;
        if (!gap) continue;

        // Has the round crossed a wake interval this step?
        const was = Math.floor((p.life + dt) / gap);
        const now = Math.floor(p.life / gap);
        if (was === now) continue;

        const back = (p.weapon.tracerLength || 20) * 0.45;
        const heading = Math.atan2(p.vy, p.vx);
        makeRing(world,
            p.x - Math.cos(heading) * back,
            p.y - Math.sin(heading) * back,
            WAKE_SIZE, WAKE_LIFE, p.factionId);
    }
}

/** How big a wake puff starts, and how long it hangs about. */
const WAKE_SIZE = 5.5;
const WAKE_LIFE = 1.35;
