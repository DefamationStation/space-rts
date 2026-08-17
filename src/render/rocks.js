// ============================================================
// ROCKS — ASTEROID RENDERING
// ============================================================
//
// An asteroid is an irregular polygon with a few metal seams
// showing through it. Both are derived from the fixed `shape`
// array generated once when the rock was created, so nothing is
// randomised at draw time — a rock that re-jitters every frame
// boils rather than sits.
//
// Two things are doing narrative work here:
//
//   · the rock *shrinks* as its ore is taken, so a worked field
//     visibly wears down and you can read a field's remaining
//     value from across the map;
//   · the seams *thin out* with it, so a nearly-spent rock is
//     plain grey stone and stops attracting the eye.
//
// Together those mean the economy is legible without a single
// number on screen.

import { asteroidRadius } from '../sim/entities.js';
import { TAU, clamp01 } from '../core/math.js';
import { rgba } from '../core/color.js';

/** Seams per rock at full ore. Kept low — this is texture, not detail. */
const SEAMS = 3;

export function drawAsteroid(ctx, rock, theme) {
    if (rock.fade <= 0.001) return;

    const n = rock.shape.length;
    const r = asteroidRadius(rock);
    const ore = rock.oreMax > 0 ? clamp01(rock.ore / rock.oreMax) : 0;

    ctx.save();
    ctx.globalAlpha = rock.fade;
    ctx.translate(rock.x, rock.y);
    ctx.rotate(rock.angle);

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const rr = r * rock.shape[i];
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.fillStyle = theme.neutral.rock;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.neutral.rockEdge;
    ctx.stroke();

    // Seams.
    //
    // All of a rock's seams share one direction. Randomly angled
    // strokes read as scratches on the surface; parallel ones read
    // as a mineral vein running through the body, which is the
    // whole point — this is the stuff worth coming here for.
    //
    // The path is clipped to the rock so seams sit *in* the stone
    // rather than on top of it, and their length tracks remaining
    // ore, so a nearly-spent rock is plain grey and stops asking
    // for attention.
    if (ore > 0.05) {
        ctx.clip();

        const seamAngle = rock.shape[0] * TAU;
        const ux = Math.cos(seamAngle), uy = Math.sin(seamAngle);
        const px = -uy, py = ux;

        ctx.lineCap = 'round';
        ctx.strokeStyle = rgba(theme.neutral.vein, 0.34 + ore * 0.24);
        ctx.lineWidth = Math.max(0.85, r * 0.085);
        ctx.beginPath();
        for (let i = 0; i < SEAMS; i++) {
            const spread = (i - (SEAMS - 1) / 2) * r * 0.34;
            // Vary each seam's length and slide it along the vein, so
            // the group is not a rendered barcode.
            const jitter = rock.shape[(i + 2) % n];
            const half = r * (0.34 + jitter * 0.30) * ore;
            const slide = (jitter - 0.98) * r * 0.5;
            const cx = px * spread + ux * slide;
            const cy = py * spread + uy * slide;
            ctx.moveTo(cx - ux * half, cy - uy * half);
            ctx.lineTo(cx + ux * half, cy + uy * half);
        }
        ctx.stroke();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
}
