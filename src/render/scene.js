// ============================================================
// SCENE — DRAW ORDER
// ============================================================
//
// The whole frame, in order. Two decisions here shape everything
// the viewer sees.
//
// ------------------------------------------------------------
// 1. DEPTH BY MEANING
// ------------------------------------------------------------
//
//   ground · grid
//   debris          dead things sink
//   asteroids       the terrain
//   hulls           the living
//   effects         light, on top of everything
//
// Debris under the rocks and hulls over them is not physically
// motivated — it is narrative. Wreckage settling out of the way
// keeps a busy fight legible, and living ships passing over the
// stone keeps the eye on what matters.
//
// ------------------------------------------------------------
// 2. ONE EFFECTS PASS
// ------------------------------------------------------------
//
// Everything emissive — thrusters, mining beams, cargo tethers,
// tracers, muzzles, impacts, sparks — is drawn inside a single
// block with the theme's composite mode set once.
//
// That is partly performance (switching `globalCompositeOperation`
// is a state change per switch, and there can be hundreds of these
// per frame) and partly correctness: on `void` the mode is
// `lighter`, and light is *supposed* to accumulate. Two tracers
// crossing brighten where they meet, and a fight in a confined
// space glows. Drawing them individually with the mode toggled
// around each would lose exactly that.

import { drawBackground } from './background.js';
import { drawAsteroid } from './rocks.js';
import { drawShip, drawThruster } from './hulls.js';
import { drawShards, drawEmissiveParticles } from './particles.js';
import { drawTracers, drawBeams, drawTransferBeam, drawWarpStreaks } from './weaponfx.js';
import { drawGizmos, drawSelection } from './gizmos.js';
import { lerp } from '../core/math.js';

export function drawScene(ctx, world, theme, stage, alpha, clear = true, options = {}) {
    let shouldClear = true;
    let opts = options;
    if (typeof clear === 'boolean') {
        shouldClear = clear;
    } else if (typeof clear === 'object' && clear !== null) {
        opts = clear;
        shouldClear = opts.clear !== false;
    }

    drawBackground(ctx, theme, stage, shouldClear);

    drawShards(ctx, world, theme, alpha);

    for (let i = 0; i < world.asteroids.length; i++) {
        drawAsteroid(ctx, world.asteroids[i], theme);
    }

    // ----- spatial gizmos layer (?debug=2, or the G key) -----
    //
    // A selection is *not* one of the conditions. Clicking a fighter
    // used to switch on the whole diagnostic overlay for the entire
    // map while the controls panel went on reporting gizmos as off —
    // which it was. Inspecting a ship and debugging the simulation are
    // different intentions, and they now draw different things.
    const selectedIds = opts.selectedIds || null;
    if (opts.debugLevel >= 2 || opts.gizmos) {
        drawGizmos(ctx, world, theme, stage, alpha, opts.selectedShipId || 0, selectedIds);
    } else {
        drawSelection(ctx, world, theme, stage, alpha, opts.selectedShipId || 0, selectedIds);
    }

    for (let i = 0; i < world.ships.length; i++) {
        drawShip(ctx, world.ships[i], theme, alpha, world);
    }

    // ----- effects pass -----------------------------------
    ctx.save();
    ctx.globalCompositeOperation = theme.fx.composite;

    for (let i = 0; i < world.ships.length; i++) {
        drawThruster(ctx, world.ships[i], theme, alpha);
    }

    drawWarpStreaks(ctx, world, theme, alpha);
    drawBeams(ctx, world, theme, alpha);
    drawTransfers(ctx, world, theme, alpha);
    drawTracers(ctx, world, theme, alpha);
    drawEmissiveParticles(ctx, world, theme, alpha);

    ctx.restore();
}

/**
 * Cargo tethers — miner to mothership, drone to miner.
 *
 * Driven entirely by two generic fields on the ship
 * (`transferId`, `transferOn`) rather than by inspecting behaviour
 * state names. The renderer therefore knows nothing about state
 * machines, and a future ship that transfers cargo some other way
 * gets the visual for free.
 */
function drawTransfers(ctx, world, theme, alpha) {
    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.transferOn <= 0.01 || !ship.transferId) continue;

        const other = world.ship(ship.transferId);
        if (!other) continue;

        drawTransferBeam(ctx, theme,
            lerp(ship.prevX, ship.x, alpha), lerp(ship.prevY, ship.y, alpha),
            lerp(other.prevX, other.x, alpha), lerp(other.prevY, other.y, alpha),
            ship.factionId, ship.transferOn * ship.fade, world.time);
    }
}
