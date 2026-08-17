// ============================================================
// BEHAVIOUR — OUTPOST
// ============================================================
//
// A shed with a gun. It holds ore, shoots at what comes near, and
// does nothing else — no production, no repair, no decisions.
//
// The absence of self-repair is the design. A mothership knits itself
// back together between assaults, which is what makes a station a
// siege rather than a target; an outpost does not, which is what
// makes the frontier genuinely dangerous. Damage to a shed is
// permanent until it dies, so a raid that gets through *achieves*
// something even if it is driven off, and a faction has to decide
// whether to keep escorting the thing or let it go.

import { setState, pickTarget } from './common.js';
import { tryFire } from '../combat.js';
import { dist, interceptPoint } from '../../core/math.js';
import { OUTPOST, SPAWNED } from './states.js';
import { BATTERY_RETARGET } from '../../core/constants.js';

const { HOLDING, ALERT } = OUTPOST;

/** Seconds after the last shot before a shed stands down again. */
const ALERT_MEMORY = 6;

/** Scratch for the intercept solve — reused, never allocated per call. */
const _lead = { x: 0, y: 0 };

export function outpostBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, HOLDING, SPAWNED);
    ship.stateTime += dt;

    if (!ship.weapon) return;

    const held = world.ship(ship.targetId);
    if (!held || world.time >= ship.retargetAt
        || dist(ship.x, ship.y, held.x, held.y) > ship.weapon.range) {
        ship.retargetAt = world.time + BATTERY_RETARGET;
        const found = pickTarget(world, ship, ship.weapon.range,
            ship.x, ship.y, ship.weapon.range);
        ship.targetId = found ? found.id : 0;
    }

    const target = world.ship(ship.targetId);

    // Alert while something is in reach or the hull has been hit
    // recently, holding otherwise. Two states rather than one, so a
    // shed under attack is legible — and so this is a machine that can
    // actually leave the state it is in.
    const threatened = !!target || world.time - ship.lastHitAt < ALERT_MEMORY;
    setState(ship, threatened ? ALERT : HOLDING, threatened ? 'contact' : 'all-clear');

    if (!target) return;
    if (dist(ship.x, ship.y, target.x, target.y) > ship.weapon.range) return;

    interceptPoint(ship.x, ship.y, target.x, target.y,
        target.vx, target.vy, ship.weapon.speed, _lead);
    tryFire(world, ship, Math.atan2(_lead.y - ship.y, _lead.x - ship.x));
}
