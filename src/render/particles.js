// ============================================================
// PARTICLES — DRAWING
// ============================================================
//
// Four effect kinds, all drawn from one pool. Motion and ageing
// happen in `sim/effects.js`; this file only decides what they
// look like.
//
// `spark`, `ring` and `muzzle` are emissive and belong to the
// additive/ink FX pass. `shard` is *not* — dead metal does not
// glow — so it is drawn with the ordinary scene, underneath the
// living ships. That split is deliberate: it is what makes a
// wreck read as debris settling rather than as another explosion
// effect.

import { softDot, layeredRing, tracePoly } from './draw.js';
import { rgba, mixHex } from '../core/color.js';
import { lerp, clamp01, easeOutQuad, easeOutCubic } from '../core/math.js';

// ------------------------------------------------------------
// NON-EMISSIVE — drawn with the scene
// ------------------------------------------------------------

/**
 * Hull fragments. They fade *and* desaturate toward the ground
 * colour as they age, so a wreck cools into the background instead
 * of vanishing at full brightness.
 */
export function drawShards(ctx, world, theme, alpha) {
    const list = world.particles;
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.kind !== 'shard') continue;

        const t = clamp01(p.life / p.maxLife);
        const pal = theme.factions[p.factionId];
        const x = lerp(p.prevX, p.x, alpha);
        const y = lerp(p.prevY, p.y, alpha);

        ctx.save();
        ctx.globalAlpha = easeOutQuad(t) * 0.85;
        ctx.translate(x, y);
        ctx.rotate(p.angle);
        tracePoly(ctx, p.shape);
        ctx.fillStyle = mixHex(theme.neutral.debris, pal.plate, t * 0.6);
        ctx.fill();
        ctx.restore();
    }
    ctx.globalAlpha = 1;
}

// ------------------------------------------------------------
// EMISSIVE — drawn inside the FX pass
// ------------------------------------------------------------

/**
 * Sparks, impact rings and muzzle flashes.
 *
 * Assumes the caller has already set the theme's composite mode.
 * Every curve here eases *out* — effects decay quickly at first
 * and linger faintly, which is both how light actually behaves and
 * what stops a busy moment turning into a flicker.
 */
export function drawEmissiveParticles(ctx, world, theme, alpha) {
    const fx = theme.fx;
    const list = world.particles;

    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p.kind === 'shard') continue;

        const pal = theme.factions[p.factionId];
        const core = fx.hotCore ? pal.flash : null;
        const t = clamp01(p.life / p.maxLife);       // 1 → 0 over its life
        const age = 1 - t;
        const x = lerp(p.prevX, p.x, alpha);
        const y = lerp(p.prevY, p.y, alpha);

        if (p.kind === 'spark') {
            // Sparks shrink as well as fade — one that only fades
            // reads as a dimming dot rather than as a cooling ember.
            softDot(ctx, x, y, 2.2 * t + 0.5, core || pal.weapon,
                easeOutQuad(t) * fx.sparkAlpha);

        } else if (p.kind === 'ring') {
            // Expand fast, then ease to a stop, fading as it goes.
            layeredRing(ctx, x, y, p.size * easeOutCubic(age), fx.impact, pal.weapon, core, t * t);

        } else if (p.kind === 'muzzle') {
            // Very short-lived: a bloom at the barrel plus a stubby
            // forward spike, so the flash has a direction.
            const s = easeOutQuad(t);
            softDot(ctx, x, y, p.size * (1.1 + age * 0.8), pal.weapon, s * 0.9);
            softDot(ctx, x, y, p.size * 0.5, core || pal.weapon, s);
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + Math.cos(p.angle) * p.size * 2.1, y + Math.sin(p.angle) * p.size * 2.1);
            ctx.lineCap = 'round';
            ctx.lineWidth = fx.muzzle.widths[2];
            ctx.strokeStyle = rgba(core || pal.weapon, fx.muzzle.alphas[2] * s);
            ctx.stroke();
        }
    }
}
