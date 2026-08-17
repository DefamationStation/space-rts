// ============================================================
// ADVERSARIAL STRESS TESTS — MILESTONE 1 TIER 1
// ============================================================
//
// Empirical verification for:
//   1. Loop.prototype.stepOnce() contract, accumulator clearing, and hash parity
//   2. Stage.prototype.toWorld() mathematical roundtrips across scales, offsets, DPRs
//   3. Pre-paint skip (?skip=0, ?skip=60, ?skip=420) hash equivalence vs frame stepping
//   4. Ship selection, destruction lifecycle, killer snapshotting, and no TypeErrors

import test from 'node:test';
import assert from 'node:assert/strict';

import { Loop } from '../src/core/loop.js';
import { Stage } from '../src/render/canvas.js';
import { HUD } from '../src/render/hud.js';
import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { killShip } from '../src/sim/combat.js';
import { FIXED_DT } from '../src/core/constants.js';
import { EV } from '../src/core/events.js';
import { THEMES } from '../src/data/themes.js';

// ------------------------------------------------------------
// GLOBAL DOM & WINDOW STUBS FOR HEADLESS TESTING
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
                    width: 64,
                    height: 64,
                    getContext: () => new MockContext2D(),
                    getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }),
                };
                return canvas;
            }
            return {};
        },
    };
}

// ------------------------------------------------------------
// MOCK HELPERS
// ------------------------------------------------------------

class MockContext2D {
    constructor() {
        this.matrix = [1, 0, 0, 1, 0, 0];
    }
    setTransform(a, b, c, d, e, f) {
        this.matrix = [a, b, c, d, e, f];
    }
}

function createMockStage({ left = 0, top = 0, width = 1920, height = 1080, dpr = 1 } = {}) {
    globalThis.window.devicePixelRatio = dpr;
    globalThis.window.innerWidth = width;
    globalThis.window.innerHeight = height;

    const canvas = {
        width: Math.round(width * dpr),
        height: Math.round(height * dpr),
        getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
        getContext: () => new MockContext2D(),
    };
    const stage = new Stage(canvas);
    return stage;
}

// ------------------------------------------------------------
// 1. LOOP.PROTOTYPE.STEPONCE() EMPIRICAL TESTS
// ------------------------------------------------------------

test('fast-forward: loop.stepOnce advances exactly 1 tick (FIXED_DT), sets paused=true, and resets accumulator=0', () => {
    let steps = 0;
    let draws = 0;
    let lastDt = 0;
    let lastAlpha = null;

    const loop = new Loop(
        (dt) => {
            steps++;
            lastDt = dt;
        },
        (alpha) => {
            draws++;
            lastAlpha = alpha;
        },
    );

    // Initial state
    loop.paused = false;
    loop.accumulator = 0.085; // inject non-zero debt

    loop.stepOnce();

    assert.equal(steps, 1, 'step() should be called exactly once');
    assert.equal(draws, 1, 'draw() should be called exactly once');
    assert.equal(lastDt, FIXED_DT, 'step() should receive exact FIXED_DT');
    assert.equal(lastAlpha, 1, 'draw() should receive alpha = 1');
    assert.equal(loop.paused, true, 'loop must be in paused state');
    assert.equal(loop.accumulator, 0, 'accumulator must be zeroed');
    assert.equal(loop.stepsLastFrame, 1, 'stepsLastFrame must be 1');
    assert.ok(loop.simMs >= 0, 'simMs should be recorded');
    assert.ok(loop.drawMs >= 0, 'drawMs should be recorded');
});

test('fast-forward: loop.stepOnce produces identical world hash as direct stepWorld ticks', () => {
    const seed = 98765;
    const worldA = createWorld({ seed, effects: false });
    const worldB = createWorld({ seed, effects: false });

    const loopB = new Loop(
        (dt) => stepWorld(worldB, dt),
        () => {},
    );

    // Advance World A directly 150 ticks
    for (let i = 0; i < 150; i++) {
        stepWorld(worldA, FIXED_DT);
    }

    // Advance World B via loopB.stepOnce() 150 times
    for (let i = 0; i < 150; i++) {
        loopB.stepOnce();
    }

    assert.equal(worldA.tick, 150);
    assert.equal(worldB.tick, 150);
    assert.equal(worldA.time, worldB.time);
    assert.equal(worldA.hash(), worldB.hash(), 'world hashes diverged between stepOnce and direct stepWorld');
});

test('fast-forward: loop.stepOnce clears massive accumulator debt and prevents catch-up burst on unpause', () => {
    let stepCount = 0;
    const loop = new Loop(
        () => { stepCount++; },
        () => {},
    );

    loop.running = true;
    loop.paused = false;
    loop.accumulator = 0.50; // 30 ticks of accumulated debt

    // User presses single step
    loop.stepOnce();
    assert.equal(stepCount, 1);
    assert.equal(loop.accumulator, 0);
    assert.equal(loop.paused, true);

    // Now simulate normal tick arrival while paused
    loop.lastTime = 1000;
    loop._tick(1000 + 16.66);
    assert.equal(stepCount, 1, 'no extra steps should run while paused');
    assert.equal(loop.accumulator, 0, 'accumulator remains 0 while paused');

    // Unpause
    loop.togglePause();
    assert.equal(loop.paused, false);
    assert.equal(loop.accumulator, 0);

    // Next frame tick with ~16.7ms delta (1 full 60Hz frame)
    loop.lastTime = 1000;
    loop._tick(1016.7);
    assert.equal(stepCount, 2, 'unpausing should execute exactly 1 step without catchup burst');
});

// ------------------------------------------------------------
// 2. STAGE.PROTOTYPE.TOWORLD() EMPIRICAL TESTS
// ------------------------------------------------------------

test('fast-forward: stage.toWorld mathematical bijection across varied scales, offsets, and DPRs', () => {
    const testCases = [
        { left: 0, top: 0, width: 1920, height: 1080, dpr: 1 },
        { left: 45.5, top: 80.2, width: 2560, height: 1440, dpr: 1.5 },
        { left: 100, top: 50, width: 800, height: 600, dpr: 2 },
        { left: 12.3, top: 45.6, width: 1366, height: 768, dpr: 1.25 },
        { left: 0, top: 0, width: 3840, height: 1080, dpr: 2 }, // Ultrawide
        { left: 0, top: 0, width: 1080, height: 1920, dpr: 1 }, // Portrait
    ];

    for (const tc of testCases) {
        const stage = createMockStage(tc);
        stage.resize();

        assert.ok(stage.scale > 0, `scale should be positive for ${JSON.stringify(tc)}`);

        // Test multiple world coordinates
        const sampleWorldCoords = [
            { x: 0, y: 0 },
            { x: stage.worldWidth * 0.5, y: stage.worldHeight * 0.5 },
            { x: stage.worldWidth, y: stage.worldHeight },
            { x: -500, y: 1500 }, // offscreen points
            { x: 1234.567, y: 890.123 },
        ];

        for (const pt of sampleWorldCoords) {
            // Forward transform: world -> client screen
            const clientX = tc.left + stage.offsetX + pt.x * stage.scale;
            const clientY = tc.top + stage.offsetY + pt.y * stage.scale;

            // Inversion: client screen -> world
            const recovered = stage.toWorld(clientX, clientY);

            assert.ok(
                Math.abs(recovered.x - pt.x) < 1e-9,
                `X inversion error at pt (${pt.x}, ${pt.y}): got ${recovered.x}, diff ${Math.abs(recovered.x - pt.x)}`,
            );
            assert.ok(
                Math.abs(recovered.y - pt.y) < 1e-9,
                `Y inversion error at pt (${pt.x}, ${pt.y}): got ${recovered.y}, diff ${Math.abs(recovered.y - pt.y)}`,
            );
        }
    }
});

test('fast-forward: stage.toWorld safely handles scale=0 or uninitialized state without throwing or NaN', () => {
    const stage = createMockStage();
    stage.scale = 0;

    const result = stage.toWorld(100, 200);
    assert.deepEqual(result, { x: 0, y: 0 });
    assert.ok(!Number.isNaN(result.x) && !Number.isNaN(result.y));
});

// ------------------------------------------------------------
// 3. PRE-PAINT SKIP EQUIVALENCE TESTS (?skip=0, 60, 420)
// ------------------------------------------------------------

test('fast-forward: pre-paint skip ?skip=0, 60, 420 produces bit-identical world hashes to frame-by-frame runs', () => {
    const seeds = [1, 7, 42, 100];
    const skips = [0, 60, 420];

    for (const seed of seeds) {
        for (const skipSec of skips) {
            const targetTicks = Math.round(skipSec / FIXED_DT);

            // Method A: Pre-paint batch stepping (as in main.js ?skip=N)
            const worldA = createWorld({ seed, effects: false });
            for (let i = 0; i < targetTicks; i++) {
                stepWorld(worldA, FIXED_DT);
            }

            // Method B: Simulated frame-by-frame loop stepping with accumulator
            const worldB = createWorld({ seed, effects: false });
            let simulatedAccumulator = 0;
            let totalStepsB = 0;
            while (totalStepsB < targetTicks) {
                simulatedAccumulator += 0.016666666666666666;
                while (simulatedAccumulator >= FIXED_DT && totalStepsB < targetTicks) {
                    stepWorld(worldB, FIXED_DT);
                    simulatedAccumulator -= FIXED_DT;
                    totalStepsB++;
                }
            }

            assert.equal(worldA.tick, targetTicks);
            assert.equal(worldB.tick, targetTicks);
            assert.equal(
                worldA.hash(),
                worldB.hash(),
                `Hash diverged for seed ${seed} at skip=${skipSec}s (tick ${targetTicks})`,
            );
        }
    }
});

// ------------------------------------------------------------
// 4. SHIP SELECTION & DESTRUCTION TESTS (EV.SHIP_DIED & HUD)
// ------------------------------------------------------------

test('fast-forward: killShip with live killer snapshots killer and kinematics in HUD without TypeError', () => {
    const world = createWorld({ seed: 777, effects: false });
    const victim = makeShip(world, 'fighter', 0, 800, 600, 1.2);
    victim.vx = 45.5;
    victim.vy = -12.3;
    victim.cargo = 10;
    victim.state = 'engage';
    victim.stateTime = 4.2;
    world.addShip(victim);

    const killer = makeShip(world, 'fighter', 1, 850, 600, 3.1);
    world.addShip(killer);
    world.refreshGrids();

    const hud = new HUD(world);
    hud.selectShip(victim.id);
    assert.equal(hud.selectedShipId, victim.id);

    // Call killShip
    killShip(world, victim, killer.id);

    assert.equal(victim.dead, true);
    assert.ok(hud.deathRecord, 'deathRecord should be populated on EV.SHIP_DIED');
    assert.equal(hud.deathRecord.id, victim.id);
    assert.equal(hud.deathRecord.killerId, killer.id);
    assert.equal(hud.deathRecord.killerType, killer.type);
    assert.equal(hud.deathRecord.killerRole, killer.role);
    assert.equal(hud.deathRecord.lastX, 800);
    assert.equal(hud.deathRecord.lastY, 600);
    assert.equal(hud.deathRecord.lastVx, 45.5);
    assert.equal(hud.deathRecord.lastVy, -12.3);
    assert.equal(hud.deathRecord.lastCargo, 10);
    assert.equal(hud.deathRecord.lastState, 'engage');

    // Verify updateInspector does not throw and formats destroyed ship text
    const loop = new Loop(() => {}, () => {});
    const themes = { current: THEMES.void, mode: 'auto' };
    assert.doesNotThrow(() => {
        hud.updateInspector(loop, themes);
    });

    if (hud.inspectorEl) {
        assert.ok(hud.inspectorEl.textContent.includes('DESTROYED'));
        assert.ok(hud.inspectorEl.textContent.includes(`killer    #${killer.id}`));
    }
});

test('fast-forward: killShip with killerId=0 (attrition/self) handles missing killer gracefully', () => {
    const world = createWorld({ seed: 777, effects: false });
    const victim = makeShip(world, 'miner', 0, 500, 500, 0);
    world.addShip(victim);
    world.refreshGrids();

    const hud = new HUD(world);
    hud.selectShip(victim.id);

    killShip(world, victim, 0);

    assert.ok(hud.deathRecord);
    assert.equal(hud.deathRecord.killerId, 0);
    assert.equal(hud.deathRecord.killerType, '');

    const loop = new Loop(() => {}, () => {});
    const themes = { current: THEMES.void, mode: 'auto' };
    assert.doesNotThrow(() => {
        hud.updateInspector(loop, themes);
    });

    if (hud.inspectorEl) {
        assert.ok(hud.inspectorEl.textContent.includes('killer    none (attrition/self)'));
    }
});

test('fast-forward: killShip with invalid killerId (non-existent/dead) handles lookup gracefully without TypeError', () => {
    const world = createWorld({ seed: 777, effects: false });
    const victim = makeShip(world, 'drone', 0, 300, 300, 0);
    world.addShip(victim);
    world.refreshGrids();

    const hud = new HUD(world);
    hud.selectShip(victim.id);

    // Non-existent killer ID
    killShip(world, victim, 999999);

    assert.ok(hud.deathRecord);
    assert.equal(hud.deathRecord.killerId, 999999);
    assert.equal(hud.deathRecord.killerType, '');

    const loop = new Loop(() => {}, () => {});
    const themes = { current: THEMES.void, mode: 'auto' };
    assert.doesNotThrow(() => {
        hud.updateInspector(loop, themes);
    });

    if (hud.inspectorEl) {
        assert.ok(hud.inspectorEl.textContent.includes('killer    #999999 unknown'));
    }
});

test('fast-forward: inspecting non-existent ship ID or deselecting cleans up without TypeError', () => {
    const world = createWorld({ seed: 777, effects: false });
    const hud = new HUD(world);

    // Inspect unknown ship
    hud.selectShip(88888);
    const loop = new Loop(() => {}, () => {});
    const themes = { current: THEMES.void, mode: 'auto' };
    assert.doesNotThrow(() => {
        hud.updateInspector(loop, themes);
    });
    if (hud.inspectorEl) {
        assert.ok(hud.inspectorEl.textContent.includes('NOT FOUND / DESTROYED'));
    }

    // Deselect
    hud.selectShip(0);
    assert.equal(hud.selectedShipId, 0);
    assert.equal(hud.deathRecord, null);
});

// ------------------------------------------------------------
// 5. EXTENDED ADVERSARIAL STRESS TESTS
// ------------------------------------------------------------

test('fast-forward: loop.stepOnce is invariant to loop.speed multipliers (0.5x, 2x, 4x)', () => {
    const speeds = [0.1, 0.5, 1, 2, 4, 10];
    for (const speed of speeds) {
        let stepDt = null;
        let stepCount = 0;
        const loop = new Loop(
            (dt) => {
                stepCount++;
                stepDt = dt;
            },
            () => {},
        );
        loop.speed = speed;
        loop.stepOnce();

        assert.equal(stepCount, 1, `stepCount failed at speed ${speed}`);
        assert.equal(stepDt, FIXED_DT, `stepDt should always be FIXED_DT regardless of speed multiplier ${speed}`);
        assert.equal(loop.accumulator, 0);
    }
});

test('fast-forward: stage DPR clamping enforces MAX_DPR=2 cap', () => {
    const dprs = [0.5, 1, 1.5, 2, 2.5, 3, 4, 8];
    for (const dpr of dprs) {
        const stage = createMockStage({ dpr, width: 1000, height: 500 });
        stage.resize();
        const expectedDpr = Math.min(dpr, 2);
        assert.equal(stage.dpr, expectedDpr, `DPR ${dpr} was not properly clamped to ${expectedDpr}`);
    }
});

