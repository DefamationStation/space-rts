// ============================================================
// DEV — FX BENCH
// ============================================================
//
// A tiny headless world containing nothing but two fighters
// shooting at each other and a drone cutting a rock, rendered at
// true scale and magnified, in both light models.
//
// Weapon FX is the highest-value surface in this project and the
// hardest to iterate on inside a live simulation: a burst lasts
// 200 ms, happens wherever the fight happens, and is over before
// you can look at it. This puts one on a bench, on a loop, at a
// size you can actually see.
//
// The rule when using this: judge the *left* column. That is the
// size these effects ship at. Anything that only looks good
// magnified is not finished.

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip, makeAsteroid } from '../src/sim/entities.js';
import { drawScene } from '../src/render/scene.js';
import { THEMES } from '../src/data/themes.js';
import { WORLD_HEIGHT } from '../src/core/constants.js';

const THEME_IDS = Object.keys(THEMES);
let themeIndex = 0;
let playing = true;

const canvas = document.getElementById('bench');
const ctx = canvas.getContext('2d');

const VIEW_W = 560;
const VIEW_H = 300;
const PAD = 20;

/**
 * The scale the game actually renders at: world height fills the
 * viewport, so on a 1400-tall world in a ~900px window one world
 * unit is about 0.64 CSS pixels.
 *
 * The left column uses this and nothing else. A bench that shows
 * effects at 1:1 is quietly lying by about 55%, and effects tuned
 * against that lie come out undersized in the game.
 */
const SHIP_SCALE = 900 / 1400;

/**
 * A stage stand-in. `drawScene` only needs these four fields, and
 * spelling that out here keeps the bench from drifting as the real
 * Stage grows.
 */
const stage = { worldWidth: 0, worldHeight: WORLD_HEIGHT, scale: 1, pixel: 1, offsetX: 0, offsetY: 0 };

// ------------------------------------------------------------
// SCENARIO
// ------------------------------------------------------------

let world;

function build() {
    world = createWorld({ seed: 4242, width: 900 });

    // Clear the generated world; we want a controlled scene.
    world.ships.length = 0;
    world.asteroids.length = 0;
    world.byId.clear();
    world.fields.length = 0;

    // Two fighters in a standing duel, close enough to stay engaged.
    const a = makeShip(world, 'fighter', 0, 300, 380, 0);
    const b = makeShip(world, 'fighter', 1, 620, 420, Math.PI);
    a.fade = b.fade = 1;
    a.homeId = a.id;
    b.homeId = b.id;
    world.addShip(a);
    world.addShip(b);

    // A miner and a drone working a rock, for the mining beam.
    const miner = makeShip(world, 'miner', 0, 300, 760, 0);
    miner.fade = 1;
    miner.homeId = miner.id;
    world.addShip(miner);

    // Ore is topped up every frame in `frame()` rather than set
    // absurdly high here — asteroid radius scales with ore, so a
    // rock with a huge value is a rock the size of the world.
    const rock = makeAsteroid(world, 430, 800, 140);
    rock.fade = 1;
    world.addAsteroid(rock);

    const drone = makeShip(world, 'drone', 0, 380, 780, 0);
    drone.fade = 1;
    drone.parentId = miner.id;
    world.addShip(drone);

    world.rocksDirty = true;
}

// ------------------------------------------------------------
// RENDER
// ------------------------------------------------------------

function panel(theme, ox, oy, zoom, cx, cy) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, VIEW_W, VIEW_H);
    ctx.clip();
    ctx.translate(ox, oy);

    stage.worldWidth = world.width;
    stage.scale = zoom;
    stage.pixel = 1 / zoom;

    // Paint this panel's ground before entering world space; the
    // scene's own device-space clear is suppressed below because it
    // would wipe the other three panels.
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.translate(VIEW_W / 2 - cx * zoom, VIEW_H / 2 - cy * zoom);
    ctx.scale(zoom, zoom);

    drawScene(ctx, world, theme, stage, 1, false);
    ctx.restore();
}

function render() {
    const theme = THEMES[THEME_IDS[themeIndex]];
    const dpr = Math.min(devicePixelRatio || 1, 2);

    const w = PAD * 3 + VIEW_W * 2;
    const h = PAD * 3 + VIEW_H * 2;

    canvas.style.maxWidth = w + 'px';
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = theme.grid;
    ctx.fillRect(0, 0, w, h);

    // Row 1 — the duel. Row 2 — the mining beam.
    panel(theme, PAD, PAD, SHIP_SCALE, 460, 400);
    panel(theme, PAD * 2 + VIEW_W, PAD, 3.4, 460, 400);
    panel(theme, PAD, PAD * 2 + VIEW_H, SHIP_SCALE, 400, 785);
    panel(theme, PAD * 2 + VIEW_W, PAD * 2 + VIEW_H, 3.4, 405, 790);

    const root = document.documentElement.style;
    root.setProperty('--c-ground', theme.ground);
    root.setProperty('--c-grid', theme.grid);
    root.setProperty('--c-hud-text', theme.hud.text);
    root.setProperty('--c-hud-dim', theme.hud.dim);
}

/**
 * Hold the scenario in a steady state so the bench loops forever
 * on the same composition: nobody dies, the rock never runs out,
 * and the miner stays put so its drone keeps working in frame.
 */
function maintain() {
    // Recentre the duel on the panel without disturbing its motion:
    // both fighters are translated by the same offset, so their
    // relative positions, headings and velocities are untouched.
    const duel = world.ships.filter((s) => s.role === 'fighter');
    if (duel.length === 2) {
        const dx = 460 - (duel[0].x + duel[1].x) / 2;
        const dy = 400 - (duel[0].y + duel[1].y) / 2;
        for (const s of duel) {
            s.x += dx; s.y += dy;
            s.prevX += dx; s.prevY += dy;
        }
    }

    for (const s of world.ships) {
        if (s.role === 'fighter') {
            s.hp = s.maxHp;
        } else if (s.role === 'miner') {
            s.x = 300; s.y = 760;
            s.vx = s.vy = 0;
            s.cargo = 0;
        } else if (s.role === 'drone') {
            s.cargo = 0;              // never fills, so it never stops cutting
        }
    }
    for (const rock of world.asteroids) {
        rock.ore = rock.oreMax;
        rock.depleting = false;
        rock.fade = 1;
    }
}

function frame() {
    if (playing) {
        stepWorld(world, 1 / 60);
        maintain();
    }
    render();
    requestAnimationFrame(frame);
}

document.getElementById('theme').addEventListener('click', () => {
    themeIndex = (themeIndex + 1) % THEME_IDS.length;
    render();
});
document.getElementById('play').addEventListener('click', () => { playing = !playing; });

build();
frame();

Object.assign(window, {
    bench: canvas,
    world: () => world,
    setTheme: (id) => { themeIndex = Math.max(0, THEME_IDS.indexOf(id)); render(); },
    step: (n = 1) => { for (let i = 0; i < n; i++) { stepWorld(world, 1 / 60); maintain(); } render(); },
    pause: () => { playing = false; },
    rebuild: build,
});
