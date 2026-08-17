// ============================================================
// GIZMOS — SPATIAL DECISION GEOMETRIES
// ============================================================
//
// Debug overlay rendering invisible rules and decision geometries:
// - Field cluster boundaries (FIELD_SCATTER)
// - Miner standoff points & vectors (MINER_STANDOFF)
// - Field claims (miner -> field links)
// - Mining tethers (MINING_RADIUS around miners)
// - Drone and miner berth rings & docking slots
// - Fighter engage leashes (ENGAGE_LEASH around anchor) and anchor links
// - Escort links (fighter -> escorted ship)
// - Target lock lines (weapon-colored lines to target)
// - Selection reticle (high-contrast bracketed box on selected ship)
//
// Complies strictly with Gospel rule 1 (themes only, no hex literals)
// and Gospel rule 5 (zero Math.random, purely deterministic).

import { rgba } from '../core/color.js';
import { TAU, lerp, lerpAngle } from '../core/math.js';
import {
    FIELD_SCATTER, MINER_STANDOFF, MINING_RADIUS,
    ENGAGE_LEASH, ESCORT_RADIUS, DRONE_DOCK_OFFSET,
} from '../core/constants.js';
import { berth } from '../sim/behaviors/common.js';

/**
 * Draw all spatial decision geometries and debug overlays.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} world
 * @param {object} theme
 * @param {object} stage
 * @param {number} alpha
 * @param {number} selectedShipId
 * @param {number[]} [selectedIds] every hull in a multi-hull selection
 *
 * `selectedShipId` stays a plain number in position six because that
 * is the signature the tooling and inspector tests call this with.
 * Multi-selection is an additional argument rather than a widened
 * one — a parameter that is sometimes a number and sometimes a list
 * is a parameter every caller has to think about.
 */
export function drawGizmos(ctx, world, theme, stage, alpha, selectedShipId = 0, selectedIds = null) {
    if (!world) return;

    ctx.save();

    // 1. Field cluster radii
    drawFieldRadii(ctx, world, theme, stage);

    // 2. Miner claim links & standoff points
    drawMinerGizmos(ctx, world, theme, stage, alpha);

    // 3. Mining tethers & drone berth rings
    drawMiningTethers(ctx, world, theme, stage, alpha);

    // 4. Mothership deposit berth rings
    drawMothershipBerths(ctx, world, theme, stage, alpha);

    // 5. Fighter engage leashes, escort lines, and target locks
    drawFighterGizmos(ctx, world, theme, stage, alpha);

    // 6. Other ship target locks (e.g. Mothership point defense)
    drawOtherTargetLines(ctx, world, theme, stage, alpha);

    // 7. Selection reticles — one per selected hull.
    //
    // Still drawn here so a caller that wants the whole overlay gets
    // the reticle with it, but this is no longer the *only* way to get
    // one: `drawSelection` below draws it alone. See the note there.
    drawSelection(ctx, world, theme, stage, alpha, selectedShipId, selectedIds);

    ctx.restore();
}

/**
 * Just the selection marker, with none of the debug overlay.
 *
 * Selecting a ship used to light up the entire gizmos layer — field
 * radii, every miner's claim line, every mining tether, every escort
 * leash — because `scene.js` treated "something is selected" as one
 * of the conditions for drawing the whole thing. Clicking a single
 * fighter covered the map in diagnostic geometry, and the controls
 * panel correctly reported gizmos as *off* the entire time, because
 * they were: the flag was false and the render path simply was not
 * reading it.
 *
 * Inspecting a hull and debugging the simulation are different
 * intentions and now have different functions. This one answers
 * "which ship am I looking at" and nothing else.
 */
export function drawSelection(ctx, world, theme, stage, alpha, selectedShipId = 0, selectedIds = null) {
    if (!world) return;

    if (selectedIds && selectedIds.length > 1) {
        for (let i = 0; i < selectedIds.length; i++) {
            drawSelectionReticle(ctx, world, theme, stage, alpha, selectedIds[i]);
        }
    } else if (selectedShipId > 0) {
        drawSelectionReticle(ctx, world, theme, stage, alpha, selectedShipId);
    }
}

/** Field cluster boundaries and center points */
function drawFieldRadii(ctx, world, theme, stage) {
    const px = stage?.pixel || 1;
    ctx.lineWidth = px;
    ctx.strokeStyle = rgba(theme.neutral.vein, 0.28);
    ctx.setLineDash([6 * px, 6 * px]);

    for (let i = 0; i < world.fields.length; i++) {
        const field = world.fields[i];
        if (field.ore <= 0 && field.rocks <= 0) continue;

        ctx.beginPath();
        ctx.arc(field.x, field.y, FIELD_SCATTER, 0, TAU);
        ctx.stroke();

        // Field center crosshair
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(field.x - 4 * px, field.y);
        ctx.lineTo(field.x + 4 * px, field.y);
        ctx.moveTo(field.x, field.y - 4 * px);
        ctx.lineTo(field.x, field.y + 4 * px);
        ctx.stroke();
        ctx.setLineDash([6 * px, 6 * px]);
    }
    ctx.setLineDash([]);
}

/** Miner claim lines to field center and standoff vectors/crosshairs */
function drawMinerGizmos(ctx, world, theme, stage, alpha) {
    const px = stage?.pixel || 1;

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.role !== 'miner') continue;

        const fac = theme.factions[ship.factionId] || theme.factions[0];
        const sx = lerp(ship.prevX, ship.x, alpha);
        const sy = lerp(ship.prevY, ship.y, alpha);

        if (ship.claimId >= 0 && world.fields[ship.claimId]) {
            const field = world.fields[ship.claimId];

            // Claim line: miner -> field center
            ctx.lineWidth = px * 1.2;
            ctx.strokeStyle = rgba(fac.hull, 0.45);
            ctx.setLineDash([4 * px, 4 * px]);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(field.x, field.y);
            ctx.stroke();

            // Standoff point calculation (home-side offset of field)
            const home = world.ship(ship.homeId);
            let standoffX = field.x;
            let standoffY = field.y;
            if (home) {
                const dx = home.x - field.x;
                const dy = home.y - field.y;
                const d = Math.hypot(dx, dy) || 1;
                standoffX = field.x + (dx / d) * MINER_STANDOFF;
                standoffY = field.y + (dy / d) * MINER_STANDOFF;

                // Vector from field center to standoff point
                ctx.lineWidth = px;
                ctx.strokeStyle = rgba(fac.accent, 0.35);
                ctx.setLineDash([2 * px, 2 * px]);
                ctx.beginPath();
                ctx.moveTo(field.x, field.y);
                ctx.lineTo(standoffX, standoffY);
                ctx.stroke();
            }

            // Standoff marker crosshair
            ctx.setLineDash([]);
            ctx.lineWidth = px * 1.5;
            ctx.strokeStyle = rgba(fac.accent, 0.75);
            ctx.beginPath();
            ctx.moveTo(standoffX - 4 * px, standoffY);
            ctx.lineTo(standoffX + 4 * px, standoffY);
            ctx.moveTo(standoffX, standoffY - 4 * px);
            ctx.lineTo(standoffX, standoffY + 4 * px);
            ctx.stroke();
        }
    }
    ctx.setLineDash([]);
}

/** Mining tethers (MINING_RADIUS) around miners and drone berth rings/slots */
function drawMiningTethers(ctx, world, theme, stage, alpha) {
    const px = stage?.pixel || 1;

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.role !== 'miner') continue;

        const fac = theme.factions[ship.factionId] || theme.factions[0];
        const mx = lerp(ship.prevX, ship.x, alpha);
        const my = lerp(ship.prevY, ship.y, alpha);

        // Mining radius circle (250)
        ctx.lineWidth = px;
        ctx.strokeStyle = rgba(fac.accent, 0.22);
        ctx.setLineDash([5 * px, 5 * px]);
        ctx.beginPath();
        ctx.arc(mx, my, MINING_RADIUS, 0, TAU);
        ctx.stroke();

        // Drone berth ring
        const berthDist = ship.radius + DRONE_DOCK_OFFSET;
        ctx.strokeStyle = rgba(fac.plate, 0.4);
        ctx.setLineDash([2 * px, 2 * px]);
        ctx.beginPath();
        ctx.arc(mx, my, berthDist, 0, TAU);
        ctx.stroke();

        // Drone berth slots & links
        ctx.setLineDash([]);
        for (let j = 0; j < world.ships.length; j++) {
            const drone = world.ships[j];
            if (drone.dead || drone.role !== 'drone' || drone.parentId !== ship.id) continue;

            const slot = berth(drone, ship, berthDist);
            const slotX = slot.x;
            const slotY = slot.y;

            // Berth slot dot
            ctx.strokeStyle = rgba(fac.accent, 0.5);
            ctx.lineWidth = px;
            ctx.beginPath();
            ctx.arc(slotX, slotY, 2.5 * px, 0, TAU);
            ctx.stroke();

            // Link line from drone to slot
            const dx = lerp(drone.prevX, drone.x, alpha);
            const dy = lerp(drone.prevY, drone.y, alpha);
            ctx.lineWidth = px * 0.8;
            ctx.strokeStyle = rgba(fac.hull, 0.22);
            ctx.setLineDash([3 * px, 3 * px]);
            ctx.beginPath();
            ctx.moveTo(dx, dy);
            ctx.lineTo(slotX, slotY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
    ctx.setLineDash([]);
}

/** Mothership berth rings and active miner deposit slots */
function drawMothershipBerths(ctx, world, theme, stage, alpha) {
    const px = stage?.pixel || 1;

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.role !== 'mothership') continue;

        const fac = theme.factions[ship.factionId] || theme.factions[0];
        const sx = lerp(ship.prevX, ship.x, alpha);
        const sy = lerp(ship.prevY, ship.y, alpha);

        // Deposit berth ring (radius + 34)
        const depositRadius = ship.radius + 34;
        ctx.lineWidth = px;
        ctx.strokeStyle = rgba(fac.plate, 0.3);
        ctx.setLineDash([4 * px, 4 * px]);
        ctx.beginPath();
        ctx.arc(sx, sy, depositRadius, 0, TAU);
        ctx.stroke();

        // Slots for miners in DEPOSIT state
        ctx.setLineDash([]);
        for (let j = 0; j < world.ships.length; j++) {
            const miner = world.ships[j];
            if (miner.dead || miner.role !== 'miner' || miner.factionId !== ship.factionId) continue;
            if (miner.state === 'deposit' || miner.transferId === ship.id) {
                const slot = berth(miner, ship, depositRadius);
                const slotX = slot.x;
                const slotY = slot.y;
                ctx.strokeStyle = rgba(fac.accent, 0.6);
                ctx.lineWidth = px * 1.5;
                ctx.beginPath();
                ctx.arc(slotX, slotY, 4 * px, 0, TAU);
                ctx.stroke();
            }
        }
    }
    ctx.setLineDash([]);
}

/** Fighter engage leashes, anchor lines, escort links, and target lines */
function drawFighterGizmos(ctx, world, theme, stage, alpha) {
    const px = stage?.pixel || 1;
    const drawnAnchors = new Set();

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.role !== 'fighter') continue;

        const fac = theme.factions[ship.factionId] || theme.factions[0];
        const fx = lerp(ship.prevX, ship.x, alpha);
        const fy = lerp(ship.prevY, ship.y, alpha);

        // Engage Leash circle around anchor
        const anchorKey = `${Math.round(ship.anchorX)},${Math.round(ship.anchorY)}`;
        if (!drawnAnchors.has(anchorKey)) {
            drawnAnchors.add(anchorKey);
            ctx.lineWidth = px;
            ctx.strokeStyle = rgba(fac.weapon, 0.18);
            ctx.setLineDash([8 * px, 8 * px]);
            ctx.beginPath();
            ctx.arc(ship.anchorX, ship.anchorY, ENGAGE_LEASH, 0, TAU);
            ctx.stroke();

            // Anchor center marker
            ctx.setLineDash([]);
            ctx.strokeStyle = rgba(fac.accent, 0.35);
            ctx.beginPath();
            ctx.moveTo(ship.anchorX - 5 * px, ship.anchorY);
            ctx.lineTo(ship.anchorX + 5 * px, ship.anchorY);
            ctx.moveTo(ship.anchorX, ship.anchorY - 5 * px);
            ctx.lineTo(ship.anchorX, ship.anchorY + 5 * px);
            ctx.stroke();
        }

        // Anchor line: fighter -> anchor
        ctx.lineWidth = px * 0.8;
        ctx.strokeStyle = rgba(fac.accent, 0.22);
        ctx.setLineDash([3 * px, 3 * px]);
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(ship.anchorX, ship.anchorY);
        ctx.stroke();

        // Escort line & orbit ring (if escorting a miner)
        if (ship.escortId > 0) {
            const charge = world.ship(ship.escortId);
            if (charge && !charge.dead) {
                const cx = lerp(charge.prevX, charge.x, alpha);
                const cy = lerp(charge.prevY, charge.y, alpha);

                ctx.lineWidth = px * 1.2;
                ctx.strokeStyle = rgba(fac.hull, 0.4);
                ctx.setLineDash([4 * px, 4 * px]);
                ctx.beginPath();
                ctx.moveTo(fx, fy);
                ctx.lineTo(cx, cy);
                ctx.stroke();

                ctx.lineWidth = px * 0.8;
                ctx.strokeStyle = rgba(fac.hull, 0.15);
                ctx.setLineDash([2 * px, 4 * px]);
                ctx.beginPath();
                ctx.arc(cx, cy, ESCORT_RADIUS, 0, TAU);
                ctx.stroke();
            }
        }

        // Target lock line
        if (ship.targetId > 0) {
            const target = world.ship(ship.targetId);
            if (target && !target.dead) {
                const tx = lerp(target.prevX, target.x, alpha);
                const ty = lerp(target.prevY, target.y, alpha);

                ctx.lineWidth = px * 1.2;
                ctx.strokeStyle = rgba(fac.weapon, 0.6);
                ctx.setLineDash([2 * px, 2 * px]);
                ctx.beginPath();
                ctx.moveTo(fx, fy);
                ctx.lineTo(tx, ty);
                ctx.stroke();

                // Target box marker
                ctx.setLineDash([]);
                ctx.lineWidth = px * 1.5;
                ctx.beginPath();
                ctx.strokeRect(tx - 4 * px, ty - 4 * px, 8 * px, 8 * px);
            }
        }
    }
    ctx.setLineDash([]);
}

/** Target lines for non-fighter ships (e.g. Mothership turret target) */
function drawOtherTargetLines(ctx, world, theme, stage, alpha) {
    const px = stage?.pixel || 1;

    for (let i = 0; i < world.ships.length; i++) {
        const ship = world.ships[i];
        if (ship.dead || ship.role === 'fighter' || ship.targetId <= 0) continue;

        const target = world.ship(ship.targetId);
        if (!target || target.dead) continue;

        const fac = theme.factions[ship.factionId] || theme.factions[0];
        const sx = lerp(ship.prevX, ship.x, alpha);
        const sy = lerp(ship.prevY, ship.y, alpha);
        const tx = lerp(target.prevX, target.x, alpha);
        const ty = lerp(target.prevY, target.y, alpha);

        ctx.lineWidth = px;
        ctx.strokeStyle = rgba(fac.weapon, 0.5);
        ctx.setLineDash([2 * px, 2 * px]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx, ty);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

/** Selection reticle with corner brackets and heading tick */
function drawSelectionReticle(ctx, world, theme, stage, alpha, selectedShipId) {
    const ship = world.ship(selectedShipId);
    if (!ship || ship.dead) return;

    const px = stage?.pixel || 1;
    const sx = lerp(ship.prevX, ship.x, alpha);
    const sy = lerp(ship.prevY, ship.y, alpha);
    const r = ship.radius + 6 * px + 2;
    const arm = Math.max(4 * px, r * 0.45);

    ctx.setLineDash([]);
    ctx.lineWidth = px * 1.5;
    ctx.strokeStyle = rgba(theme.hud.text, 0.95);

    ctx.beginPath();
    // Top-left
    ctx.moveTo(sx - r, sy - r + arm); ctx.lineTo(sx - r, sy - r); ctx.lineTo(sx - r + arm, sy - r);
    // Top-right
    ctx.moveTo(sx + r - arm, sy - r); ctx.lineTo(sx + r, sy - r); ctx.lineTo(sx + r, sy - r + arm);
    // Bottom-right
    ctx.moveTo(sx + r, sy + r - arm); ctx.lineTo(sx + r, sy + r); ctx.lineTo(sx + r - arm, sy + r);
    // Bottom-left
    ctx.moveTo(sx - r + arm, sy + r); ctx.lineTo(sx - r, sy + r); ctx.lineTo(sx - r, sy + r - arm);
    ctx.stroke();

    // Heading indicator tick
    const sAngle = lerpAngle(ship.prevAngle, ship.angle, alpha);
    const cos = Math.cos(sAngle);
    const sin = Math.sin(sAngle);
    ctx.strokeStyle = rgba(theme.hud.text, 0.7);
    ctx.beginPath();
    ctx.moveTo(sx + cos * r, sy + sin * r);
    ctx.lineTo(sx + cos * (r + 5 * px), sy + sin * (r + 5 * px));
    ctx.stroke();
}
