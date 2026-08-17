// ============================================================
// BEHAVIOUR — HAULER
// ============================================================
//
//   IDLE ──▸ TO_OUTPOST ──▸ LOAD ──▸ TO_BASE ──▸ DELIVER ──┐
//    ▲                                                      │
//    └──────────────────────────────────────────────────────┘
//
// The other half of the outpost. A miner drops its hold at the shed
// and goes straight back to work; a hauler makes the long journey
// home once, in bulk, with something built for it.
//
// ------------------------------------------------------------
// WHY THIS IS WORTH HAVING AS A SHIP RATHER THAN A NUMBER
// ------------------------------------------------------------
//
// The economic effect could have been a trickle — ore in an outpost
// slowly becoming metal at home, no hull required. It is a ship
// because the *route* is the point: a fixed, predictable, repeating
// line of traffic between two places a faction cares about, running
// whether or not anyone is fighting.
//
// That is most of what "alive" means here. Before this the only
// things crossing open space were warships going to kill something,
// so the map was either violent or empty. A freighter plodding home
// with six hundred ore is neither, and it is also the most valuable
// thing either side ever puts on the board — which makes escorting it
// a real job and raiding it a real prize.
//
// Two sizes, and the choice between them is a small standing
// decision: the light hauler is sent when a shed has a moderate
// amount waiting, the freighter when it has filled up. A faction
// should not scramble its heavy for two hundred ore.

import { setState, homeOf, gate } from './common.js';
import { arrive, separate, avoidEdges, wander } from '../steering.js';
import { depositToBase, tradeAtHub } from '../economy.js';
import { dist } from '../../core/math.js';
import { HAULER, SPAWNED } from './states.js';
import {
    MINER_DOCK_RANGE, MINER_DEPOSIT_RATE, CARGO_EPSILON,
    HAULER_LOAD_RATE, HAULER_MIN_LOAD,
    TRADE_RATE, TRADE_MIN_FLOAT,
} from '../../core/constants.js';

const { IDLE, TO_OUTPOST, LOAD, TO_HUB, TRADE, TO_BASE, DELIVER } = HAULER;

export function haulerBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, IDLE, SPAWNED);
    ship.stateTime += dt;

    separate(ship, world);
    avoidEdges(ship, world);

    switch (ship.state) {
        case IDLE: idle(ship, world, dt); break;
        case TO_OUTPOST: toOutpost(ship, world, dt); break;
        case LOAD: load(ship, world, dt); break;
        case TO_HUB: toHub(ship, world, dt); break;
        case TRADE: trade(ship, world, dt); break;
        case TO_BASE: toBase(ship, world, dt); break;
        case DELIVER: deliver(ship, world, dt); break;
    }

    ship.transferOn = gate(ship.transferOn,
        ship.state === LOAD || ship.state === DELIVER
        || ship.state === TRADE, dt);
}

/**
 * Wait at home until a shed has enough to be worth the trip.
 *
 * Holding station rather than circling: a hauler with nothing to do
 * is a hauler parked at its station, which is what a real one would
 * be doing and reads as a lull rather than as a patrol.
 */
function idle(ship, world, dt) {
    const home = homeOf(world, ship);
    if (home) arrive(ship, home.x, home.y, 220, 0.5);
    else wander(ship, world, dt, 0.3);

    // Anything still aboard from a previous run goes home first.
    if (ship.cargo > CARGO_EPSILON) { setState(ship, TO_BASE, 'still-laden'); return; }

    const shed = bestShed(world, ship);
    if (shed) {
        ship.transferId = shed.id;
        setState(ship, TO_OUTPOST, 'pickup-called');
        return;
    }

    // No freight to move. If the market has anything worth crossing
    // for, go and get it — this is the errand that fills the 89% of
    // its life a hauler otherwise spends parked at its station.
    const hub = nearestHub(world, ship);
    if (hub && hub.cargo >= TRADE_MIN_FLOAT) {
        setState(ship, TO_HUB, 'caravan-called');
    }
}

/**
 * Which shed to run to.
 *
 * Nearest one holding enough to justify this hull's own capacity —
 * so a light hauler will happily fetch two hundred ore and a
 * freighter waits for a load worth its slower crossing. Both are the
 * same rule; the difference falls out of `cargoMax`.
 */
function bestShed(world, ship) {
    let best = null;
    let bestD2 = Infinity;
    const worth = Math.max(HAULER_MIN_LOAD, ship.cargoMax * 0.45);

    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'outpost' || s.factionId !== ship.factionId) continue;
        if (s.cargo < worth) continue;

        // Do not send two haulers for one load.
        let claimed = false;
        for (let j = 0; j < world.ships.length; j++) {
            const other = world.ships[j];
            if (other.dead || other.role !== 'hauler' || other.id === ship.id) continue;
            if (other.transferId === s.id && other.cargo < other.cargoMax - CARGO_EPSILON) {
                claimed = true;
                break;
            }
        }
        if (claimed) continue;

        const d2 = (s.x - ship.x) ** 2 + (s.y - ship.y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
}

function toOutpost(ship, world, dt) {
    const shed = world.ship(ship.transferId);
    // The shed was destroyed on the way, which is exactly the raid an
    // outpost exists to invite. Go home rather than to a coordinate.
    if (!shed) { setState(ship, ship.cargo > CARGO_EPSILON ? TO_BASE : IDLE, 'shed-lost'); return; }

    arrive(ship, shed.x, shed.y, 240);
    if (dist(ship.x, ship.y, shed.x, shed.y) < shed.radius + MINER_DOCK_RANGE) {
        setState(ship, LOAD, 'docked');
    }
}

function load(ship, world, dt) {
    const shed = world.ship(ship.transferId);
    if (!shed) { setState(ship, ship.cargo > CARGO_EPSILON ? TO_BASE : IDLE, 'shed-lost'); return; }

    arrive(ship, shed.x, shed.y, 60, 0.6);

    const room = ship.cargoMax - ship.cargo;
    const moved = Math.min(HAULER_LOAD_RATE * dt, room, shed.cargo);
    if (moved > 0) {
        shed.cargo -= moved;
        ship.cargo += moved;
    }

    // Full, or the shed is empty and there is no sense waiting on a
    // miner that may be minutes away.
    if (ship.cargo >= ship.cargoMax - CARGO_EPSILON) { setState(ship, TO_BASE, 'hold-full'); return; }
    if (shed.cargo <= CARGO_EPSILON && ship.cargo > CARGO_EPSILON) {
        setState(ship, TO_BASE, 'shed-empty');
    }
}

function toBase(ship, world, dt) {
    const home = homeOf(world, ship);
    if (!home) { wander(ship, world, dt, 0.3); return; }

    arrive(ship, home.x, home.y, 260);
    if (dist(ship.x, ship.y, home.x, home.y) < home.radius + MINER_DOCK_RANGE) {
        ship.transferId = home.id;
        setState(ship, DELIVER, 'docked');
    }
}

function deliver(ship, world, dt) {
    const home = homeOf(world, ship);
    if (!home) { setState(ship, IDLE, 'no-station'); return; }

    arrive(ship, home.x, home.y, 70, 0.5);
    depositToBase(world, ship, home, MINER_DEPOSIT_RATE * 2.2, dt);

    if (ship.cargo <= CARGO_EPSILON) {
        ship.transferId = 0;
        // The premium was against *that* load. A hauler that kept its
        // running total across trips would be owed nothing on its
        // second run and would stop visiting the market after one.
        setState(ship, IDLE, 'delivered');
    }
}

/** The neutral market, if one is still standing. */
function nearestHub(world, ship) {
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'exchange') continue;
        const d2 = (s.x - ship.x) ** 2 + (s.y - ship.y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
}

function toHub(ship, world, dt) {
    const hub = nearestHub(world, ship);
    if (!hub) { setState(ship, TO_BASE, 'no-market'); return; }

    arrive(ship, hub.x, hub.y, 260);
    if (dist(ship.x, ship.y, hub.x, hub.y) < hub.radius + MINER_DOCK_RANGE) {
        ship.transferId = hub.id;
        setState(ship, TRADE, 'docked');
    }
}

/**
 * Alongside, swapping a hold of ore for a better one.
 *
 * The premium lands here and the *metal* does not — it becomes metal
 * at home like every other load, which puts the whole gain on the
 * return leg. A laden hauler is already the most valuable thing on
 * the map (see THREAT_WEIGHT); one leaving the exchange is that,
 * carrying half again as much, outside the only bubble on the board
 * where nobody may shoot at it.
 */
function trade(ship, world, dt) {
    const hub = world.ship(ship.transferId);
    if (!hub || hub.role !== 'exchange') { setState(ship, TO_BASE, 'market-gone'); return; }

    arrive(ship, hub.x, hub.y, 70, 0.5);
    tradeAtHub(world, ship, hub, TRADE_RATE, dt);

    const full = ship.cargo >= ship.cargoMax - CARGO_EPSILON;
    const dry = hub.cargo <= CARGO_EPSILON;
    if (full || dry) {
        ship.transferId = 0;
        setState(ship, TO_BASE, full ? 'hold-full' : 'market-dry');
    }
}
