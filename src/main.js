// ============================================================
// MAIN — WIRE-UP
// ============================================================
//
// Assembles the pieces and owns nothing. Simulation state lives in
// `core/world.js`, drawing lives in `render/`, and this file exists
// only to introduce them to each other and start the loop.
//
// ------------------------------------------------------------
// CONTROLS
// ------------------------------------------------------------
//   space         pause
//   . / N         step single tick when paused
//   G             toggle decision gizmos overlay
//   esc           deselect inspected ship
//   T             cycle theme: auto → void → paper
//   F / home      frame the whole map
//   1..4          simulation speed
//
//   left click    select the hull under the cursor
//   left drag     marquee-select
//   right drag    pan the map, 1:1 with the cursor
//   right click   deselect
//   wheel         zoom about the cursor
//
// All of the above, plus camera-follow, a HUD toggle and a
// copy-this-moment link, are also in the controls panel behind the
// button in the bottom-right corner. See render/controls.js — the
// panel exists to make the bindings discoverable, not to replace
// them, so every row names its key.
//
// ------------------------------------------------------------
// QUERY PARAMETERS
// ------------------------------------------------------------
//   ?seed=12345       reproduce a run exactly
//   ?debug=1          perf and state overlay
//   ?debug=2          spatial decision gizmos overlay
//   ?skip=N           fast-forward N seconds before first paint
//   ?until=anomaly    fast-forward until first anomaly tick
//   ?telemetry=1      record the flight recorder to window.telemetry
//
// With ?telemetry=1, what gets recorded is switchable on two axes —
// which streams, and which ships:
//
//   ?motion=0                    behaviour and events, not per-step physics
//   ?streams=states,events       exactly those; anything unnamed is off
//   ?role=fighter,gunship        only these roles
//   ?type=gunship                only this hull class, whatever its role
//   ?faction=0                   only one side
//   ?watch=42,43                 only these ships
//   ?every=3                     one motion row in three steps
//
// Working on one hull class, the useful shape is
// `?telemetry=1&motion=0&type=gunship,fighter` — the class and
// whatever it interacts with, without the rest of the map.

import { Stage } from './render/canvas.js';
import { ThemeManager } from './render/theme.js';
import { drawScene } from './render/scene.js';
import { HUD } from './render/hud.js';
import { Controls } from './render/controls.js';
import { Loop } from './core/loop.js';
import { FIXED_DT } from './core/constants.js';
import { seedFromLocation } from './core/rng.js';
import { telemetry } from './core/telemetry.js';
import { createWorld, stepWorld } from './sim/simulate.js';
import { makeShip } from './sim/entities.js';
import { killShip } from './sim/combat.js';
import { triggerIncursion } from './sim/incursion.js';
import { FACTIONS } from './data/factions.js';
import { WARP_SPEED } from './core/constants.js';
import { EV } from './core/events.js';

const params = new URLSearchParams(location.search);
const seed = seedFromLocation(location.search);
const debugParam = params.get('debug');
const debugLevel = parseInt(debugParam || '0', 10);
/**
 * Overlay and camera state the controls panel reflects and mutates.
 *
 * One object rather than four loose `let`s because the panel needs a
 * live handle on all of it — passing values would hand it a snapshot
 * that goes stale the moment a keyboard shortcut is used.
 */
const flags = {
    gizmos: debugLevel >= 2,
    debug: debugLevel >= 1,
    hudHidden: false,
    follow: false,
    /** Which faction the sandbox spawn buttons build for. */
    spawnSide: 0,
    /** Hulls in a manually triggered incursion; 0 means use the schedule. */
    waveSize: 0,
};
let selectedShipId = 0;
/** @type {number[]} — the full selection; length 0 or 1 mirrors selectedShipId. */
let selectedIds = [];

const stage = new Stage(document.getElementById('stage'));
const themes = new ThemeManager();
stage.resize();

// ------------------------------------------------------------
// NOTHING SIMULATES UNTIL THE WORLD IS THE RIGHT SIZE
// ------------------------------------------------------------
//
// World *width* follows the viewport aspect, so the world cannot be
// built until the canvas has a real box. At script time it often does
// not have one — a tab restored in the background, a pane that is not
// composited yet, a stylesheet still landing — and `stage.resize()`
// falls back to `window.innerWidth`, which yields a plausible and
// wrong width. The `ResizeObserver` then silently reshapes the world
// once layout settles.
//
// For a live run that cost a few mis-sized frames. For `?skip=` it
// cost the whole point of the feature: the fast-forward ran its
// entire seven minutes in a world of the wrong width, and the state
// it landed on was not the state that seed produces. It reproduced
// exactly — `createWorld(2489) → 25200 steps → resize(3106)` — and it
// silently invalidated the one guarantee the fast-forward makes.
//
// So boot is deferred until the first real measurement. In a normal
// tab that is the same turn and nothing is delayed; in every other
// case it is the difference between a reproducible run and a
// mysterious one.

/** @type {ReturnType<typeof boot>|null} */
let app = null;

// The world no longer reshapes itself to the viewport — it is a fixed
// 7200×4200 and this only re-measures the window onto it. What is
// left of the original reason to defer boot still holds for `?skip=`:
// the fast-forward runs before the first paint, and it should run
// against a stage that has been measured, so the camera it lands with
// is the one the viewer sees.
const observer = new ResizeObserver(() => {
    const reshaped = stage.resize();
    if (!app) {
        if (stage.measured) app = boot();
        return;
    }
    // The world follows the glass, so a resized window is a reshaped
    // battlefield — the simulation's bounds have to move with it or
    // ships would steer against a wall that is no longer there.
    if (reshaped) app.world.resize(stage.worldWidth, stage.worldHeight);
});
observer.observe(stage.canvas);

if (stage.measured) app = boot();

function boot() {
    // An explicit `?w=` wins over the display, so a shared link lands
    // on the geography it promised whatever it is opened on.
    const linkWidth = parseInt(params.get('w') || '', 10);
    const world = createWorld({
        seed,
        width: Number.isFinite(linkWidth) && linkWidth > 0 ? linkWidth : stage.worldWidth,
    });
    const hud = new HUD(world, { debug: flags.debug });

    const controls = new Controls({
        loop: null, themes, stage, world, flags,
        // The sandbox. Everything here mutates a live world on purpose
        // — it exists so a change to how something *looks* can be put
        // on screen in two seconds instead of by waiting eight minutes
        // for a run to produce one naturally.
        actions: {
            setDebug: (on) => { flags.debug = on; hud.setDebug(on); },
            selectedId: () => selectedShipId,

            spawn: (type, factionId, x, y) => {
                // Scattered a little, so pressing a button four times
                // gives you a group rather than a stack fighting its
                // own separation force.
                const ship = makeShip(world, type, factionId,
                    x + world.rng.spread(90), y + world.rng.spread(90),
                    world.rng.angle());
                ship.homeId = world.factions[factionId]?.motherships[0] || 0;
                ship.fade = 1;
                world.addShip(ship);
                return ship.id;
            },

            healSelected: () => {
                let n = 0;
                for (const id of selectedIds.length ? selectedIds : [selectedShipId]) {
                    const s = world.byId.get(id);
                    if (!s || s.dead) continue;
                    s.hp = s.maxHp;
                    n++;
                }
                return n;
            },

            killSelected: () => {
                let n = 0;
                for (const id of selectedIds.length ? selectedIds : [selectedShipId]) {
                    const s = world.byId.get(id);
                    if (!s || s.dead) continue;
                    killShip(world, s, 0);
                    n++;
                }
                return n;
            },

            /** Which faction id the swarm is, for the alien spawn buttons. */
            swarmFaction: () => FACTIONS.find((f) => f.alien)?.id ?? 0,

            // Bring a wave in where the camera is looking. An
            // incursion happens twice in twenty minutes, which is an
            // impossible cadence to iterate an *effect* against.
            incursion: (x, y, size) => triggerIncursion(world, x, y, size || 0),

            // Re-run the arrival on hulls that already exist, so the
            // warp-in can be watched over and over without waiting for
            // a wave — the single most useful thing for tuning it.
            warpSelected: () => {
                let n = 0;
                for (const id of selectedIds.length ? selectedIds : [selectedShipId]) {
                    const s = world.byId.get(id);
                    if (!s || s.dead || s.def.immobile) continue;
                    s.warpT = 1;
                    const speed = s.def.speed * WARP_SPEED;
                    s.vx = Math.cos(s.angle) * speed;
                    s.vy = Math.sin(s.angle) * speed;
                    world.events.emit(EV.WARP_IN, { ship: s, x: s.x, y: s.y, angle: s.angle });
                    n++;
                }
                return n;
            },

            // Force the ceasefire on or off. Otherwise it is only
            // observable by waiting for a swarm to turn up and die.
            toggleTruce: () => {
                world.truce = !world.truce;
                // Hold it: `stepIncursion` recomputes this every step
                // from whether aliens are alive, so a forced truce has
                // to move the clock it is derived from.
                world.lastAlienAt = world.truce ? world.time : -1e9;
                return world.truce;
            },

            // Put both sides on war footing, to watch the subsidy work
            // without spending a hundred seconds at zero warships.
            mobilise: () => {
                let n = 0;
                for (const f of world.factions) {
                    if (f.alien) continue;
                    f.mobilised = true;
                    f.barrenSince = world.time - 999;
                    n++;
                }
                return n;
            },

            grantMetal: (amount) => {
                for (const f of world.factions) if (!f.alien) f.metal += amount;
            },

            // Everything mobile, leaving the stations and the rocks —
            // an empty arena to put a controlled scene into.
            clearShips: () => {
                let n = 0;
                for (const s of world.ships) {
                    if (s.dead || s.def.immobile) continue;
                    s.dead = true;
                    n++;
                }
                world.compact();
                select(0);
                return n;
            },
        },
    });

    const loop = new Loop(
        (dt) => stepWorld(world, dt),
        (alpha) => {
            // Camera follow, before the transform is taken. A followed
            // hull that dies releases the lock rather than freezing the
            // view on the last place it was — an unexplained stuck
            // camera reads as a bug.
            if (flags.follow) {
                const target = world.byId.get(selectedShipId);
                if (target && !target.dead) {
                    stage.camX = target.x;
                    stage.camY = target.y;
                    stage.applyCamera();
                } else {
                    flags.follow = false;
                }
            }
            stage.begin();
            drawScene(stage.ctx, world, themes.current, stage, alpha, true, {
                debugLevel: flags.gizmos ? 2 : debugLevel,
                gizmos: flags.gizmos,
                selectedShipId,
                selectedIds,
            });
            hud.update(loop, themes);
            controls.sync();
        },
    );
    controls.ctx.loop = loop;

    if (flags.hudHidden) document.body.classList.add('hud-hidden');

    // Open on the whole map.
    //
    // It used to start at zoom 1, which is a hull's-eye view of one
    // corner of a world nine times that size — you arrived already
    // lost, with no way to know there was anything else. The first
    // thing a viewer should see is the shape of the place.
    stage.fitAll();

    startRecording();
    // `?until=anomaly` stops *on* the fault, so the loop starts paused
    // — otherwise the thing you skipped to scrolls straight past.
    if (fastForward(world, hud)) loop.paused = true;

    console.log('rts-life  ·  seed=' + seed
        + '  ·  space pause · . / N step · G gizmos · T theme · 1-4 speed');
    loop.start();

    // Console access during development only. Nothing in the project
    // reads these; they exist so a run can be poked at while it plays.
    if (debugLevel >= 1 || params.get('telemetry') === '1') {
        Object.assign(window, { world, stage, loop, hud, themes, stepWorld, drawScene, telemetry });
    }
    if (params.get('telemetry') === '1') logTelemetryHelp();

    return { world, hud, loop };
}

/** Select a ship, or pass 0 to clear. Keeps the three places that care in step. */
function select(id) {
    selectedShipId = id || 0;
    selectedIds = selectedShipId ? [selectedShipId] : [];
    if (app) app.hud.setSelection(selectedIds);
    telemetry.watch(selectedShipId);
}

/**
 * Select many hulls at once.
 *
 * `telemetry.watch` takes a single id and is left pointed at nothing
 * for a multi-selection: watching is a *recording scope*, and quietly
 * narrowing a recording to whichever hull happened to be first in a
 * drag would be a worse answer than not narrowing it at all.
 */
function selectMany(ids) {
    selectedIds = ids;
    selectedShipId = ids.length === 1 ? ids[0] : 0;
    if (app) app.hud.setSelection(ids);
    telemetry.watch(selectedShipId);
}

// ------------------------------------------------------------
// POINTER
// ------------------------------------------------------------
//
//   left click        select the hull under the cursor
//   left drag         marquee — select everything inside it
//   right drag        pan, 1:1 with the cursor
//   right click       deselect
//   wheel             zoom about the cursor
//
// The two right-button gestures are the interesting case, because
// they are the same button and mean opposite things. They are told
// apart by distance: a press and release that never travelled is a
// click, anything further is a drag. Without that threshold a pan
// that happens to end where it started silently clears the selection,
// which reads as the UI losing your work at random.

/** CSS pixels of travel that turn a click into a drag. */
const DRAG_SLOP = 4;

const marqueeEl = document.getElementById('marquee');

/** The gesture in progress, or null. One at a time, by construction. */
let drag = null;

stage.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

stage.canvas.addEventListener('pointerdown', (e) => {
    if (!app || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    stage.canvas.setPointerCapture(e.pointerId);
    drag = {
        button: e.button,
        id: e.pointerId,
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        moved: false,
    };
});

stage.canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;

    if (!drag.moved
        && Math.abs(e.clientX - drag.startX) <= DRAG_SLOP
        && Math.abs(e.clientY - drag.startY) <= DRAG_SLOP) {
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
        return;
    }
    drag.moved = true;

    if (drag.button === 2) {
        stage.panByPixels(e.clientX - drag.lastX, e.clientY - drag.lastY);
    } else {
        showMarquee(drag.startX, drag.startY, e.clientX, e.clientY);
    }

    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
});

stage.canvas.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const g = drag;
    drag = null;
    hideMarquee();
    if (stage.canvas.hasPointerCapture(e.pointerId)) {
        stage.canvas.releasePointerCapture(e.pointerId);
    }
    if (!app) return;

    if (g.button === 2) {
        // A pan is not a deselect. Only a stationary right-click is.
        if (!g.moved) select(0);
        return;
    }

    if (g.moved) selectMany(shipsInBox(g.startX, g.startY, e.clientX, e.clientY));
    else {
        const { x, y } = stage.toWorld(e.clientX, e.clientY);
        // Pick radius in *world* units scales with zoom, so the hull
        // under the cursor is the one you can see under the cursor —
        // a fixed world radius would be an unclickably small target
        // zoomed out and a greedy one zoomed in.
        const pick = 32 / Math.max(stage.zoom, 0.0001);
        const hit = app.world.shipGrid.nearest(x, y, pick, (s) => !s.dead);
        select(hit ? hit.id : 0);
    }
});

stage.canvas.addEventListener('pointercancel', () => {
    drag = null;
    hideMarquee();
});

stage.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Exponential in the wheel delta, so a fast flick and several slow
    // notches covering the same distance land in the same place.
    stage.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
}, { passive: false });

/** Every live hull whose position falls inside the dragged rectangle. */
function shipsInBox(x0, y0, x1, y1) {
    const a = stage.toWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = stage.toWorld(Math.max(x0, x1), Math.max(y0, y1));

    // A linear scan, deliberately. The fleet is tens of hulls, the
    // spatial grid has no rectangle query, and adding one to serve a
    // once-per-drag interaction would be a new indexed code path
    // maintained for something that costs microseconds done plainly.
    const found = [];
    const ships = app.world.ships;
    for (let i = 0; i < ships.length; i++) {
        const s = ships[i];
        if (s.dead) continue;
        if (s.x >= a.x && s.x <= b.x && s.y >= a.y && s.y <= b.y) found.push(s.id);
    }
    return found;
}

function showMarquee(x0, y0, x1, y1) {
    if (!marqueeEl) return;
    marqueeEl.style.left = Math.min(x0, x1) + 'px';
    marqueeEl.style.top = Math.min(y0, y1) + 'px';
    marqueeEl.style.width = Math.abs(x1 - x0) + 'px';
    marqueeEl.style.height = Math.abs(y1 - y0) + 'px';
    marqueeEl.hidden = false;
}

function hideMarquee() {
    if (marqueeEl) marqueeEl.hidden = true;
}

window.addEventListener('keydown', (e) => {
    // Every binding below acts on a running world. Before boot there
    // is nothing to pause, step or select.
    if (!app && e.code !== 'KeyT') return;
    const { loop, hud } = app || {};
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            document.body.classList.toggle('is-paused', loop.togglePause());
            break;
        case 'Period':
        case 'KeyN':
            e.preventDefault();
            loop.stepOnce();
            document.body.classList.add('is-paused');
            break;
        case 'KeyG':
            flags.gizmos = !flags.gizmos;
            break;
        case 'Escape':
            select(0);
            break;
        case 'KeyT':
            themes.cycle();
            break;
        case 'KeyF':
        case 'Home':
            // The way back from being lost. On a map nine times the
            // size of the window, "where am I" is a question the
            // interface has to be able to answer in one keystroke.
            stage.fitAll();
            break;
        case 'Digit1': loop.speed = 0.5; break;
        case 'Digit2': loop.speed = 1; break;
        case 'Digit3': loop.speed = 2; break;
        case 'Digit4': loop.speed = 4; break;
    }
});

// ------------------------------------------------------------
// THE PIECES BOOT CALLS
// ------------------------------------------------------------

/** Switch the recorder on, if the query string asked for it. */
function startRecording() {
    if (params.get('telemetry') !== '1' && params.get('until') !== 'anomaly') return;
    telemetry.enable({
        every: Number(params.get('every')) || 1,
        streams: params.get('streams'),
        motion: params.get('motion') === '0' ? false : undefined,
        role: params.get('role'),
        type: params.get('type'),
        faction: params.get('faction'),
        watch: params.get('watch'),
    });
}

/**
 * Fast-forward before the first paint (T1-1).
 *
 * Runs inside `boot`, which only happens once the canvas has a real
 * box — so the steps below are taken at the world's final width and
 * land on the trajectory that seed actually produces. See the note
 * above `boot`.
 */
function fastForward(world, hud) {
    if (params.get('until') === 'anomaly') {
        if (!telemetry.enabled) telemetry.enable({ streams: 'checks' });
        else telemetry.streams.checks = true;

        const MAX_SCAN_STEPS = 20 * 60 * 60;      // a 20-minute cap
        let scanned = 0;
        while (telemetry.anomalies.length === 0 && scanned < MAX_SCAN_STEPS) {
            stepWorld(world, FIXED_DT);
            scanned++;
        }
        document.body.classList.add('is-paused');
        hud.setAnomaly(telemetry.anomalies.length > 0
            ? { found: true, time: world.time, tick: world.tick, anomaly: telemetry.anomalies[0] }
            : { found: false, time: world.time, tick: world.tick });
        return true;                              // caller pauses the loop
    }

    const skipParam = params.get('skip');
    if (skipParam === null) return false;
    const seconds = Math.max(0, parseFloat(skipParam) || 0);
    if (seconds <= 0) return false;

    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i++) stepWorld(world, FIXED_DT);
    hud.setFastForward({ seconds: world.time, ticks: world.tick });
    return false;
}

function logTelemetryHelp() {
    console.log([
        'telemetry recording · ' + (telemetry.scope() || 'everything'),
        '  scope             · telemetry.only({ type, role, faction }) · telemetry.watch(id)',
        '  streams           · telemetry.streams  · telemetry.status()',
        '  motion            · telemetry.table()   · telemetry.flight()',
        '  behaviour         · telemetry.states()  · telemetry.behaviour() · telemetry.reasons()',
        '  events            · telemetry.events()  · telemetry.economy()',
        '  world             · telemetry.series()  · telemetry.anomalies',
        "  export            · telemetry.save('run.csv', 'states'|'events'|'series'|'motion')",
        '  a whole run at once · node tools/sim.mjs --seeds=1..20 --minutes=10',
    ].join('\n'));
}
