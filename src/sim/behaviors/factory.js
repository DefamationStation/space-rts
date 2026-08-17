// ============================================================
// BEHAVIOUR — FACTORY
// ============================================================
//
//   IDLE ⇄ BUILDING
//
// The yard. A second place a faction can build, and the only place a
// destroyer can come from.
//
// ------------------------------------------------------------
// WHY THE HEAVY HULL LIVES BEHIND A BUILDING
// ------------------------------------------------------------
//
// A destroyer could have been one more row in PRODUCTION_POLICY with
// a high price and a posture gate, like the corvette and the frigate
// before it. Every hull so far has been exactly that, and the list is
// running out of ways for a new class to be interesting: the only
// thing a row can say is "and also build these, when".
//
// A precondition says something a price cannot. To field destroyers a
// faction has to stop building warships long enough to pay for a yard
// it cannot fight with, plant it, and keep it standing — and because
// it is a structure with hit points, an enemy can take that decision
// away again. "They have a yard" and "they had a yard" are different
// strategic facts, and neither is expressible as a number in a table.
//
// The build machinery itself is shared rather than copied. `sim/yard.js`
// owns the affordability rule — the upkeep runway, the catch-up
// subsidy, blocking-rule semantics — because those are subtle enough
// that a second copy would drift within a session and the drift would
// be silent. This file supplies a different policy and nothing else.

import { setState } from './common.js';
import { makeShip } from '../entities.js';
import { spendMetal } from '../economy.js';
import { chooseBuild, reasonMaps } from '../yard.js';
import { EV } from '../../core/events.js';
import { SHIP_TYPES } from '../../data/ships.js';
import { FACTORY_POLICY } from '../../data/production.js';
import { FACTORY, SPAWNED } from './states.js';
import {
    BUILD_ARC_FADE, LAUNCH_SPEED, CATCHUP_COST, CATCHUP_BUILD,
} from '../../core/constants.js';

const { IDLE, BUILDING } = FACTORY;

/** Reason strings, built once. See `reasonMaps`. */
const REASONS = reasonMaps(FACTORY_POLICY);
const STARTED = new Map(Object.keys(SHIP_TYPES).map((t) => [t, 'started-' + t]));
const LAUNCHED = new Map(Object.keys(SHIP_TYPES).map((t) => [t, 'launched-' + t]));

export function factoryBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, IDLE, SPAWNED);
    ship.stateTime += dt;

    const faction = world.faction(ship.factionId);
    if (!faction) return;

    // Let a finished build's arc fade out before it is cleared, the
    // same as a station's.
    if (!ship.buildType && ship.buildDoneAt >= 0
        && world.time - ship.buildDoneAt > BUILD_ARC_FADE) {
        ship.buildDoneAt = -1;
    }

    if (ship.buildType) {
        if (world.time >= ship.buildEnd) launch(world, ship);
        return;
    }

    const choice = chooseBuild(faction, world, FACTORY_POLICY, REASONS.saving, REASONS.cannot);
    if (!choice.type) {
        // On change only — a yard can sit blocked for minutes, and a
        // per-step announcement would allocate in a hot loop to report
        // a fact that has not moved.
        if (ship.buildBlocked !== choice.blocked) {
            ship.buildBlocked = choice.blocked;
            world.events.emit(EV.BUILD_BLOCKED, { ship, reason: choice.blocked });
        }
        return;
    }

    const def = SHIP_TYPES[choice.type];
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

/**
 * Release a finished hull.
 *
 * Outward, toward the middle of the map, for the same reason a
 * station launches inward: a new hull should read as heading
 * somewhere from its first frame rather than sitting on the slipway.
 */
function launch(world, ship) {
    const type = ship.buildType;
    ship.buildType = null;
    ship.buildDoneAt = world.time;
    setState(ship, IDLE, LAUNCHED.get(type));

    const inward = Math.atan2(world.height * 0.5 - ship.y, world.width * 0.5 - ship.x);
    const angle = inward + world.rng.spread(0.7);
    const r = ship.radius + 20;

    const born = makeShip(world, type, ship.factionId, ship.x + Math.cos(angle) * r,
        ship.y + Math.sin(angle) * r, angle);
    born.vx = Math.cos(angle) * LAUNCH_SPEED;
    born.vy = Math.sin(angle) * LAUNCH_SPEED;
    // Homed on the *station*, not on the yard. A yard cannot repair
    // anything and has no rally point, so a destroyer that treated it
    // as home would retreat to a building that cannot help it.
    const faction = world.faction(ship.factionId);
    born.homeId = faction.motherships[0] || ship.id;

    world.addShip(born);
    faction.builtTotal++;
    world.events.emit(EV.SHIP_SPAWNED, { ship: born });
}
