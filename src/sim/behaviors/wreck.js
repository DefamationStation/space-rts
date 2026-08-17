// ============================================================
// BEHAVIOUR — WRECK
// ============================================================
//
// Drifting cargo. It coasts on the momentum its owner had, and after
// `WRECK_LIFE` it is gone along with whatever it was holding.
//
// The expiry is the whole design. Permanent salvage would remove the
// cost of losing a miner — the ore would always come back eventually,
// so a kill would be an inconvenience rather than a loss. A ninety
// second clock makes it a *race*: worth diverting a hauler for if one
// is close, written off if none is, and contested if both sides
// fancy it.

import { setState } from './common.js';
import { WRECK, SPAWNED } from './states.js';
import { WRECK_LIFE, SPACE_DRAG } from '../../core/constants.js';

const { DRIFTING, FADING } = WRECK;

export function wreckBehavior(ship, world, dt) {
    if (!ship.state) setState(ship, DRIFTING, SPAWNED);
    ship.stateTime += dt;

    // Coasts rather than holding position — it has no engine, so the
    // only thing acting on it is the drag that stands in for a vacuum.
    // `applyMotion` is not run for it (no steering, immobile), so the
    // integration happens here.
    const drag = Math.exp(-SPACE_DRAG * dt);
    ship.vx *= drag;
    ship.vy *= drag;
    ship.x += ship.vx * dt;
    ship.y += ship.vy * dt;

    // Fade out over the last couple of seconds, so it thins rather
    // than blinking out — and the ore goes with it.
    const age = world.time - ship.spawnAt;
    if (age > WRECK_LIFE - 2) {
        setState(ship, FADING, 'expiring');
        ship.fade = Math.max(0, (WRECK_LIFE - age) / 2);
    }
    if (age >= WRECK_LIFE) ship.dead = true;
}
