// ============================================================
// BEHAVIOUR — MOTHERSHIP
// ============================================================
//
// Static. Its entire agency is deciding what to build next, which
// it does by walking the ordered rules in `data/production.js`
// rather than by any logic of its own. Changing what a faction
// values is a data edit, not a code edit.

import { setState, pickTarget } from './common.js';
import { makeShip } from '../entities.js';
import { spendMetal } from '../economy.js';
import { tryFire } from '../combat.js';
import { dist, interceptPoint } from '../../core/math.js';
import { PRODUCTION_POLICY } from '../../data/production.js';
import { chooseBuild } from '../yard.js';
import { outpostSite } from '../outposts.js';
import { SHIP_TYPES } from '../../data/ships.js';
import { EV } from '../../core/events.js';
import { MOTHERSHIP, SPAWNED } from './states.js';
import {
    LAUNCH_SPEED, BUILD_ARC_FADE, MOTHERSHIP_TRICKLE,
    MOTHERSHIP_REPAIR, MOTHERSHIP_REPAIR_DELAY, BATTERY_RETARGET,
    CATCHUP_COST, CATCHUP_BUILD, FACTORY_OFFSET,
} from '../../core/constants.js';

const { IDLE, BUILDING } = MOTHERSHIP;

/** Radians per second of cosmetic ring rotation. Slow on purpose. */
const SPIN_RATE = 0.06;

/**
 * The strings a build decision can carry, built once per policy rule.
 *
 * `'saving-for-' + rule.type` looks harmless and is evaluated on every
 * step a station is not building — which is two thirds of a run, per
 * station, sixty times a second, for a fact that changes a handful of
 * times in ten minutes. `core/events.js` states the rule for the
 * *announcement*; this is the same rule applied to the reason it
 * announces.
 */
const SAVING_FOR = new Map(PRODUCTION_POLICY.map((r) => [r.type, 'saving-for-' + r.type]));
const CANNOT_AFFORD = new Map(PRODUCTION_POLICY.map((r) => [r.type, 'cannot-afford-' + r.type]));
const STARTED = new Map(Object.keys(SHIP_TYPES).map((t) => [t, 'started-' + t]));
const LAUNCHED = new Map(Object.keys(SHIP_TYPES).map((t) => [t, 'launched-' + t]));

export function mothershipBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, IDLE, SPAWNED);
    ship.stateTime += dt;
    ship.spin += SPIN_RATE * dt;

    const faction = world.faction(ship.factionId);
    if (!faction) return;

    // Salvage trickle. See the note on MOTHERSHIP_TRICKLE — this is
    // a floor under a collapsed economy, not an income stream.
    // Tracked separately so the conservation ledger still closes.
    const salvage = MOTHERSHIP_TRICKLE * dt;
    faction.metal += salvage;
    faction.salvageTotal += salvage;

    // Structural repair, but only once the shooting has stopped for
    // a while. A raid that breaks off achieves nothing lasting; only
    // sustained pressure actually threatens a station.
    if (ship.hp < ship.maxHp && world.time - ship.lastHitAt > MOTHERSHIP_REPAIR_DELAY) {
        ship.hp = Math.min(ship.maxHp, ship.hp + MOTHERSHIP_REPAIR * dt);
    }

    // Let a finished build's arc fade out before it is cleared.
    if (!ship.buildType && ship.buildDoneAt >= 0
        && world.time - ship.buildDoneAt > BUILD_ARC_FADE) {
        ship.buildDoneAt = -1;
    }

    defend(ship, world);

    if (ship.buildType) {
        if (world.time >= ship.buildEnd) launch(world, ship);
        return;
    }

    const choice = chooseBuild(faction, world, PRODUCTION_POLICY, SAVING_FOR, CANNOT_AFFORD);
    if (!choice.type) {
        // On change only. A station can sit blocked for minutes and a
        // per-step announcement would be a hot-loop allocation for a
        // fact that has not moved.
        if (ship.buildBlocked !== choice.blocked) {
            ship.buildBlocked = choice.blocked;
            world.events.emit(EV.BUILD_BLOCKED, { ship, reason: choice.blocked });
        }
        return;
    }

    const def = SHIP_TYPES[choice.type];
    // The subsidy, applied at the two places it can be: the price and
    // the time in the bay. Nothing is ever given away — a mobilised
    // faction still has to mine what it spends and survive what it
    // builds. It just does both faster than the fleet that is killing
    // it can keep up with.
    const price = def.cost * (faction.mobilised ? CATCHUP_COST : 1);
    const build = def.buildMs * (faction.mobilised ? CATCHUP_BUILD : 1);
    if (!spendMetal(faction, price)) return;

    ship.buildBlocked = '';
    ship.buildType = choice.type;
    ship.buildStart = world.time;
    ship.buildEnd = world.time + build / 1000;
    setState(ship, BUILDING, STARTED.get(choice.type));
    world.events.emit(EV.BUILD_STARTED, { ship, type: choice.type });
}

/** Scratch for the intercept solve — reused, never allocated per call. */
const _lead = { x: 0, y: 0 };

/**
 * Point defence.
 *
 * A station's turret ring bears on every direction at once, so
 * unlike a fighter there is no firing cone to satisfy and no need
 * to turn — it simply leads its target and fires. The hull's own
 * `angle` is left alone; it is a building, and rotating it to face
 * a threat would look like it was tipping over.
 */
function defend(ship, world) {
    if (!ship.weapon) return;

    const target = world.ship(ship.targetId);
    if (!target || world.time >= ship.retargetAt
        || dist(ship.x, ship.y, target.x, target.y) > ship.weapon.range) {
        ship.retargetAt = world.time + BATTERY_RETARGET;
        const found = pickTarget(world, ship, ship.weapon.range,
            ship.x, ship.y, ship.weapon.range);
        ship.targetId = found ? found.id : 0;
    }

    const locked = world.ship(ship.targetId);
    if (!locked) return;
    if (dist(ship.x, ship.y, locked.x, locked.y) > ship.weapon.range) return;

    interceptPoint(ship.x, ship.y, locked.x, locked.y,
        locked.vx, locked.vy, ship.weapon.speed, _lead);
    tryFire(world, ship, Math.atan2(_lead.y - ship.y, _lead.x - ship.x));
}


/**
 * Release a finished hull from a bay.
 *
 * It launches inward — toward the middle of the map rather than in
 * a random direction — so new ships immediately read as heading
 * somewhere, and never spend their first seconds pressed against
 * the wall behind their own station.
 */
function launch(world, ship) {
    const type = ship.buildType;
    ship.buildType = null;
    ship.buildDoneAt = world.time;
    // Back to idle. Without this the station enters `building` on its
    // first hull and never leaves — a state machine with a dead end,
    // which cost nothing visually and made every state reading wrong:
    // `?debug=1` claimed the station had been building for the whole
    // run, and so did every occupancy figure the recorder produced.
    setState(ship, IDLE, LAUNCHED.get(type));

    const inward = Math.atan2(world.height * 0.5 - ship.y, world.width * 0.5 - ship.x);
    const angle = inward + world.rng.spread(0.9);
    const r = ship.radius + 16;

    // A structure is *placed*, not launched. It appears where it is
    // needed rather than next to the yard that paid for it — the yard
    // is not where a forward store is any use.
    const def = SHIP_TYPES[type];
    let bx = ship.x + Math.cos(angle) * r;
    let by = ship.y + Math.sin(angle) * r;
    if (def.immobile) {
        // Where a structure goes depends on what it is for. A shed
        // belongs out where the ore is; a yard belongs behind the
        // line, near the station it is defended by. Sending the
        // factory through `outpostSite` would have planted it on the
        // frontier, which is the one place a slow, lightly armed
        // building must not be.
        const site = type === 'factory'
            ? factorySite(world, ship)
            : outpostSite(world, world.faction(ship.factionId));
        if (!site) return;                    // nowhere useful; do not waste it
        bx = site.x;
        by = site.y;
    }

    const born = makeShip(world, type, ship.factionId, bx, by, angle);

    if (!def.immobile) {
        born.vx = Math.cos(angle) * LAUNCH_SPEED;
        born.vy = Math.sin(angle) * LAUNCH_SPEED;
    }
    born.homeId = ship.id;

    world.addShip(born);
    world.faction(ship.factionId).builtTotal++;
    world.events.emit(EV.SHIP_SPAWNED, { ship: born });
}

/**
 * Where a faction's yard goes: just inboard of its own station.
 *
 * Close enough to sit inside the station's battery cover and to be
 * on the way home for anything retreating, far enough out that the
 * two structures read as separate buildings rather than one blob.
 * Offset off the centreline so it does not sit in the corridor the
 * station's own traffic uses.
 */
function factorySite(world, station) {
    const inward = world.width * 0.5 - station.x;
    const dir = inward >= 0 ? 1 : -1;
    const side = station.y < world.height * 0.5 ? 1 : -1;
    return {
        x: station.x + dir * FACTORY_OFFSET,
        y: station.y + side * FACTORY_OFFSET * 0.55,
    };
}
