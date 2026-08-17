// ============================================================
// BEHAVIOUR — EXCHANGE
// ============================================================
//
//   OPEN ⇄ TRADING
//
// The neutral market. It has no side, no guns and nowhere to go, so
// almost everything interesting about it lives somewhere else: the
// no-fire bubble is one predicate in `behaviors/common.js`, and the
// trade itself is run by the hauler that flew here, because the ship
// that gains something should be the ship that does the work.
//
// ------------------------------------------------------------
// WHY IT HAS A STATE MACHINE AT ALL
// ------------------------------------------------------------
//
// It would have been defensible to give this no behaviour and let it
// sit in the ship list as scenery. Two states earn their place:
//
// A structure that never changes reads as painted on. The one thing
// a viewer needs to understand about this place is that it is *for*
// something, and the only way to say so without text is to have it
// visibly react when somebody arrives. TRADING is what the renderer
// lights the banner from.
//
// It is also the honest answer to the dead-end-state guard in
// tests/sim.test.js. `outpost` is on that test's exemption list
// because it leaves `holding` only when attacked, and a run where
// nobody raids a shed is an ordinary run. This is not in that
// position: an exchange that is never traded with in a whole run
// means the trade route is broken, and that should fail a test
// rather than be excused by one.

import { setState } from './common.js';
import { EXCHANGE, SPAWNED } from './states.js';
import { CARGO_EPSILON, TRADE_RESTOCK } from '../../core/constants.js';

const { OPEN, TRADING } = EXCHANGE;

export function exchangeBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, OPEN, SPAWNED);
    ship.stateTime += dt;

    // Somebody is alongside with their hold open. The hauler sets
    // `transferId` to this hub for exactly as long as it is trading,
    // so this is a read of a fact rather than a second opinion about
    // whether a trade is happening.
    let serving = false;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'hauler') continue;
        if (s.transferId === ship.id) { serving = true; break; }
    }

    setState(ship, serving ? TRADING : OPEN, serving ? 'customer' : 'trade-done');

    // The float is not infinite, and it recovers.
    //
    // Without this a busy run drains the market and the route quietly
    // stops paying, which would read as a bug rather than as a
    // market. It refills slowly enough that two fleets trading hard
    // do genuinely compete for it — which is the one place the
    // exchange is allowed to be a source of friction between them,
    // and it is friction that never involves a shot being fired.
    if (ship.cargo < ship.cargoMax - CARGO_EPSILON) {
        ship.cargo = Math.min(ship.cargoMax, ship.cargo + TRADE_RESTOCK * dt);
    }
}
