// ============================================================
// ECONOMY — ORE MOVEMENT
// ============================================================
//
// Every transfer of ore in the simulation goes through one of the
// three functions below. Nothing else is allowed to touch
// `rock.ore`, `ship.cargo` or `faction.metal`.
//
// The point of that discipline is conservation. Between its source
// and its sink, ore only ever *moves*:
//
//     rock.ore → drone.cargo → miner.cargo → faction.metal
//
// Each hop is rate-limited and clamped by what the source actually
// has and what the destination can actually accept, so a hop can
// never mint ore by rounding or lose it by overfilling.
//
// ------------------------------------------------------------
// THE LEDGER
// ------------------------------------------------------------
//
// Metal enters the world three ways and leaves two, and at every
// instant the books balance exactly:
//
//     IN                        OUT
//     ore extracted             cargo in transit
//     salvage trickle           metal banked
//     starting metal            metal spent on hulls
//     traded at the exchange    cargo destroyed with its ship
//
// tests/sim.test.js asserts this to within a float epsilon
// after thousands of steps. It is a cheap test that catches an
// expensive class of bug: an economy that quietly leaks or mints
// still *looks* fine on screen for a long time, and by the time
// the balance is visibly wrong the cause is far behind you.
//
// If you add a new way for ore to move, add it here, and if you
// add a new source or sink, add it to the ledger.

import { EV } from '../core/events.js';
import { CARGO_EPSILON } from '../core/constants.js';

/**
 * Move ore from a rock into a drone's hold.
 * Returns the amount actually taken.
 */
export function mineRock(world, drone, rock, dt) {
    const rate = drone.weapon ? drone.weapon.rate : 0;
    const room = drone.cargoMax - drone.cargo;
    const amount = Math.min(rate * dt, room, rock.ore);
    if (amount <= 0) return 0;

    rock.ore -= amount;
    drone.cargo += amount;
    world.oreExtracted += amount;

    // A spent rock does not vanish; it starts fading, and
    // worldgen's field renewal takes it from there.
    if (rock.ore <= CARGO_EPSILON && !rock.depleting) {
        rock.ore = 0;
        rock.depleting = true;
        world.events.emit(EV.ORE_DEPLETED, { asteroid: rock });
    }
    return amount;
}

/**
 * Move ore from a drone into its parent miner.
 * Returns the amount actually transferred.
 */
export function unloadToMiner(world, drone, miner, rate, dt) {
    const room = miner.cargoMax - miner.cargo;
    const amount = Math.min(rate * dt, room, drone.cargo);
    if (amount <= 0) return 0;

    drone.cargo -= amount;
    miner.cargo += amount;
    return amount;
}

/**
 * Move ore from a miner into its faction's treasury, where it
 * stops being ore and becomes metal.
 */
export function depositToBase(world, miner, target, rate, dt) {
    // Into a shed, ore is still ore.
    //
    // An outpost holds what it is given and a hauler moves it home
    // later, so this hop is a transfer between two holds rather than a
    // sale. Only arriving at a *mothership* turns ore into metal —
    // which is what keeps the ledger honest, and what makes a raided
    // outpost a real loss rather than an inconvenience.
    if (target.role === 'outpost') {
        const room = target.cargoMax - target.cargo;
        const moved = Math.min(rate * dt, miner.cargo, room);
        if (moved <= 0) return 0;
        miner.cargo -= moved;
        target.cargo += moved;
        world.events.emit(EV.DEPOSIT, { ship: miner, amount: moved });
        return moved;
    }

    const amount = Math.min(rate * dt, miner.cargo);
    if (amount <= 0) return 0;

    miner.cargo -= amount;
    const faction = world.faction(target.factionId);
    faction.metal += amount;
    faction.minedTotal += amount;

    world.events.emit(EV.DEPOSIT, { ship: miner, amount });
    return amount;
}

/**
 * Load a hauler out of the market's float.
 *
 * This is a genuine new source of ore, so it is declared as one —
 * `world.tradedTotal` is a third IN term beside mining and salvage,
 * and tests/sim.test.js holds the books to a float epsilon. Adding
 * to `ship.cargo` quietly here would have balanced on screen for a
 * very long time and eventually shown up as an economy that mints,
 * which is exactly the failure the ledger exists to catch.
 *
 * Bounded by the hold and by what the market actually has. The
 * second bound is the one that makes this a place rather than a
 * button: there is one float, it runs down, it refills slowly, and
 * both fleets draw on it.
 *
 * Returns the ore loaded.
 */
export function tradeAtHub(world, hauler, hub, rate, dt) {
    const room = hauler.cargoMax - hauler.cargo;
    const amount = Math.min(rate * dt, room, hub.cargo);
    if (amount <= 0) return 0;

    hub.cargo -= amount;
    hauler.cargo += amount;
    world.tradedTotal += amount;

    world.events.emit(EV.DEPOSIT, { ship: hauler, amount });
    return amount;
}

/**
 * Spend metal. The only place metal leaves the world.
 * Returns false and changes nothing if the faction cannot afford it.
 */
export function spendMetal(faction, amount) {
    if (faction.metal < amount) return false;
    faction.metal -= amount;
    faction.metalSpent += amount;
    return true;
}

/**
 * Charge a faction for keeping its fleet in the sky.
 *
 * Takes what it can and no more — a faction that cannot pay simply
 * arrives at zero, and the consequence is that it cannot *build*.
 * That is the whole mechanism: upkeep does not sink ships, it caps
 * how large a fleet an economy can carry, so the ceiling moves with
 * income instead of sitting in a constant.
 *
 * Routed through the ledger like every other outflow. Metal leaves
 * the world here exactly as it does when a hull is bought, and
 * `tests/sim.test.js` holds the books to a float epsilon over
 * thousands of steps — an unaccounted drain would look fine on screen
 * for a long time and be very hard to find later.
 */
export function payUpkeep(faction, amount) {
    const paid = Math.min(amount, faction.metal);
    if (paid <= 0) return 0;
    faction.metal -= paid;
    faction.metalSpent += paid;
    faction.upkeepPaid += paid;
    return paid;
}

/**
 * Total ore sitting in holds right now, across every faction.
 *
 * The market's float is deliberately not counted. It is not ore *in
 * the world* — it is the exchange's own stock, and it only becomes
 * ore anybody has when a hauler loads it, which is the moment
 * `tradeAtHub` books it as income. Counting it here as well would
 * have it on the books twice on the way out and never on the way in:
 * the conservation test caught exactly that, an unexplained 31.89
 * against a float that had restocked by the same amount.
 */
export function oreInTransit(world) {
    let total = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.role === 'exchange') continue;
        total += s.cargo;
    }
    return total;
}
