// ============================================================
// BEHAVIOUR — DRONE
// ============================================================
//
//   TO_ROCK ──▸ MINE ──▸ TO_PARENT ──▸ UNLOAD ──┐
//      ▲                                    │    │
//      │                                    ▼    │
//      └────────────────── STOWED ◂─────────┘    │
//      └─────────────────────────────────────────┘
//
// STOWED is the drone riding along in its berth with nothing to do —
// the miner's hold is full, or it is hauling, fleeing or looking for
// a new field. There is nothing to transfer into and nowhere to fly,
// and that is a *state*, not a stalled UNLOAD. It was the latter for
// a while, which is why drones showed up spending forty-five percent
// of a run "unloading" with single visits over a minute long.
//
// The smallest, cheapest, most numerous thing in the simulation,
// and the one doing the actual work. A drone never strays outside
// MINING_RADIUS of its parent miner — that tether is what makes a
// miner a *place* rather than a dot, and it is why moving a miner
// means moving an operation.
//
// Drones are also the project's only permitted busy motion. A
// swarm of small quick things orbiting one slow heavy thing is
// what makes the slow heavy thing read as heavy; everything else
// on screen is calm precisely so this can be lively.

import { setState, gate, berth } from './common.js';
import { arrive, separate, avoidEdges, wander } from '../steering.js';
import { mineRock, unloadToMiner } from '../economy.js';
import { asteroidRadius } from '../entities.js';
import { dist } from '../../core/math.js';
import { DRONE, SPAWNED } from './states.js';
import { minerIsWorking } from './miner.js';
import {
    MINING_RADIUS, DRONE_UNLOAD_RATE, CARGO_EPSILON,
    DRONE_DOCK_OFFSET, DRONE_DOCK_TOLERANCE, DRONE_REHOME_RADIUS,
} from '../../core/constants.js';

const { TO_ROCK, MINE, TO_PARENT, UNLOAD, STOWED, ORPHAN } = DRONE;

/** True while this drone is away from its berth doing a shift. */
export function droneIsOut(drone) {
    return drone.state === TO_ROCK || drone.state === MINE;
}

/**
 * Is there any point in going back out?
 *
 * The condition every drone state asks before it does anything: a
 * parent that has moved on, or filled up, has no use for another
 * load. It was written out longhand in four places, which is four
 * places to miss when the answer changes — and the answer *will*
 * change, because "when may a drone leave its berth" is exactly the
 * knob a second mining class or a tug would want to turn.
 *
 * It asks the miner's own module whether it is working rather than
 * comparing against the string `'work'`, so a renamed state is a
 * broken import instead of a silently idle workforce.
 */
function canWorkFor(parent) {
    return minerIsWorking(parent) && parent.cargo < parent.cargoMax - CARGO_EPSILON;
}

/**
 * May this drone leave its berth?
 *
 * Two questions, and for a long time only the first was asked before
 * launching: does my parent want more ore (`canWorkFor`), and is
 * there actually any ore within reach to get. The second was checked
 * only on *arrival*, by `toRock`, which is far too late — a drone
 * that launched into an empty field discovered it 0.02 s later and
 * turned straight round.
 *
 * The result was a half-second loop that never terminated:
 *
 *     unload → to_rock → (no rock) → to_parent → dock → unload → ...
 *
 * Measured over fifteen minutes on one seed, 1,961 of 2,475 launches
 * — 79% — bounced back without reaching a rock, against 514 that
 * made it. From outside it looks exactly like what it is: drones
 * flickering between two states, and a miner that will not leave
 * because `allDronesDocked` keeps sampling them mid-flight.
 *
 * Asking both questions in one place, before the hull moves, is the
 * whole fix. A drone with nowhere to go now stows and waits, which is
 * what STOWED has always been for.
 */
function mayLaunch(ship, world, parent) {
    return canWorkFor(parent) && !!findRock(ship, world, parent);
}

export function droneBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, TO_ROCK, SPAWNED);
    ship.stateTime += dt;

    separate(ship, world);
    avoidEdges(ship, world);

    const parent = world.ship(ship.parentId);
    if (!parent) {
        orphaned(ship, world, dt);
        return;
    }

    // When the parent is full or en route (returning, depositing, seeking, fleeing),
    // drones must not wander off to mine rocks independently; they recall and dock.
    //
    // This is the *only* place the recall is decided. `toRock` and
    // `mine` each carried their own copy of the same check, which
    // could not fire — the state they would have transitioned out of
    // has already been changed by this block before the switch below
    // dispatches. The reason string they passed, `parent-busy`,
    // appeared zero times in a ten-minute trace. A guard that cannot
    // run is worse than no guard: it reads as the thing keeping the
    // invariant, so the next reader stops looking for what actually
    // does.
    if (!canWorkFor(parent) && droneIsOut(ship)) {
        ship.beamTargetId = 0;
        ship.beamOn = gate(ship.beamOn, false, dt, 7);
        setState(ship, TO_PARENT, 'recalled');
    }

    switch (ship.state) {
        case TO_ROCK: toRock(ship, world, parent, dt); break;
        case MINE: mine(ship, world, parent, dt); break;
        case TO_PARENT: toParent(ship, world, parent, dt); break;
        case UNLOAD: unload(ship, world, parent, dt); break;
        case STOWED: stowed(ship, world, parent, dt); break;
        // A drone in ORPHAN that has a live parent again — reachable
        // only if something outside this file re-parents it. It closes
        // on the berth first, like every other way back to a parent
        // does; sending it straight to a rock is the bug the note in
        // `orphaned` describes, and it should not be reintroduced by
        // the recovery path that exists to catch the case nobody
        // thought of.
        case ORPHAN: setState(ship, TO_PARENT, 'parent-restored'); break;
    }

    ship.beamOn = gate(ship.beamOn, ship.state === MINE, dt, 7);
}

// ------------------------------------------------------------

function toRock(ship, world, parent, dt) {
    let rock = world.rock(ship.beamTargetId);
    if (!workable(rock, parent)) rock = findRock(ship, world, parent);

    if (!rock) {
        // Nothing left in reach. Sit in berth with the parent and wait for it
        // to relocate — the miner's job is to fix this, not ours.
        ship.beamTargetId = 0;
        setState(ship, TO_PARENT, 'no-rock-in-reach');
        return;
    }

    ship.beamTargetId = rock.id;

    // Approach to just outside the rock's surface, not to its centre.
    const surface = asteroidRadius(rock) + ship.weapon.range * 0.55;
    const dx = ship.x - rock.x, dy = ship.y - rock.y;
    const d = Math.hypot(dx, dy) || 1;
    arrive(ship, rock.x + (dx / d) * surface, rock.y + (dy / d) * surface, 50);

    if (dist(ship.x, ship.y, rock.x, rock.y) < asteroidRadius(rock) + ship.weapon.range) {
        setState(ship, MINE, 'in-cutting-range');
    }
}

function mine(ship, world, parent, dt) {
    const rock = world.rock(ship.beamTargetId);
    if (!workable(rock, parent)) {
        setState(ship, TO_PARENT, 'rock-gone');
        return;
    }

    const reach = asteroidRadius(rock) + ship.weapon.range;
    if (dist(ship.x, ship.y, rock.x, rock.y) > reach) {
        setState(ship, TO_ROCK, 'drifted-out-of-reach');
        return;
    }

    // Hold station off the rock face while cutting.
    const dx = ship.x - rock.x, dy = ship.y - rock.y;
    const d = Math.hypot(dx, dy) || 1;
    const hold = asteroidRadius(rock) + ship.weapon.range * 0.55;
    arrive(ship, rock.x + (dx / d) * hold, rock.y + (dy / d) * hold, 40, 0.5);

    mineRock(world, ship, rock, dt);

    if (ship.cargo >= ship.cargoMax - CARGO_EPSILON || rock.ore <= 0) {
        setState(ship, TO_PARENT, rock.ore <= 0 ? 'rock-empty' : 'hold-full');
    }
}

function toParent(ship, world, parent, dt) {
    ship.beamTargetId = 0;

    const slot = berth(ship, parent, parent.radius + DRONE_DOCK_OFFSET);
    arrive(ship, slot.x, slot.y, 40, 1, parent.vx, parent.vy);

    // Only dock once within close tolerance of the assigned berth slot
    if (dist(ship.x, ship.y, slot.x, slot.y) <= DRONE_DOCK_TOLERANCE) {
        setState(ship, UNLOAD, 'docked');
    }
}

function unload(ship, world, parent, dt) {
    const slot = berth(ship, parent, parent.radius + DRONE_DOCK_OFFSET);
    arrive(ship, slot.x, slot.y, 30, 0.8, parent.vx, parent.vy);

    // Transfer cargo directly into miner hold while docked at berth
    if (ship.cargo > CARGO_EPSILON) {
        unloadToMiner(world, ship, parent, DRONE_UNLOAD_RATE, dt);
    } else {
        ship.cargo = 0;
    }

    // Empty, and there is somewhere to go: back out.
    if (ship.cargo <= CARGO_EPSILON && mayLaunch(ship, world, parent)) {
        setState(ship, TO_ROCK, 'unloaded');
        return;
    }

    // Otherwise stop calling it unloading. Either there is nothing to
    // transfer into — the hold is full, or the miner has stopped
    // working — or there is nothing out there worth the trip.
    if (!canWorkFor(parent)) {
        setState(ship, STOWED,
            parent.cargo >= parent.cargoMax - CARGO_EPSILON ? 'parent-hold-full' : 'parent-underway');
    } else if (ship.cargo <= CARGO_EPSILON) {
        setState(ship, STOWED, 'no-rock-in-reach');
    }
}

/**
 * Docked, and waiting for the miner to have work again.
 *
 * The drone holds its berth and rides along, which is what it was
 * doing before this state existed — the difference is that the state
 * machine now says so. A drone parked in `unload` for a whole round
 * trip is indistinguishable, from outside, from a drone that has
 * jammed, and telling those two apart is most of debugging.
 */
function stowed(ship, world, parent, dt) {
    const slot = berth(ship, parent, parent.radius + DRONE_DOCK_OFFSET);
    arrive(ship, slot.x, slot.y, 30, 0.8, parent.vx, parent.vy);

    // Laden drones always have somewhere to be — the hold in front of
    // them. An empty one only leaves if there is something to fetch.
    if (ship.cargo > CARGO_EPSILON) {
        if (canWorkFor(parent)) setState(ship, UNLOAD, 'parent-ready');
        return;
    }
    if (mayLaunch(ship, world, parent)) setState(ship, TO_ROCK, 'parent-ready');
}

/**
 * A drone whose miner died. It re-homes to the nearest friendly
 * miner if there is one, and otherwise coasts to a stop and fades
 * out — deliberately not an instant deletion, because a thing that
 * vanishes reads as a bug.
 */
function orphaned(ship, world, dt) {
    setState(ship, ORPHAN, 'parent-lost');
    ship.beamOn = gate(ship.beamOn, false, dt, 7);

    // Nearest miner within the usual reach, and failing that the
    // nearest one anywhere.
    //
    // The radius is a *preference*, not a gate, and making it a gate
    // was a bug that took two attempts to see. A drone is free to
    // build and free to keep, so a long flight home costs its faction
    // nothing and gains it a worker; fading out instead is pure loss.
    // Worse, it made ORPHAN a state whose only exit was death, which
    // `tests/sim.test.js` flags as a dead end — correctly, because a
    // state you can only leave by dying is not a state, it is an
    // ending. Widening the search only when the near one fails keeps
    // the common case cheap and the rare case survivable.
    let replacement = world.shipGrid.nearest(ship.x, ship.y, DRONE_REHOME_RADIUS, (other) =>
        !other.dead && other.role === 'miner' && other.factionId === ship.factionId);

    if (!replacement) {
        let bestD2 = Infinity;
        for (let i = 0; i < world.ships.length; i++) {
            const other = world.ships[i];
            if (other.dead || other.role !== 'miner' || other.factionId !== ship.factionId) continue;
            const d2 = (other.x - ship.x) ** 2 + (other.y - ship.y) ** 2;
            if (d2 < bestD2) { bestD2 = d2; replacement = other; }
        }
    }

    if (replacement) {
        ship.parentId = replacement.id;
        ship.fadeOut = false;
        // Always close on the new parent first, whatever is in the
        // hold. Sending an empty drone straight to TO_ROCK let it start
        // work from wherever the old miner died — up to the 520-unit
        // search radius away, on a tether of 250 — so it spent the
        // whole approach outside a limit the rest of the file treats
        // as inviolable. Every "drone off its tether" reading came
        // from here.
        setState(ship, TO_PARENT, 're-homed');
        return;
    }

    wander(ship, world, dt, 0.2);
    ship.fadeOut = true;
    ship.fade -= dt * 0.35;
    if (ship.fade <= 0) ship.dead = true;
}

// ------------------------------------------------------------

/** A rock is workable if it still has ore, is inside the tether, and the parent has room and is working. */
function workable(rock, parent) {
    return !!rock
        && rock.ore > 0
        && !rock.depleting
        && canWorkFor(parent)
        && dist(rock.x, rock.y, parent.x, parent.y) <= MINING_RADIUS;
}

/**
 * Nearest workable rock within the parent's radius.
 *
 * Searching from the *parent* rather than from the drone keeps the
 * tether honest: a drone cannot be lured outward rock by rock into
 * a chain that ends up across the map.
 */
function findRock(ship, world, parent) {
    let best = null;
    let bestD2 = Infinity;

    world.rockGrid.queryCircle(parent.x, parent.y, MINING_RADIUS, (rock) => {
        if (!workable(rock, parent)) return;
        const dx = rock.x - ship.x, dy = rock.y - ship.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = rock; }
    });

    return best;
}
