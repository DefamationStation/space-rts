// ============================================================
// BEHAVIOUR — MINER
// ============================================================
//
//   SEEK ──▸ WORK ──▸ RETURN ──▸ DEPOSIT ──┐
//    ▲                                      │
//    └──────────────────────────────────────┘
//
// A miner does not mine. It carries drones to ore, holds station
// while they work, and hauls the load home — which is why it is
// slow, blunt and unarmed, and why losing one hurts far more than
// losing a fighter.
//
// ------------------------------------------------------------
// CLAIMS, AND WHY THEY ARE PER-FACTION
// ------------------------------------------------------------
//
// A miner claims a field so its own faction's other miners go
// elsewhere — without that they all pile onto the richest cluster
// and the rest of the map goes untouched.
//
// Claims are deliberately *not* respected across factions. Two
// rival miners working the same rocks is the single most reliable
// way this simulation generates contact: escorts follow miners,
// miners follow ore, and ore is where the fighting happens. Making
// claims universal would quietly pull the two factions apart and
// the run would never develop.
//
// Which is why a field carries one claim slot **per faction**
// (`field.claimedBy[factionId]`) rather than one slot in total. With
// one slot the two rules collide: each side ignores the other's claim,
// so each side overwrites it, so no miner's claim survives a step and
// nobody can coordinate with their *own* fleet either. It cost 1,662
// re-claims for 37 deliveries and looked, on screen, like traffic.
// Per-faction slots keep the contention and lose the churn.

import { setState, homeOf, gate, berth, depositPoint } from './common.js';
import { arrive, separate, avoidEdges, wander } from '../steering.js';
import { makeShip } from '../entities.js';
import { depositToBase } from '../economy.js';
import { EV } from '../../core/events.js';
import { dist } from '../../core/math.js';
import { MINER, SPAWNED } from './states.js';
import { droneIsOut } from './drone.js';
import {
    MINER_STANDOFF, MINER_DOCK_RANGE, MINER_DEPOSIT_RATE,
    DRONES_PER_MINER, DRONE_LAUNCH_INTERVAL, CLAIM_TIMEOUT, FIELD_MIN_WORTH,
    FIELD_SCRAP_RANGE,
    MINER_FLEE_RADIUS, MINER_FLEE_CHECK, MINER_SAFE_TIME,
    DRONE_DOCK_OFFSET, DRONE_DOCK_TOLERANCE, CARGO_EPSILON,
} from '../../core/constants.js';

const { SEEK, WORK, RETURN, DEPOSIT, FLEE } = MINER;

/**
 * True while this miner is on station with drones out.
 *
 * Exported because it is the question drone.js actually wants to
 * ask — "may I leave my berth" — and the alternative is drone.js
 * comparing against the literal `'work'`, which survives exactly
 * until someone renames the state.
 */
export function minerIsWorking(miner) {
    return miner.state === WORK;
}

export function minerBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, SEEK, SPAWNED);
    ship.stateTime += dt;

    separate(ship, world);
    avoidEdges(ship, world);

    // Self-preservation outranks every other errand. Checked on a
    // throttle because it is a broadphase query per miner, and a
    // threat does not appear and vanish inside 0.4 s.
    // If under attack, the miner flees immediately without waiting for drones.
    if (world.time >= ship.threatCheckAt) {
        ship.threatCheckAt = world.time + MINER_FLEE_CHECK;
        if (hostileNear(ship, world)) {
            ship.lastThreatAt = world.time;
            if (ship.state !== FLEE && ship.state !== DEPOSIT) {
                releaseClaim(ship, world);
                setState(ship, FLEE, 'hostile-near');
            }
        }
    }

    switch (ship.state) {
        case SEEK: seek(ship, world, dt); break;
        case WORK: work(ship, world, dt); break;
        case RETURN: goHome(ship, world, dt); break;
        case DEPOSIT: deposit(ship, world, dt); break;
        case FLEE: flee(ship, world, dt); break;
    }

    ship.transferOn = gate(ship.transferOn, ship.state === DEPOSIT, dt);
}

/** Any armed enemy inside the panic radius. */
function hostileNear(ship, world) {
    let found = false;
    world.shipGrid.queryCircle(ship.x, ship.y, MINER_FLEE_RADIUS, (other) => {
        if (found || other.dead || other.factionId === ship.factionId) return;
        if (!other.weapon || other.weapon.kind !== 'tracer') return;
        if (dist(ship.x, ship.y, other.x, other.y) > MINER_FLEE_RADIUS) return;
        found = true;
    });
    return found;
}

/**
 * Run for home, and stay there until things have been quiet for a
 * while. A laden miner unloads on arrival rather than sitting on
 * its cargo — a raid should cost the victim time, not the whole
 * trip.
 */
function flee(ship, world, dt) {
    const home = homeOf(world, ship);
    if (!home) { wander(ship, world, dt, 0.4); return; }

    arrive(ship, home.x, home.y, 220);

    const docked = dist(ship.x, ship.y, home.x, home.y) < home.radius + MINER_DOCK_RANGE;
    if (docked && ship.cargo > 0) {
        ship.transferId = home.id;
        setState(ship, DEPOSIT, 'fled-home-laden');
        return;
    }
    if (docked && world.time - ship.lastThreatAt > MINER_SAFE_TIME) {
        setState(ship, SEEK, 'all-quiet');
    }
}

// ------------------------------------------------------------

function seek(ship, world, dt) {
    let field = world.fields[ship.claimId];

    // Re-evaluate on arrival at a dud, on losing the claim, or
    // periodically — a field that looked best on departure may have
    // been stripped by the time we crossed the map.
    if (!field || field.ore <= 0 || field.claimedBy[ship.factionId] !== ship.id) {
        field = claimField(ship, world);
    }

    if (!field) {
        // Nothing worth mining anywhere. Drift near home rather than
        // freezing — a stationary ship reads as broken.
        const home = homeOf(world, ship);
        if (home) arrive(ship, home.x, home.y, 200, 0.5);
        else wander(ship, world, dt);
        return;
    }

    const hold = holdPoint(ship, world, field);
    arrive(ship, hold.x, hold.y, 160);

    if (dist(ship.x, ship.y, field.x, field.y) < MINER_STANDOFF + 90) setState(ship, WORK, 'on-station');
}

function work(ship, world, dt) {
    const field = world.fields[ship.claimId];
    const fieldEmpty = !field || field.ore <= 0;
    const isFull = ship.cargo >= ship.cargoMax - CARGO_EPSILON;

    if (fieldEmpty || isFull) {
        // Station-keeping while waiting for all living drones to dock
        if (field) {
            const hold = holdPoint(ship, world, field);
            arrive(ship, hold.x, hold.y, 130, 0.55);
            wander(ship, world, dt, 0.12);
        } else {
            wander(ship, world, dt, 0.2);
        }

        // Wait for drones to dock before setting sail for base
        if (allDronesDocked(ship, world)) {
            releaseClaim(ship, world);
            const why = isFull ? 'hold-full' : 'field-dry';
            setState(ship, ship.cargo > 0 ? RETURN : SEEK, why);
        }
        return;
    }

    // Hold the claim alive while we are actively working.
    field.claimedBy[ship.factionId] = ship.id;
    field.claimedAt[ship.factionId] = world.time;

    // Station-keeping, not parking: arrive at the hold point with a
    // slack radius and a little wander, so the miner breathes around
    // its position instead of locking to a coordinate.
    const hold = holdPoint(ship, world, field);
    arrive(ship, hold.x, hold.y, 130, 0.55);
    wander(ship, world, dt, 0.12);

    maintainDrones(ship, world);
}

/** Check if all living child drones of this miner are docked at their berth. */
export function allDronesDocked(miner, world) {
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'drone' || s.parentId !== miner.id) continue;
        const slot = berth(s, miner, miner.radius + DRONE_DOCK_OFFSET);
        const d = dist(s.x, s.y, slot.x, slot.y);
        if (d > DRONE_DOCK_TOLERANCE || droneIsOut(s)) return false;
    }
    return true;
}

function goHome(ship, world, dt) {
    // *Home* is now whichever drop point is nearest — the station, or
    // a forward shed. Once the frontier has moved out, a laden miner
    // is usually far closer to a shed than to its own base, and the
    // whole economic argument for building one is that it takes this
    // journey and makes it short.
    const drop = depositPoint(world, ship, ship.cargo) || homeOf(world, ship);
    if (!drop) {
        // No base left to deliver to. Keep station and stay alive.
        wander(ship, world, dt, 0.3);
        return;
    }
    arrive(ship, drop.x, drop.y, 200);
    if (dist(ship.x, ship.y, drop.x, drop.y) < drop.radius + MINER_DOCK_RANGE) {
        ship.transferId = drop.id;
        setState(ship, DEPOSIT, 'docked');
    }
}

function deposit(ship, world, dt) {
    // Whatever it docked with, not whatever is nearest now — a shed
    // that fills while a miner is unloading into it must not send that
    // miner off to the station mid-transfer.
    const drop = world.ship(ship.transferId) || depositPoint(world, ship, 1) || homeOf(world, ship);
    if (!drop) { setState(ship, SEEK, 'no-base'); return; }

    // Each miner gets its own berth around the station, so a fleet
    // of them unloads in a ring rather than wrestling over one point.
    const slot = berth(ship, drop, drop.radius + 34);
    arrive(ship, slot.x, slot.y, 90, 0.5);
    depositToBase(world, ship, drop, MINER_DEPOSIT_RATE, dt);

    // A full shed cannot take the rest; go and find somewhere that can.
    if (drop.role === 'outpost' && drop.cargo >= drop.cargoMax - CARGO_EPSILON
        && ship.cargo > CARGO_EPSILON) {
        ship.transferId = 0;
        setState(ship, RETURN, 'shed-full');
        return;
    }

    if (ship.cargo <= CARGO_EPSILON) {
        ship.cargo = 0;
        ship.transferId = 0;
        setState(ship, SEEK, 'unloaded');
    }
}

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

/** Scratch result for `holdPoint`. Callers must consume it immediately. */
const _hold = { x: 0, y: 0 };

/**
 * Park on the *home side* of a field rather than at its centre.
 *
 * Two reasons: the miner stays out of the rocks its own drones are
 * working, and the return leg starts from the near edge, which
 * shortens every round trip by roughly the field's radius.
 *
 * Writes into a module-level scratch object rather than returning a
 * fresh one: this is called for every working miner on every step,
 * and the rest of the steering path is allocation-free — see the
 * header of sim/steering.js.
 */
function holdPoint(ship, world, field) {
    // Station on the ore that is *left*, not on where the cluster was
    // originally placed. A field is mined from the middle outward, so
    // those two part company as it is worked — and holding the nominal
    // centre strands a miner just beyond its own drones' reach of the
    // survivors, which is a stall with no symptom except that nothing
    // happens. See `cx`/`cy` in worldgen's field record.
    const fx = field.rocks > 0 ? field.cx : field.x;
    const fy = field.rocks > 0 ? field.cy : field.y;

    const home = homeOf(world, ship);
    if (!home) {
        _hold.x = fx;
        _hold.y = fy;
        return _hold;
    }
    const dx = home.x - fx;
    const dy = home.y - fy;
    const d = Math.hypot(dx, dy) || 1;
    _hold.x = fx + (dx / d) * MINER_STANDOFF;
    _hold.y = fy + (dy / d) * MINER_STANDOFF;
    return _hold;
}

/**
 * Choose and claim a field. Score is ore over distance, with a
 * softening constant so a slightly richer field far away does not
 * always beat a decent one nearby.
 */
function claimField(ship, world) {
    releaseClaim(ship, world);

    // Nearest workable field, then the next one out, and so on.
    //
    // This was `ore / (distance + softening)` — a value judgement that
    // weighed a rich distant cluster against a poor near one. It reads
    // sensibly and it produced a map with no *frontier*: every miner
    // independently re-evaluated the whole board every trip, so the
    // fleet scattered across the map from the first minute and the
    // near ore was never actually finished.
    //
    // Working outward instead gives a run a shape. A faction strips
    // what is close, and only then commits to something further —
    // which is a decision with a cost, and eventually the reason to
    // put a forward base out there. `FIELD_MIN_WORTH` is what stops a
    // miner shuttling to the nearest cluster for its last few ore and
    // never noticing the frontier has moved.
    let best = null;
    let bestDist = Infinity;

    for (let i = 0; i < world.fields.length; i++) {
        const field = world.fields[i];
        // Worth is relative to the trip, not absolute. Close enough and
        // there is no such thing as too little left — which is what
        // lets a field actually finish, and finishing is what lets it
        // relocate. See FIELD_SCRAP_RANGE.
        const d = dist(ship.x, ship.y, field.x, field.y);
        if (field.ore < FIELD_MIN_WORTH * Math.min(1, d / FIELD_SCRAP_RANGE)) continue;

        // Only this faction's own slot is consulted, which *is* the
        // rule that claims are not respected across factions — the
        // enemy's claim is not ignored so much as invisible, and it can
        // no longer be trampled on the way past.
        const holderId = field.claimedBy[ship.factionId] || 0;
        if (holderId && holderId !== ship.id && world.ship(holderId)) {
            const stale = world.time - (field.claimedAt[ship.factionId] || 0) > CLAIM_TIMEOUT;
            if (!stale) continue;
        }

        if (d < bestDist) { bestDist = d; best = field; }
    }

    // Nothing left worth the trip: take the richest thing still
    // standing rather than idling. A faction whose map has been
    // stripped bare should be scraping, not parked.
    if (!best) {
        let mostOre = 0;
        for (let i = 0; i < world.fields.length; i++) {
            const field = world.fields[i];
            if (field.ore <= 0) continue;
            const holderId = field.claimedBy[ship.factionId] || 0;
            if (holderId && holderId !== ship.id && world.ship(holderId)) continue;
            if (field.ore > mostOre) { mostOre = field.ore; best = field; }
        }
    }

    if (!best) return null;
    best.claimedBy[ship.factionId] = ship.id;
    best.claimedAt[ship.factionId] = world.time;
    ship.claimId = best.id;
    // Claims are how miners of one faction stay out of each other's
    // way, so claim churn is the tell for miners crossing the map past
    // one another — a thing that reads on screen as ordinary traffic.
    world.events.emit(EV.CLAIM_TAKEN, { ship, field: best });
    return best;
}

function releaseClaim(ship, world) {
    const field = world.fields[ship.claimId];
    if (field && field.claimedBy[ship.factionId] === ship.id) {
        field.claimedBy[ship.factionId] = 0;
        world.events.emit(EV.CLAIM_RELEASED, { ship, field });
    }
    ship.claimId = -1;
}

/**
 * Keep the drone complement topped up, one at a time.
 *
 * Launching them on an interval rather than all at once is purely
 * a visual decision: drones leaving in sequence reads as a crew
 * going to work, and three appearing simultaneously reads as a
 * spawn event.
 */
function maintainDrones(ship, world) {
    if (ship.droneCount >= DRONES_PER_MINER) return;
    if (world.time - ship.lastLaunch < DRONE_LAUNCH_INTERVAL) return;

    const angle = ship.angle + world.rng.spread(1.2);
    const drone = makeShip(world, 'drone', ship.factionId,
        ship.x + Math.cos(angle) * (ship.radius + 4),
        ship.y + Math.sin(angle) * (ship.radius + 4),
        angle);
    drone.parentId = ship.id;
    drone.homeId = ship.homeId;
    drone.vx = ship.vx;
    drone.vy = ship.vy;

    world.addShip(drone);
    ship.lastLaunch = world.time;
    // `droneCount` is not written here. It is derived — `census()` in
    // sim/simulate.js zeroes and recounts it from the roster at the
    // top of every step — so a hand-increment is a value that lives
    // for one step and is then overwritten by the truth. Two of them
    // existed, and both read as bookkeeping the simulation depends
    // on. `lastLaunch` is what actually spaces the launches.
    world.events.emit(EV.SHIP_SPAWNED, { ship: drone });
}
