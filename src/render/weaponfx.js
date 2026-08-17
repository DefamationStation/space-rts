// ============================================================
// WEAPON FX
// ============================================================
//
// The most important file in the project. Everything else can be
// merely correct; this has to be *good*.
//
// ------------------------------------------------------------
// ANATOMY OF A SHOT
// ------------------------------------------------------------
//
// A round has three visual moments, and all three are needed.
// Drop any one and the shot stops feeling like an event:
//
//   muzzle   70 ms bloom at the barrel, plus a hull kick.
//            Handled by sim/effects.js + render/particles.js.
//   travel   this file. The tracer itself.
//   impact   a ring and a spray of sparks, thrown back along the
//            round's path. Also particles.js.
//
// ------------------------------------------------------------
// THE COMET TRICK
// ------------------------------------------------------------
//
// A tracer needs a bright compact head and a soft tail that fades
// behind it. The obvious implementation is a stroke with a linear
// gradient, which means allocating a gradient object per round per
// frame and produces a soft head as well as a soft tail.
//
// Instead: each glow layer is drawn *shorter* than the one beneath
// it. The widest, faintest layer runs the full tracer length; the
// bright core covers only the leading 44%. Where all three overlap
// — at the head — the alphas stack into a hot point. Behind it,
// only the faint outer layer survives. The result is a comet, out
// of three plain strokes, with no gradients and no allocation.
//
// The taper is authored per theme (`fx.tracerTaper`) because ink
// wicks further than light blooms.
//
// ------------------------------------------------------------
// WHAT THIS FILE MUST NEVER DO
// ------------------------------------------------------------
//
// No screen shake. No full-frame flash. No chromatic aberration.
// No lens flare. Those read as compensation for effects that are
// not carrying themselves, and they are the loudest possible
// violation of the calm this project is built around.

import { softDot, cometStamp } from './draw.js';
import { rgba } from '../core/color.js';
import { lerp, clamp01, TAU } from '../core/math.js';

/**
 * How fast a drive flare flickers, in radians per second of the
 * round's remaining life. Deliberately not a round number — a rate
 * that divides evenly into a salvo's spacing makes every missile in
 * it pulse in unison, which reads as a strobe rather than as engines.
 */
const DRIVE_FLICKER_RATE = 37.3;

/** How fast a heavy round rolls, and how far off its path it leans. */
const TUMBLE_RATE = 5.1;
const TUMBLE_ARC = 0.075;

/** Base radius of that flare, before girth and flicker. */
const DRIVE_FLARE = 3.1;

// ------------------------------------------------------------
// TRACERS
// ------------------------------------------------------------

/**
 * Draw every projectile in flight.
 *
 * Assumes the caller has already switched to the theme's composite
 * mode — batching the whole FX pass under one switch rather than
 * toggling per round.
 */
export function drawTracers(ctx, world, theme, alpha) {
    const fx = theme.fx;

    for (let i = 0; i < world.projectiles.length; i++) {
        const p = world.projectiles[i];
        const pal = theme.factions[p.factionId];
        const core = fx.hotCore ? pal.flash : null;

        const x = lerp(p.prevX, p.x, alpha);
        const y = lerp(p.prevY, p.y, alpha);

        // Emerge from the muzzle over the first few milliseconds, and
        // dim as the round runs out of range. Rounds that blink into
        // and out of existence at full brightness look like sprites.
        const age = p.maxLife - p.life;
        const fade = clamp01(age / 0.035) * clamp01(p.life / 0.10);
        if (fade <= 0.01) continue;

        const heading = Math.atan2(p.vy, p.vx);

        // A wake behind slow rounds, and none behind fast ones.
        //
        // The length is inverse to velocity, which is the opposite of
        // the instinct and is the right way round. A pulse round at
        // 620 u/s crosses its whole engagement in a blink — it is a
        // flash of light and a streak behind it would read as smear.
        // A lance shell at 250 spends most of a second in the air and
        // is a thing you are *meant* to watch, and to dodge: giving it
        // a visible wake makes the one weapon the evasion code can
        // actually beat legible as such.
        //
        // Drawn first and dimmer, so the round itself stays the
        // brightest point and the wake reads as something it left.
        const girth = p.weapon.tracerGirth || 1;

        const slow = clamp01((520 - p.weapon.speed) / 380);
        if (slow > 0.02) {
            cometStamp(ctx, x, y, heading,
                p.weapon.tracerLength * fx.tracerScale * (1 + slow * 2.6),
                pal.weapon, null, fx.composite, fade * fx.tracerGlow * slow * 0.34, girth);
        }

        // The drive.
        //
        // A round under power is a different object from a round that
        // was thrown, and until this existed the simulation drew them
        // identically. A torpedo spends nearly six seconds crossing
        // its own range — long enough that a viewer has time to ask
        // what it is — and a flare that flickers behind it answers:
        // that thing is *driving* at you, and it will not stop.
        //
        // The flicker is taken from the round's own remaining life
        // rather than from a clock or a random, so it is deterministic,
        // costs nothing, and every round in a salvo pulses out of step
        // with its neighbours because each has a different life left.
        if (p.weapon.drive) {
            const flicker = 0.72 + 0.28 * Math.sin(p.life * DRIVE_FLICKER_RATE);
            const back = p.weapon.tracerLength * fx.tracerScale * 0.5;
            softDot(ctx, x - Math.cos(heading) * back, y - Math.sin(heading) * back,
                DRIVE_FLARE * girth * flicker, pal.thruster, fx.composite,
                fade * fx.tracerGlow * 0.55);
        }

        // A body, not a blob.
        //
        // Heavy ordnance is drawn as several stamps stacked along its
        // own axis rather than one long one, so it reads as a hull with
        // a length instead of a smear with a bright end — and a slight
        // tumble off the flight path, taken from the round's own life
        // so it is deterministic and every round in the air rolls
        // differently. A projectile that tracks its velocity vector
        // *exactly* is the thing that looks like a sprite.
        const segments = p.weapon.segments || 1;
        if (segments > 1) {
            const wobble = Math.sin(p.life * TUMBLE_RATE) * TUMBLE_ARC;
            const step = p.weapon.tracerLength * fx.tracerScale * 0.30;
            for (let k = segments - 1; k >= 0; k--) {
                const bx = x - Math.cos(heading) * step * k;
                const by = y - Math.sin(heading) * step * k;
                cometStamp(ctx, bx, by, heading + wobble,
                    p.weapon.tracerLength * fx.tracerScale * (1 - k * 0.16),
                    pal.weapon, k === 0 ? core : null, fx.composite,
                    fade * fx.tracerGlow * (1 - k * 0.22), girth * (1 - k * 0.12));
            }
        } else {
            cometStamp(ctx, x, y, heading,
                p.weapon.tracerLength * fx.tracerScale,
                pal.weapon, core, fx.composite, fade * fx.tracerGlow, girth);
        }
    }
}

/**
 * Arrival streaks.
 *
 * A hull still shedding warp speed drags a long comet behind it,
 * scaled by how much of that speed is left — so the streak is at its
 * most violent on the frame it appears and has bled to nothing by the
 * time it is flying normally. The length is taken from the *actual
 * velocity*, not from a timer, which is what keeps the visual and the
 * physics telling the same story: a hull that has been slowed by
 * something else is drawn slower too.
 */
export function drawWarpStreaks(ctx, world, theme, alpha) {
    const fx = theme.fx;

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.warpT <= 0.01) continue;

        const pal = theme.factions[ship.factionId] || theme.factions[0];
        const core = fx.hotCore ? pal.flash : null;
        const x = lerp(ship.prevX, ship.x, alpha);
        const y = lerp(ship.prevY, ship.y, alpha);

        const speed = Math.hypot(ship.vx, ship.vy);
        const excess = clamp01((speed - ship.def.speed) / Math.max(1, ship.def.speed * 3));
        if (excess <= 0.01) continue;

        const heading = Math.atan2(ship.vy, ship.vx);
        const t = ship.warpT * excess;

        // Two stamps: a long dim smear for the distance covered, and a
        // shorter bright one at the hull so the ship itself still reads
        // as the object rather than as the front of a stripe.
        cometStamp(ctx, x, y, heading, 40 + 190 * t,
            pal.weapon, null, fx.composite, 0.30 * t * fx.tracerGlow);
        cometStamp(ctx, x, y, heading, 16 + 60 * t,
            pal.weapon, core, fx.composite, 0.75 * t * fx.tracerGlow);
    }
}

// ------------------------------------------------------------
// BEAMS
// ------------------------------------------------------------

/**
 * Mining beams: drone to rock.
 *
 * These are the calmest thing on screen and they set the tone for
 * the whole piece, so they are deliberately gentle — low alpha, a
 * slow breath, and a soft contact point where the beam meets the
 * stone.
 *
 * The shimmer is in *alpha only*. Wobbling a beam's position is
 * the obvious way to make it look energetic and it always reads as
 * cheap: real light does not wander, and the eye knows it. A beam
 * that holds its line and merely breathes reads as powerful and
 * controlled instead.
 */
export function drawBeams(ctx, world, theme, alpha) {
    const fx = theme.fx;
    const spec = fx.beam;
    const layers = spec.widths.length;

    ctx.lineCap = 'round';

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (!ship.weapon || ship.weapon.kind !== 'beam' || ship.beamOn <= 0.01) continue;

        const rock = world.rock(ship.beamTargetId);
        if (!rock) continue;

        const pal = theme.factions[ship.factionId];
        const core = fx.hotCore ? pal.flash : null;

        const sx = lerp(ship.prevX, ship.x, alpha);
        const sy = lerp(ship.prevY, ship.y, alpha);

        const dx = rock.x - sx;
        const dy = rock.y - sy;
        const d = Math.hypot(dx, dy) || 1;
        const ux = dx / d;
        const uy = dy / d;

        // Start just ahead of the drone and stop at the rock's surface
        // rather than its centre, so the beam terminates on the stone.
        const x0 = sx + ux * ship.weapon.muzzleOffset;
        const y0 = sy + uy * ship.weapon.muzzleOffset;
        const contact = Math.max(0, d - rockSurfaceOffset(rock));
        const x1 = sx + ux * contact;
        const y1 = sy + uy * contact;

        const w = ship.weapon;
        const breath = 1 - w.shimmerDepth * 0.5
            + w.shimmerDepth * 0.5 * Math.sin(world.time * w.shimmerHz * TAU + ship.id);
        const scale = ship.beamOn * breath * ship.fade;

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        for (let l = 0; l < layers; l++) {
            const a = spec.alphas[l] * scale;
            if (a <= 0.002) continue;
            ctx.lineWidth = spec.widths[l];
            ctx.strokeStyle = rgba(l === layers - 1 && core ? core : pal.weapon, a);
            ctx.stroke();
        }

        // Contact bloom where the beam meets the stone, and a smaller
        // one at the emitter. The contact point is the brightest part
        // of the whole effect — that is where the work is happening.
        softDot(ctx, x1, y1, 5.5, pal.weapon, scale * 0.85);
        softDot(ctx, x1, y1, 2.2, core || pal.weapon, scale * 0.9);
        softDot(ctx, x0, y0, 2.4, pal.weapon, scale * 0.6);
    }
}

/** Approximate surface offset for terminating a beam on a rock. */
function rockSurfaceOffset(rock) {
    // Cheap and stable: the rock's mean shape radius. Exact
    // polygon intersection would move the contact point around as
    // the rock rotates, which reads as the beam slipping.
    return rock.radiusMax * 0.62;
}

// ------------------------------------------------------------
// DEPOSIT BEAM
// ------------------------------------------------------------

/**
 * The tether a miner shows while unloading into its mothership,
 * and a drone shows while unloading into its miner. Same visual
 * language as a mining beam, one notch quieter — it is a transfer,
 * not work being done.
 */
export function drawTransferBeam(ctx, theme, ax, ay, bx, by, factionId, scale, time) {
    if (scale <= 0.01) return;
    const fx = theme.fx;
    const spec = fx.beam;
    const pal = theme.factions[factionId];
    const core = fx.hotCore ? pal.flash : null;

    const breath = 0.82 + 0.18 * Math.sin(time * 1.6 * TAU);
    const s = scale * breath * 0.7;

    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    for (let l = 0; l < spec.widths.length; l++) {
        const a = spec.alphas[l] * s;
        if (a <= 0.002) continue;
        ctx.lineWidth = spec.widths[l] * 0.8;
        ctx.strokeStyle = rgba(l === spec.widths.length - 1 && core ? core : pal.weapon, a);
        ctx.stroke();
    }
    softDot(ctx, ax, ay, 2.2, pal.weapon, s * 0.7);
}
