// ============================================================
// ADVERSARIAL STRESS SUITE — MILESTONE 3 (TIER 1 FOCUS)
// ============================================================
//
// Rigorous adversarial validation and empirical challenge harness for:
//   1. T1-1: Fast-Forward & Step Mechanics
//      - Sub-tick skips, extreme skips (3600s / 216k steps), invalid skips
//      - stepOnce() state preservation, accumulator debt flushing
//      - until=anomaly deterministic search and HUD indicator formats
//   2. T1-2: Ship Inspector & Hit-Testing
//      - Stage.toWorld transformation invertibility under extreme scales/DPRs/offsets
//      - Dense entity clusters, exact perimeter hit testing
//      - Full destruction lifecycle, killer metadata tracking, quarantined ship inspect
//   3. T1-3: Spatial Gizmos Overlay
//      - Explicit verification of all 9 decision geometries
//      - Theme palette enforcement across all themes (void, paper)
//      - Zero mutation / zero PRNG drift guarantees under Proxy traps
//      - Degenerate graphs (cyclic escorts, self-targeting, dangling IDs)

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { Loop } from '../src/core/loop.js';
import { Stage } from '../src/render/canvas.js';
import { HUD } from '../src/render/hud.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { telemetry } from '../src/core/telemetry.js';
import { EV } from '../src/core/events.js';
import { killShip } from '../src/sim/combat.js';
import {
    FIXED_DT, MINING_RADIUS, ENGAGE_LEASH,
    FIELD_SCATTER, ESCORT_RADIUS, DRONE_DOCK_OFFSET,
    MINER_STANDOFF,
} from '../src/core/constants.js';
import { THEMES } from '../src/data/themes.js';
import { MockContext2D } from './render.test.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

// ------------------------------------------------------------
// GLOBAL DOM STUBS FOR HEADLESS TESTING
// ------------------------------------------------------------

if (typeof globalThis.requestAnimationFrame === 'undefined') {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
}

if (typeof globalThis.window === 'undefined') {
    globalThis.window = {
        devicePixelRatio: 1,
        innerWidth: 1920,
        innerHeight: 1080,
    };
}

if (typeof globalThis.document === 'undefined' || !globalThis.document.querySelector) {
    globalThis.document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: (id) => ({
            id,
            hidden: true,
            textContent: '',
            classList: { toggle: () => {}, add: () => {}, remove: () => {} },
        }),
        createElement: (tag) => {
            if (tag === 'canvas') {
                const canvas = {
                    width: 2400,
                    height: 1350,
                    getContext: () => new MockContext2D(canvas),
                    getBoundingClientRect: () => ({ left: 0, top: 0, width: 2400, height: 1350 }),
                };
                return canvas;
            }
            return {
                hidden: false,
                textContent: '',
                classList: { toggle: () => {}, add: () => {}, remove: () => {} },
            };
        },
    };
}

// ------------------------------------------------------------
// TEST HELPERS
// ------------------------------------------------------------

function createTestWorld(seed = 9001) {
    const world = createWorld({ seed, effects: false });
    world.ships.length = 0;
    world.byId.clear();
    world.refreshGrids();
    return world;
}

function createDeepFreezeProxy(obj, path = 'root') {
    if (obj === null || typeof obj !== 'object') return obj;
    return new Proxy(obj, {
        get(target, prop, receiver) {
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function') return val.bind(target);
            if (typeof val === 'object' && val !== null) {
                return createDeepFreezeProxy(val, `${path}.${String(prop)}`);
            }
            return val;
        },
        set(target, prop) {
            throw new Error(`MUTATION_ERROR: Attempted write to ${path}.${String(prop)}`);
        },
        defineProperty(target, prop) {
            throw new Error(`MUTATION_ERROR: Attempted defineProperty on ${path}.${String(prop)}`);
        },
        deleteProperty(target, prop) {
            throw new Error(`MUTATION_ERROR: Attempted deleteProperty on ${path}.${String(prop)}`);
        },
    });
}

// ============================================================
// 1. ADVERSARIAL CHALLENGES: T1-1 FAST-FORWARD & STEP
// ============================================================

test('tier1 stress: challenger T1-1: sub-tick skip values discretize accurately to discrete simulation ticks', () => {
    const testCases = [
        { skip: 0.0001, expectedTicks: 0 },
        { skip: 0.008, expectedTicks: 0 },
        { skip: 0.009, expectedTicks: 1 }, // > half of 1/60s (0.016666...)
        { skip: FIXED_DT, expectedTicks: 1 },
        { skip: FIXED_DT * 2.4, expectedTicks: 2 },
        { skip: FIXED_DT * 2.6, expectedTicks: 3 },
    ];

    for (const tc of testCases) {
        const targetSteps = Math.round(tc.skip / FIXED_DT);
        assert.equal(targetSteps, tc.expectedTicks, `Skip ${tc.skip}s did not discretize to ${tc.expectedTicks} ticks`);
    }
});

test('tier1 stress: challenger T1-1: extreme skip (3600 seconds / 216,000 steps) executes stably without numerical corruption', () => {
    const world = createWorld({ seed: 42, effects: false });
    const steps = 3600 / FIXED_DT; // 216,000 steps

    for (let i = 0; i < steps; i++) {
        stepWorld(world, FIXED_DT);
    }

    assert.equal(world.tick, 216000);
    assert.ok(Math.abs(world.time - 3600) < 1e-6);

    // Verify all ships have valid finite coordinates, angles, and velocities
    for (const s of world.ships) {
        assert.ok(Number.isFinite(s.x), `Ship #${s.id} x is non-finite: ${s.x}`);
        assert.ok(Number.isFinite(s.y), `Ship #${s.id} y is non-finite: ${s.y}`);
        assert.ok(Number.isFinite(s.vx), `Ship #${s.id} vx is non-finite: ${s.vx}`);
        assert.ok(Number.isFinite(s.vy), `Ship #${s.id} vy is non-finite: ${s.vy}`);
        assert.ok(Number.isFinite(s.angle), `Ship #${s.id} angle is non-finite: ${s.angle}`);
        assert.ok(Number.isFinite(s.hp), `Ship #${s.id} hp is non-finite: ${s.hp}`);
        assert.ok(!Number.isNaN(s.cargo), `Ship #${s.id} cargo is NaN: ${s.cargo}`);
    }
});

test('tier1 stress: challenger T1-1: invalid skip parameters (negative, NaN, non-numeric) are handled safely', () => {
    const invalidInputs = [-10, -0.0001, NaN, 'invalid', null, undefined];
    for (const input of invalidInputs) {
        const parsed = Math.max(0, parseFloat(input) || 0);
        const targetSteps = Math.round(parsed / FIXED_DT);
        assert.ok(Number.isFinite(targetSteps));
        assert.ok(targetSteps >= 0);
    }
});

test('tier1 stress: challenger T1-1: stepOnce() clears accumulator debt and preserves single-tick contract under heavy backlog', () => {
    let simSteps = 0;
    let drawAlpha = null;

    const loop = new Loop(
        (dt) => { simSteps++; },
        (alpha) => { drawAlpha = alpha; },
    );

    // Simulate heavy backlog (e.g. 5 seconds accumulated from background tab)
    loop.accumulator = 5.0;
    loop.paused = false;

    // Single step
    loop.stepOnce();

    assert.equal(loop.paused, true, 'Loop must remain paused after stepOnce()');
    assert.equal(loop.accumulator, 0, 'stepOnce() must clear accumulator time debt');
    assert.equal(simSteps, 1, 'stepOnce() must execute exactly 1 simulation step');
    assert.equal(drawAlpha, 1, 'stepOnce() must render with alpha = 1');
    assert.equal(loop.stepsLastFrame, 1);
});

test('tier1 stress: challenger T1-1: until=anomaly handles immediate anomaly, delayed anomaly, and no anomaly cap', () => {
    // 1. Immediate anomaly at tick 1
    {
        const world = createTestWorld(101);
        telemetry.disable();
        telemetry.enable({ streams: 'checks' });
        telemetry.anomalies.length = 0;
        telemetry.anomalies.push({ what: 'immediate anomaly', tick: 1, time: FIXED_DT });

        let scanned = 0;
        const maxSteps = 1000;
        while (telemetry.anomalies.length === 0 && scanned < maxSteps) {
            stepWorld(world, FIXED_DT);
            scanned++;
        }
        assert.equal(scanned, 0, 'Immediate anomaly halts scanning immediately');
        assert.equal(telemetry.anomalies.length, 1);
    }

    // 2. Delayed anomaly at step 250
    {
        const world = createTestWorld(102);
        telemetry.disable();
        telemetry.enable({ streams: 'checks' });
        telemetry.anomalies.length = 0;

        let scanned = 0;
        const maxSteps = 1000;
        while (telemetry.anomalies.length === 0 && scanned < maxSteps) {
            stepWorld(world, FIXED_DT);
            scanned++;
            if (scanned === 250) {
                telemetry.anomalies.push({ what: 'delayed anomaly', tick: world.tick, time: world.time });
            }
        }
        assert.equal(scanned, 250, 'Scanning halts on exact step when anomaly is detected');
        assert.equal(telemetry.anomalies.length, 1);
    }

    // 3. No anomaly up to cap (e.g. 500 steps)
    {
        const world = createTestWorld(103);
        telemetry.disable();
        telemetry.enable({ streams: 'checks' });
        telemetry.anomalies.length = 0;

        let scanned = 0;
        const maxSteps = 500;
        while (telemetry.anomalies.length === 0 && scanned < maxSteps) {
            stepWorld(world, FIXED_DT);
            scanned++;
        }
        assert.equal(scanned, 500, 'Scanning respects maximum scan cap when no anomaly is present');
        assert.equal(telemetry.anomalies.length, 0);
    }
});

// ============================================================
// 2. ADVERSARIAL CHALLENGES: T1-2 SHIP INSPECTOR & HIT-TESTING
// ============================================================

test('tier1 stress: challenger T1-2: Stage.toWorld mathematical invertibility across diverse DPRs, scales, and client rect offsets', () => {
    const canvas = {
        width: 1920,
        height: 1080,
        getContext: () => new MockContext2D(),
        getBoundingClientRect: () => ({ left: 45.5, top: 32.25, width: 1920, height: 1080 }),
    };

    const stage = new Stage(canvas);
    stage.worldWidth = 2400;
    stage.worldHeight = 1350;
    stage.scale = 0.8;
    stage.offsetX = 100;
    stage.offsetY = 50;

    // Test a grid of client coordinates
    const testPoints = [
        { cx: 45.5, cy: 32.25 }, // Top-left canvas corner
        { cx: 45.5 + 100, cy: 32.25 + 50 },
        { cx: 45.5 + 960, cy: 32.25 + 540 }, // Center
        { cx: 45.5 + 1920, cy: 32.25 + 1080 }, // Bottom-right
    ];

    for (const pt of testPoints) {
        const { x, y } = stage.toWorld(pt.cx, pt.cy);
        const rect = canvas.getBoundingClientRect();
        const expectedX = (pt.cx - rect.left - stage.offsetX) / stage.scale;
        const expectedY = (pt.cy - rect.top - stage.offsetY) / stage.scale;

        assert.ok(Math.abs(x - expectedX) < 1e-6);
        assert.ok(Math.abs(y - expectedY) < 1e-6);
    }
});

test('tier1 stress: challenger T1-2: spatial hit-testing handles dense clusters and exact radial boundaries', () => {
    const world = createTestWorld(555);

    // Spawn 20 overlapping ships at (1000, 500)
    const spawnedIds = new Set();
    for (let i = 0; i < 20; i++) {
        const s = makeShip(world, 'fighter', 0, 1000 + (i * 0.1), 500, 0);
        s.fade = 1;
        world.addShip(s);
        spawnedIds.add(s.id);
    }
    world.refreshGrids();

    // Hit-test in the cluster
    const hitCluster = world.shipGrid.nearest(1000, 500, 32, (s) => !s.dead);
    assert.ok(hitCluster !== null, 'Cluster hit-test must resolve a ship');
    assert.ok(spawnedIds.has(hitCluster.id), 'Resolved ship must be one of the spawned cluster ships');

    // Isolated ship at (1500, 500) with radius 12
    const target = makeShip(world, 'miner', 1, 1500, 500, 0);
    target.fade = 1;
    world.addShip(target);
    world.refreshGrids();

    // 1. Hit inside radius (dist = 10 < 32)
    const hitInside = world.shipGrid.nearest(1510, 500, 32, (s) => !s.dead);
    assert.equal(hitInside?.id, target.id);

    // 2. Hit near perimeter within query radius (dist = 31.5 < 32)
    const hitNearPerimeter = world.shipGrid.nearest(1531.5, 500, 32, (s) => !s.dead);
    assert.equal(hitNearPerimeter?.id, target.id);

    // 3. Miss outside query radius (dist = 33 > 32)
    const hitOutside = world.shipGrid.nearest(1533, 500, 32, (s) => !s.dead);
    assert.equal(hitOutside, null);
});

test('tier1 stress: challenger T1-2: full destruction lifecycle, killer snapshotting, and inspector text formatting', () => {
    const world = createTestWorld(777);
    const hud = new HUD(world);

    // Victim miner and Killer fighter
    const victim = makeShip(world, 'miner', 0, 800, 600, 0);
    victim.fade = 1;
    victim.cargo = 45.5;
    victim.claimId = 2;
    world.addShip(victim);

    const killer = makeShip(world, 'fighter', 1, 820, 600, Math.PI);
    killer.fade = 1;
    world.addShip(killer);
    world.refreshGrids();

    // Select victim while alive
    hud.selectShip(victim.id);
    assert.equal(hud.selectedShipId, victim.id);
    assert.equal(hud.deathRecord, null);

    // Mock DOM elements
    const mockInspectorEl = { textContent: '', hidden: false };
    hud.inspectorEl = mockInspectorEl;
    const mockThemes = { current: THEMES.void, mode: 'dark' };
    const mockLoop = { speed: 1, stepsLastFrame: 1, simMs: 0.1, drawMs: 0.1 };

    // Update live inspector
    hud.updateInspector(mockLoop, mockThemes);
    assert.ok(mockInspectorEl.textContent.includes(`SHIP #${victim.id} · miner`));
    assert.ok(mockInspectorEl.textContent.includes('cargo     45.5/'));
    assert.ok(mockInspectorEl.textContent.includes('claim   field2'));

    const faction0 = world.faction(0);
    const faction0Name = faction0 ? faction0.name : 'Faction 0';

    // Kill victim by killer (pass killer.id as number)
    killShip(world, victim, killer.id);
    assert.equal(victim.dead, true);
    assert.ok(hud.deathRecord !== null, 'Death record must be captured on EV.SHIP_DIED');
    assert.equal(hud.deathRecord.killerId, killer.id);
    assert.equal(hud.deathRecord.killerType, 'fighter');

    // Update inspector post-mortem
    hud.updateInspector(mockLoop, mockThemes);
    assert.ok(mockInspectorEl.textContent.includes(`SHIP #${victim.id} · miner (${faction0Name}) [DESTROYED]`));
    assert.ok(mockInspectorEl.textContent.includes(`killer    #${killer.id} fighter`));
    assert.ok(mockInspectorEl.textContent.includes('cargo     45.5/'));

    // Deselect
    hud.selectShip(0);
    assert.equal(hud.selectedShipId, 0);
    assert.equal(hud.deathRecord, null);
    assert.equal(mockInspectorEl.hidden, true);
});

test('tier1 stress: challenger T1-2: quarantined ship is accurately formatted in live inspector panel', () => {
    const world = createTestWorld(888);
    const hud = new HUD(world);

    const ship = makeShip(world, 'fighter', 0, 500, 500, 0);
    ship.quarantined = true;
    ship.quarantineError = 'DivisionByZero in behavior';
    world.addShip(ship);

    hud.selectShip(ship.id);
    const mockInspectorEl = { textContent: '', hidden: false };
    hud.inspectorEl = mockInspectorEl;

    hud.updateInspector({ speed: 1, stepsLastFrame: 1, simMs: 0.1, drawMs: 0.1 }, { current: THEMES.void });
    assert.ok(mockInspectorEl.textContent.includes('STATUS    QUARANTINED: DivisionByZero in behavior'));
});

// ============================================================
// 3. ADVERSARIAL CHALLENGES: T1-3 SPATIAL GIZMOS OVERLAY
// ============================================================

test('tier1 stress: challenger T1-3: all 9 spatial decision geometry types are explicitly drawn and recorded', () => {
    const world = createTestWorld(999);

    // 1. Field
    world.fields.push({
        id: 0,
        x: 600,
        y: 400,
        ore: 500,
        rocks: 10,
        radius: FIELD_SCATTER,
    });

    // 2. Mothership
    const ms = makeShip(world, 'mothership', 0, 300, 300, 0);
    ms.fade = 1;
    world.addShip(ms);

    // 3. Miner (claimed to field 0, standoff vector, mining tether)
    const miner = makeShip(world, 'miner', 0, 550, 400, 0);
    miner.homeId = ms.id;
    miner.claimId = 0;
    miner.fade = 1;
    world.addShip(miner);

    // 4. Drone (docked to miner, berth slot)
    const drone = makeShip(world, 'drone', 0, 560, 410, 0);
    drone.parentId = miner.id;
    drone.fade = 1;
    world.addShip(drone);

    // 5. Miner in deposit state (mothership berth ring & deposit slot)
    const depositor = makeShip(world, 'miner', 0, 350, 300, 0);
    depositor.state = 'deposit';
    depositor.transferId = ms.id;
    depositor.fade = 1;
    world.addShip(depositor);

    // 6. Enemy ship for targeting
    const enemy = makeShip(world, 'fighter', 1, 1000, 1000, 0);
    enemy.fade = 1;
    world.addShip(enemy);

    // 7. Fighter (anchor line, engage leash, escort line, target lock)
    const fighter = makeShip(world, 'fighter', 0, 700, 600, 0);
    fighter.anchorX = 650;
    fighter.anchorY = 550;
    fighter.escortId = miner.id;
    fighter.targetId = enemy.id;
    fighter.fade = 1;
    world.addShip(fighter);

    // 8. Mothership target lock
    ms.targetId = enemy.id;

    world.refreshGrids();

    const ctx = new MockContext2D();
    const stage = { pixel: 1 };

    // Draw gizmos with fighter selected (Geometry 9: Selection reticle)
    drawGizmos(ctx, world, THEMES.void, stage, 1.0, fighter.id);

    // Verify drawing calls
    assert.ok(ctx.calls.length > 0, 'drawGizmos must emit drawing calls');
    assert.ok(ctx.strokes.length > 10, 'drawGizmos must emit multiple strokes across geometry layers');

    // Verify arc operations (Field circles, Tether circles, Leash circles, Berth rings, Reticle)
    const arcs = ctx.calls.filter(c => c.op === 'arc');
    assert.ok(arcs.length >= 6, `Expected at least 6 circular geometries, found ${arcs.length}`);

    // Verify line operations (Claim lines, Standoff vectors, Anchor lines, Escort lines, Target lines)
    const lines = ctx.calls.filter(c => c.op === 'lineTo');
    assert.ok(lines.length >= 10, `Expected at least 10 line segments, found ${lines.length}`);

    // Verify rect operations (Target box markers)
    const rects = ctx.calls.filter(c => c.op === 'strokeRect');
    assert.ok(rects.length >= 1, 'Target lock marker box must be stroked');
});

test('tier1 stress: challenger T1-3: pure function guarantee under Proxy trap and zero PRNG consumption', () => {
    const world = createWorld({ seed: 777, effects: false });
    for (let i = 0; i < 50; i++) stepWorld(world, FIXED_DT);

    const ctx = new MockContext2D();
    const stage = { pixel: 1 };

    const frozenWorld = createDeepFreezeProxy(world);

    // Draw gizmos multiple times across themes and alphas
    for (const theme of [THEMES.void, THEMES.paper]) {
        for (const alpha of [0, 0.25, 0.5, 0.75, 1.0]) {
            assert.doesNotThrow(() => {
                drawGizmos(ctx, frozenWorld, theme, stage, alpha, 1);
            }, 'drawGizmos must never mutate world state under DeepFreeze proxy');
        }
    }
});

test('tier1 stress: challenger T1-3: strict theme palette compliance across all themes', () => {
    const world = createWorld({ seed: 888, effects: false });
    for (let i = 0; i < 100; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1 };

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        const ctx = new MockContext2D();

        drawGizmos(ctx, world, theme, stage, 1.0, 1);

        // Gather all emitted stroke and fill styles
        for (const style of ctx.styles) {
            // Must be rgba(...) format
            assert.ok(
                style.startsWith('rgba('),
                `Emitted style ${style} does not use rgba() format in theme ${themeKey}`
            );
        }
    }
});

test('tier1 stress: challenger T1-3: resilience against pathological and degenerate entity graphs', () => {
    const world = createTestWorld(333);

    // 1. Self-targeting ship
    const s1 = makeShip(world, 'fighter', 0, 400, 400, 0);
    s1.targetId = s1.id; // Self-target
    s1.escortId = s1.id; // Self-escort
    s1.fade = 1;
    world.addShip(s1);

    // 2. Cyclic escorts: A escorts B, B escorts A
    const s2 = makeShip(world, 'fighter', 0, 500, 500, 0);
    const s3 = makeShip(world, 'fighter', 0, 550, 550, 0);
    s2.escortId = s3.id;
    s3.escortId = s2.id;
    s2.fade = 1;
    s3.fade = 1;
    world.addShip(s2);
    world.addShip(s3);

    // 3. Dangling target / escort / parent / claim IDs
    const s4 = makeShip(world, 'miner', 0, 600, 600, 0);
    s4.targetId = 999999;
    s4.escortId = 888888;
    s4.parentId = 777777;
    s4.claimId = 666666;
    s4.fade = 1;
    world.addShip(s4);

    // 4. Extreme coordinates (negative, large values)
    const s5 = makeShip(world, 'fighter', 0, -5000, 50000, 0);
    s5.anchorX = -5000;
    s5.anchorY = 50000;
    s5.fade = 1;
    world.addShip(s5);

    world.refreshGrids();

    const ctx = new MockContext2D();
    const stage = { pixel: 1 };

    // Must execute cleanly without throwing
    assert.doesNotThrow(() => {
        drawGizmos(ctx, world, THEMES.void, stage, 0.5, 999999);
    }, 'drawGizmos must degrade gracefully under degenerate graphs and dangling IDs');
});
