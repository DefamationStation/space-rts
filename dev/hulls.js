// ============================================================
// DEV — HULL SHEET
// ============================================================
//
// Draws every hull large, in both themes, in three conditions.
// Development tooling, not part of the game: nothing in `src/`
// imports this.
//
// It exists because judging ship art inside a live simulation is
// nearly impossible — the ships are twelve pixels across, moving,
// and usually somewhere else. This puts them still, large, side by
// side, and under both light models at once, which is the only way
// to see whether the silhouette grammar in `render/hulls.js` is
// actually holding together.
//
// The bottom row is the important one. It fills each hull solid
// and drops the accent and plate slots entirely. If you cannot
// name a class from its silhouette alone, no amount of detail will
// save it — go and change the outline.

import { HULL_RENDERERS } from '../src/render/hulls.js';
import { SHIP_TYPES } from '../src/data/ships.js';
import { THEMES } from '../src/data/themes.js';
import { GRID_SPACING } from '../src/core/constants.js';
import { TAU } from '../src/core/math.js';

const ORDER = ['drone', 'fighter', 'miner', 'mothership'];
const MAX_SCALE = 7;
const CELL_W = 230;
const CELL_H = 200;
const PAD = 26;

/**
 * Scale each class to fill its cell rather than using one factor
 * for all of them. The scale ladder spans nearly an order of
 * magnitude — a drone is 4.5 units and a mothership 40 — so a
 * shared scale either shrinks the drone to nothing or bursts the
 * mothership out of the sheet.
 */
const scaleFor = (radius) => Math.min(MAX_SCALE, (Math.min(CELL_W, CELL_H) - 46) / (2 * radius));

const canvas = document.getElementById('sheet');
const ctx = canvas.getContext('2d');

let themeIndex = 0;
let showGrid = true;

const THEME_IDS = Object.keys(THEMES);

/**
 * A stand-in ship. Real ships carry ~40 fields; the renderers only
 * read a handful, and spelling out exactly which ones keeps this
 * sheet honest about the contract a hull renderer may rely on.
 */
function mockShip(type, factionId, { hp = 1, cargo = 1, spin = 0.4 } = {}) {
    const def = SHIP_TYPES[type];
    return {
        type,
        role: def.role,
        def,
        factionId,
        radius: def.radius,
        maxHp: def.hp,
        hp: def.hp * hp,
        cargo: def.cargo * cargo,
        cargoMax: def.cargo,
        spin,
        bank: 0,
        recoil: 0,
        fade: 1,
        buildType: null,
        buildDoneAt: -1,
    };
}

function drawCell(theme, x, y, ship, { silhouette = false } = {}) {
    ctx.save();
    ctx.translate(x, y);

    if (showGrid && !silhouette) {
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const step = (GRID_SPACING / 100) * 24;
        for (let g = -CELL_W / 2; g <= CELL_W / 2; g += step) {
            ctx.moveTo(g, -CELL_H / 2); ctx.lineTo(g, CELL_H / 2);
            ctx.moveTo(-CELL_W / 2, g); ctx.lineTo(CELL_W / 2, g);
        }
        ctx.stroke();
    }

    const s = scaleFor(ship.radius);
    ctx.scale(s, s);

    if (silhouette) {
        // Flatten every material slot to one colour. `filter` is the
        // cheapest way to do that without a second set of renderers,
        // and this is dev tooling, so the cost does not matter.
        ctx.save();
        ctx.filter = 'grayscale(1) brightness(0)';
        HULL_RENDERERS[ship.type](ctx, ship, silhouettePalette(theme), theme);
        ctx.restore();
    } else {
        HULL_RENDERERS[ship.type](ctx, ship, theme.factions[ship.factionId], theme);
    }

    ctx.restore();
}

/** One flat colour in every slot, for the silhouette row. */
function silhouettePalette(theme) {
    const ink = theme.id === 'paper' ? theme.factions[0].accent : theme.factions[0].hull;
    return { plate: ink, hull: ink, accent: ink, weapon: ink, flash: ink, thruster: ink };
}

function render() {
    const theme = THEMES[THEME_IDS[themeIndex]];
    const dpr = Math.min(devicePixelRatio || 1, 2);

    const cols = ORDER.length;
    const rows = 3;
    const w = PAD * 2 + cols * CELL_W;
    const h = PAD * 2 + rows * CELL_H;

    canvas.style.maxWidth = w + 'px';
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, w, h);

    for (let c = 0; c < cols; c++) {
        const type = ORDER[c];
        const cx = PAD + CELL_W * c + CELL_W / 2;

        // Row 1 — intact, faction 0 and 1 side by side for the big
        // hulls, single for the small ones.
        drawCell(theme, cx, PAD + CELL_H * 0.5,
            mockShip(type, c % 2, { hp: 1, cargo: type === 'miner' ? 0.62 : 1 }));

        // Row 2 — damaged, and a laden miner.
        drawCell(theme, cx, PAD + CELL_H * 1.5,
            mockShip(type, (c + 1) % 2, { hp: 0.28, cargo: 1, spin: 1.2 }));

        // Row 3 — silhouette test.
        drawCell(theme, cx, PAD + CELL_H * 2.5,
            mockShip(type, 0, { hp: 1, cargo: 1, spin: 2.1 }), { silhouette: true });

        ctx.fillStyle = theme.hud.dim;
        ctx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(type.toUpperCase() + '  r' + SHIP_TYPES[type].radius
            + '  ·  ' + scaleFor(SHIP_TYPES[type].radius).toFixed(1) + '×',
            cx, PAD + CELL_H * 3 - 8);
    }

    document.documentElement.style.setProperty('--c-ground', theme.ground);
    document.documentElement.style.setProperty('--c-grid', theme.grid);
    document.documentElement.style.setProperty('--c-hud-text', theme.hud.text);
    document.documentElement.style.setProperty('--c-hud-dim', theme.hud.dim);
}

document.getElementById('theme').addEventListener('click', () => {
    themeIndex = (themeIndex + 1) % THEME_IDS.length;
    render();
});
document.getElementById('grid').addEventListener('click', () => {
    showGrid = !showGrid;
    render();
});

addEventListener('resize', render);
render();

// Console hooks for automated capture during development.
Object.assign(window, {
    setTheme: (id) => { themeIndex = Math.max(0, THEME_IDS.indexOf(id)); render(); },
    sheet: canvas,
    TAU,
});
