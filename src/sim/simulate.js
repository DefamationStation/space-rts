// ============================================================
// SIMULATE — THE STEP
// ============================================================
//
// One fixed step, in a fixed order. The ordering below is the
// contract every other module in `sim/` is written against, so it
// is worth reading once carefully:
//
//   1  advance the clock
//   2  snapshot transforms      ← must happen before anything moves
//   3  rebuild broadphase
//   4  field bookkeeping
//   5  faction census
//   6  behaviours               ← decide; accumulate steering only
//   7  integrate motion         ← the only place position changes
//      (telemetry brackets step 7 when it is switched on)
//   8  rebuild broadphase again
//   9  projectiles              ← move and resolve hits
//  10  effects
//  11  fades
//  12  sweep the dead
//
// Steps 6 and 7 are split on purpose: every behaviour sees the same
// world, so no ship gets an advantage from its position in the
// array. Nothing here depends on iteration order, and that is what
// makes the run reproducible from a seed.
//
// This module and everything it imports are free of browser APIs,
// so the whole simulation runs under `node --test` unchanged.

import { World } from '../core/world.js';
import { EV } from '../core/events.js';
import { BEHAVIORS } from './behaviors/index.js';
import { applyMotion } from './steering.js';
import { stepProjectiles } from './combat.js';
import { stepTurrets } from './turrets.js';
import { stepEffects, attachEffects } from './effects.js';
import { generateWorld, updateFields, updateFactionRespawn } from './worldgen.js';
import { isHostile } from './behaviors/common.js';
import { payUpkeep } from './economy.js';
import { updatePostures } from './posture.js';
import { makeIncursion, stepIncursion } from './incursion.js';
import {
    WORLD_WIDTH, WORLD_HEIGHT, MUSTER_MAX, MUSTER_DEFICIT_SHARE, UPKEEP_PER_COST,
    CATCHUP_DELAY, CATCHUP_EXIT, LEAN_RUNWAY,
} from '../core/constants.js';
import { telemetry } from '../core/telemetry.js';
import { THREAT_MEMORY } from '../data/production.js';
import { isPlayed } from '../data/factions.js';

/** Seconds for a newly built hull to fade in. */
const SPAWN_FADE = 0.35;

/**
 * Build a populated world ready to step.
 *
 * `effects: false` skips the cosmetic particle subscriptions —
 * used by tests, which care about the economy and not about
 * sparks.
 */
export function createWorld({ seed = 1, width = WORLD_WIDTH, height = WORLD_HEIGHT, effects = true } = {}) {
    const world = new World({ seed, width, height });
    // Wired unconditionally. The recorder may be switched on long
    // after a world exists, and a subscription made at that point has
    // already missed everything it was switched on to see; the
    // handlers read one boolean while it is off.
    telemetry.attach(world);
    if (effects) attachEffects(world);
    generateWorld(world);
    world.incursion = makeIncursion(world);
    return world;
}

export function stepWorld(world, dt) {
    const t0 = telemetry.enabled && typeof performance !== 'undefined' ? performance.now() : 0;

    world.time += dt;
    world.tick++;

    // Hands the recorder this step's world before anything decides
    // anything: `setState` logs transitions and has no world of its
    // own, and the scalar series and invariant scan want a state
    // nothing has touched yet.
    if (telemetry.enabled) telemetry.begin(world);

    snapshot(world);
    world.refreshGrids();

    updateFields(world, dt);
    updateFactionRespawn(world, dt);
    // Before the census, because the truce it sets decides who counts
    // as hostile for the rest of the step.
    stepIncursion(world, dt);
    census(world);

    // Charged after the census, which is where the bill is totalled,
    // and before the behaviours, so a station deciding what to build
    // this step is looking at a treasury that has already paid its
    // wages.
    for (let i = 0; i < world.factions.length; i++) {
        const f = world.factions[i];
        // A mobilised faction pays no wages. It has nothing to pay
        // them with, and charging a destitute yard for the fleet it
        // does not have is the clearest way to keep it destitute.
        if (f.upkeep > 0 && !f.mobilised) payUpkeep(f, f.upkeep * dt);
    }

    const ships = world.ships;
    for (let i = 0; i < ships.length; i++) {
        const ship = ships[i];
        if (ship.dead || ship.quarantined) continue;
        const behave = BEHAVIORS[ship.role];
        if (behave) {
            try {
                behave(ship, world, dt);
            } catch (err) {
                quarantineShip(world, ship, err);
            }
        }
    }

    // Guns, after the behaviours and before anything moves.
    //
    // A hull's state machine has just decided where it is going; its
    // mounts now decide what they are shooting, and the two never
    // consult each other. That is the whole idea — a frigate holding
    // course while its broadside tracks something across the sky is a
    // ship whose guns are not steering it.
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (!s.dead && !s.quarantined && s.mounts.length) stepTurrets(world, s, dt);
    }

    // Steering requests exist only between here and applyMotion, so
    // the flight recorder has to catch them on the way past.
    if (telemetry.enabled) telemetry.intent(world);

    for (let i = 0; i < ships.length; i++) {
        if (!ships[i].dead && !ships[i].quarantined) applyMotion(ships[i], dt);
    }

    if (telemetry.enabled) telemetry.motionStep(world);

    // Rebuild before collision. Ships have moved since the first
    // rebuild, and a round travelling ten world units per step
    // deserves a broadphase that matches where hulls actually are —
    // the alternative is relying on query slack, which works today
    // and silently breaks the first time a speed is tuned up.
    world.refreshGrids();
    stepProjectiles(world, dt);

    stepEffects(world, dt);
    fades(world, dt);

    world.compact();

    if (telemetry.enabled && typeof performance !== 'undefined') {
        const duration = performance.now() - t0;
        world.lastStepMs = duration;
        telemetry.recordStepDuration(duration);
    }
}

function quarantineShip(world, ship, err) {
    ship.quarantined = true;
    ship.quarantineError = err ? (err.message || String(err)) : 'unknown error';
    ship.state = 'quarantined';
    ship.stateTime = 0;

    // Neutralize steering requests & engine loads
    ship.ax = 0;
    ship.ay = 0;
    ship.throttle = 0;
    ship.rcsLat = 0;
    ship.rcsRetro = 0;
    ship.aimAngle = null;

    // Disengage active beams & transfers
    ship.beamTargetId = 0;
    ship.beamOn = 0;
    ship.transferId = 0;
    ship.transferOn = 0;

    // Record error in world log
    world.errors.push({
        id: ship.id,
        type: ship.type,
        role: ship.role,
        state: 'quarantined',
        tick: world.tick,
        t: world.time,
        error: ship.quarantineError,
    });

    // Announce fact via EventBus
    world.events.emit(EV.SHIP_ERROR, { ship, error: ship.quarantineError });
}

// ------------------------------------------------------------

/** Record where everything was, so the renderer can interpolate. */
function snapshot(world) {
    const ships = world.ships;
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        s.prevX = s.x;
        s.prevY = s.y;
        s.prevAngle = s.angle;
    }
}

/**
 * Per-faction population counts and per-miner drone counts, in one
 * pass. Both are read many times later in the step — by the
 * production policy and by every miner — and recomputing them at
 * each call site would be the simulation's hottest loop.
 */
function census(world) {
    const factions = world.factions;
    for (let i = 0; i < factions.length; i++) {
        // Zeroed in place rather than replaced. A fresh object per
        // faction per step is a small allocation sixty times a second
        // for the whole life of a run, and the key set is the ship
        // roster — it does not change while a world is alive.
        const counts = factions[i].counts;
        for (const type in counts) counts[type] = 0;
        factions[i].underThreat = world.time - factions[i].lastLossAt < THREAT_MEMORY;
    }

    const ships = world.ships;
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (s.dead) continue;
        s.droneCount = 0;
    }
    for (let i = 0; i < factions.length; i++) {
        factions[i].strength = 0;
        factions[i].upkeep = 0;
    }

    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (s.dead) continue;

        const f = factions[s.factionId];
        if (f) {
            f.counts[s.type] = (f.counts[s.type] || 0) + 1;
            // Armed and able to go somewhere. A station is armed and
            // is not a fleet; a drone can move and cannot fight.
            // Warships only, and upkeep is charged on exactly the same
            // predicate — so the thing that has a price is precisely
            // the thing `strength` measures.
            //
            // Taxing miners as well was the obvious reading of "each
            // hull costs metal to keep" and it broke the opening. A
            // faction starts on 70 metal and its first miner takes
            // about 110 s to deliver anything on this map; charging
            // upkeep on that miner drained the treasury to zero at
            // around 94 s, so nobody could afford a second one and no
            // faction ever built a warship at all. Three guards failed
            // with "no fighter ever existed", which is a pleasing way
            // to find out.
            //
            // It is also the right target. Upkeep exists to stop a
            // leader banking metal behind a population cap and to make
            // "a corvette or three fighters" a real question. Neither
            // has anything to do with the economy, and a faction that
            // has just lost its fleet should find rebuilding *easier*,
            // not harder.
            if (s.weapon && !s.def.immobile && s.def.cost > 0) {
                f.strength += s.def.cost;
                f.upkeep += s.def.cost * UPKEEP_PER_COST;
            }
        }

        if (s.role === 'drone' && s.parentId) {
            const parent = world.byId.get(s.parentId);
            if (parent && !parent.dead) parent.droneCount++;
        }
    }

    // Is this faction poor?
    //
    // Measured as wages against savings rather than as an absolute
    // number of metal, because "low on resources" means something
    // different to a fleet of four and a fleet of thirty. A faction
    // holding less than LEAN_RUNWAY seconds of its own upkeep is one
    // whose income is not keeping up with what it already owns — the
    // moment to build another miner and to put a guard on the ones it
    // has, rather than to add a hull it cannot pay for.
    //
    // A faction with no fleet at all has no wages and is not lean; it
    // is starting, or it has just been wiped, and `warFooting` below
    // owns that case.
    for (let i = 0; i < factions.length; i++) {
        const f = factions[i];
        f.lean = f.upkeep > 0 && f.metal < f.upkeep * LEAN_RUNWAY;
    }

    warFooting(world);
    fleetBalance(world);
    // Strategy last: it reads the strengths computed immediately
    // above, and every behaviour that consults it runs after the
    // census. So a faction's posture and the numbers that justify it
    // are always from the same step.
    updatePostures(world);
}

/**
 * Decide who is destitute enough to need help getting back up.
 *
 * Keyed on warships held rather than on metal or on losses, because
 * that is the state that actually cannot recover on its own: a
 * faction with no escorts loses every miner it builds, so it never
 * earns, so it never fields an escort. The subsidy breaks that loop
 * from the production side while the home field and the battery hold
 * the other end.
 */
function warFooting(world) {
    for (let i = 0; i < world.factions.length; i++) {
        const f = world.factions[i];
        if (!isPlayed(f)) continue;

        const warships = f.strength > 0;
        if (warships) {
            f.barrenSince = -1;
        } else if (f.barrenSince < 0) {
            f.barrenSince = world.time;
        }

        if (!f.mobilised) {
            f.mobilised = f.barrenSince >= 0
                && world.time - f.barrenSince >= CATCHUP_DELAY;
        } else {
            // Hysteresis: it takes nothing to start and a real fleet to
            // stop, so one hull built and immediately lost does not
            // take the subsidy with it.
            const hulls = countWarships(world, f.id);
            if (hulls >= CATCHUP_EXIT) f.mobilised = false;
        }
    }
}

function countWarships(world, factionId) {
    let n = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== factionId) continue;
        if ((s.weapon || s.mounts.length) && !s.def.immobile && s.def.cost > 0) n++;
    }
    return n;
}

/**
 * How outnumbered each faction is, and how big a wing that means.
 *
 * ------------------------------------------------------------
 * WHY A FACTION DECIDES THIS AND NOT A SHIP
 * ------------------------------------------------------------
 *
 * Because the problem being solved is a property of the fleet, not of
 * any hull in it.
 *
 * The simulation's central failure was that **reinforcement is serial
 * and destruction is parallel**. A rebuilding faction launches one
 * hull every 3.5 seconds into an intact enemy fleet of a dozen, and
 * they die one at a time. Measured across ten seeds: a fighter
 * launched while four or more hulls behind lived a median of 16.8 s
 * and died inside twenty seconds 59% of the time, against 86.4 s and
 * 13% for one launched while ahead. Nothing was wrong with the
 * fighter. It was arriving alone.
 *
 * So a hull cannot answer "should I go now" — it has no idea how many
 * of its siblings are standing next to it, and by the time it finds
 * out it is already dead. The faction can, once per step, for free.
 *
 * ------------------------------------------------------------
 * THE SHAPE OF THE RULE
 * ------------------------------------------------------------
 *
 * Zero when level or ahead: a faction that is not losing behaves
 * exactly as it did before this existed, which is why adding it
 * changes nothing about a healthy run. As the deficit opens the
 * required wing grows in proportion, and it is capped — a faction
 * that is hopelessly behind must still eventually commit something,
 * because a wing that waits for a fleet it will never afford is just
 * a more elaborate way of doing nothing.
 */
function fleetBalance(world) {
    const factions = world.factions;
    for (let i = 0; i < factions.length; i++) {
        const f = factions[i];

        let hostile = 0;
        for (let j = 0; j < factions.length; j++) {
            if (isHostile(world, f.id, factions[j].id)) hostile += factions[j].strength;
        }
        f.hostileStrength = hostile;

        const deficit = hostile - f.strength;
        f.musterNeed = deficit <= 0
            ? 0
            : Math.min(MUSTER_MAX, deficit * MUSTER_DEFICIT_SHARE);
    }
}

/** Spawn fade-in. Ships fading *out* manage their own alpha. */
function fades(world, dt) {
    const ships = world.ships;
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        // Hit flashes cool fast — long enough to see, short enough
        // that a hull under sustained fire glows rather than strobes.
        if (s.hitFlash > 0) s.hitFlash = Math.max(0, s.hitFlash - dt * 5.5);
        if (s.dead || s.fadeOut || s.fade >= 1) continue;
        s.fade = Math.min(1, s.fade + dt / SPAWN_FADE);
    }
}
