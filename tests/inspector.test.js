// ============================================================
// TESTS — CHALLENGER 2 EMPIRICAL ADVERSARIAL VERIFICATION
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { FIXED_DT } from '../src/core/constants.js';
import { Stage } from '../src/render/canvas.js';
import { HUD } from '../src/render/hud.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { THEMES } from '../src/data/themes.js';
import { telemetry } from '../src/core/telemetry.js';
import { MockContext2D, createMockStage } from './render.test.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

// Ensure complete headless DOM stub for HUD testing
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
                    getContext: () => new MockContext2D(canvas),
                    getBoundingClientRect: () => ({ left: 0, top: 0, width: 64, height: 64 }),
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
// CHALLENGE 1: DETERMINISM & PRNG / GLOBAL STATE ISOLATION
// ------------------------------------------------------------

test('inspector: inspector: interleaved rendering & tooling operations do not pollute PRNG or world hash', () => {
    const w1 = createWorld({ seed: 12345, effects: false });
    for (let i = 0; i < 300; i++) stepWorld(w1, FIXED_DT);
    const hash1 = w1.hash();
    const rng1 = w1.rng.state;
    const fx1 = w1.fxRng.state;

    // Heavy interleaved mock rendering, HUD selection, and gizmos
    const stage = createMockStage(2400, 1350);
    const hud = new HUD(w1);
    const targetShipId = w1.ships[0]?.id || 1;
    hud.selectShip(targetShipId);
    telemetry.enable();
    telemetry.watch(targetShipId);

    for (let i = 0; i < 50; i++) {
        drawGizmos(stage.ctx, w1, THEMES.void, stage, 1, hud.selectedShipId);
        drawGizmos(stage.ctx, w1, THEMES.paper, stage, 1, 0);
    }
    telemetry.watch(0);
    telemetry.disable();
    hud.selectShip(0);

    // Verify w1 has not drifted
    assert.equal(w1.hash(), hash1, 'Interleaved rendering/HUD mutated world hash');
    assert.equal(w1.rng.state, rng1, 'Interleaved rendering advanced world.rng');
    assert.equal(w1.fxRng.state, fx1, 'Interleaved rendering advanced world.fxRng');

    // Create fresh w2 with seed 12345 and step 300 ticks
    const w2 = createWorld({ seed: 12345, effects: false });
    for (let i = 0; i < 300; i++) stepWorld(w2, FIXED_DT);
    assert.equal(w2.hash(), hash1, 'Fresh world after tests diverged from pre-test world hash');
    assert.equal(w2.rng.state, rng1, 'Fresh world RNG diverged');
    assert.equal(w2.fxRng.state, fx1, 'Fresh world fxRng diverged');
});

test('inspector: inspector: multi-run determinism across repeated test cycles', () => {
    for (let cycle = 0; cycle < 5; cycle++) {
        const wA = createWorld({ seed: 999 + cycle, effects: false });
        const wB = createWorld({ seed: 999 + cycle, effects: false });
        for (let i = 0; i < 120; i++) {
            stepWorld(wA, FIXED_DT);
            stepWorld(wB, FIXED_DT);
        }
        assert.equal(wA.hash(), wB.hash(), `Cycle ${cycle} determinism failed`);
    }
});

// ------------------------------------------------------------
// CHALLENGE 2: SHIP INSPECTOR HIT-TESTING & TO_WORLD BOUNDARIES
// ------------------------------------------------------------

test('inspector: inspector: shipGrid.nearest boundary conditions (exact center, perimeter, strict maxR inequality, dead filter)', () => {
    const world = createWorld({ seed: 77, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const s1 = makeShip(world, 'fighter', 0, 1000, 1000, 0);
    world.addShip(s1);
    const s2 = makeShip(world, 'miner', 1, 1000, 1000, 0); // Exact overlap
    world.addShip(s2);
    const sDead = makeShip(world, 'drone', 0, 1005, 1005, 0);
    sDead.dead = true;
    world.addShip(sDead);
    world.refreshGrids();

    // 1. Query exact center with generous search radius
    const hitCenter = world.shipGrid.nearest(1000, 1000, 20, (s) => !s.dead);
    assert.ok(hitCenter, 'Hit query at exact center failed');
    assert.ok(hitCenter.id === s1.id || hitCenter.id === s2.id);

    // 2. Query within radius (distance = s1.radius * 0.5 < maxR = s1.radius)
    const hitInside = world.shipGrid.nearest(1000 + s1.radius * 0.5, 1000, s1.radius, (s) => !s.dead);
    assert.ok(hitInside, 'Hit query inside radius failed');

    // 3. Boundary property verification: nearest uses strict inequality (d2 < bestD2).
    // Querying with maxR = distance means d2 == maxR^2, so it returns null.
    const dist = s1.radius;
    const boundaryExact = world.shipGrid.nearest(1000 + dist, 1000, dist, (s) => !s.dead);
    assert.equal(boundaryExact, null, 'Strict inequality d2 < maxR^2 should exclude exact boundary equality');

    // Querying with search radius just above distance (e.g. 30px standard click threshold) matches s1
    const hitClick = world.shipGrid.nearest(1000 + dist, 1000, 30, (s) => !s.dead);
    assert.ok(hitClick, 'Hit query on entity perimeter with click radius failed');
    assert.equal(hitClick.id, s1.id);

    // 4. Query beyond click threshold (e.g. 50px away with 30px search radius)
    const miss = world.shipGrid.nearest(1000 + dist + 50, 1000, 30, (s) => !s.dead);
    assert.equal(miss, null, 'Query beyond click radius should return null');

    // 5. Query dead filter
    const hitAliveOnly = world.shipGrid.nearest(1005, 1005, 5, (s) => !s.dead);
    assert.equal(hitAliveOnly, null, 'Dead ship should be ignored when predicate filters it out');

    // 6. Query extreme out-of-bounds coordinates
    assert.equal(world.shipGrid.nearest(-500, -500, 100, () => true), null);
    assert.equal(world.shipGrid.nearest(world.width + 500, world.height + 500, 100, () => true), null);
});

test('inspector: inspector: Stage.toWorld mathematical bijection across varied scales, offsets, and window positions', () => {
    const canvasMock = {
        width: 2400,
        height: 1350,
        getBoundingClientRect: () => ({ left: 120, top: 45, width: 2400, height: 1350 }),
        getContext: () => new MockContext2D(),
    };
    const stg = new Stage(canvasMock);

    for (const scale of [0.25, 0.5, 1.0, 1.33, 2.0, 3.0]) {
        for (const offX of [-500, 0, 250]) {
            for (const offY of [-200, 0, 400]) {
                stg.scale = scale;
                stg.offsetX = offX;
                stg.offsetY = offY;

                const testPoints = [
                    { wx: 0, wy: 0 },
                    { wx: 1200, wy: 675 },
                    { wx: 2400, wy: 1350 },
                    { wx: -50, wy: -50 },
                ];

                for (const pt of testPoints) {
                    // world -> screen transform
                    const screenX = 120 + offX + pt.wx * scale;
                    const screenY = 45 + offY + pt.wy * scale;
                    const { x: invX, y: invY } = stg.toWorld(screenX, screenY);

                    assert.ok(
                        Math.abs(invX - pt.wx) < 1e-4,
                        `toWorld X inversion mismatch: expected ${pt.wx}, got ${invX} at scale=${scale}`,
                    );
                    assert.ok(
                        Math.abs(invY - pt.wy) < 1e-4,
                        `toWorld Y inversion mismatch: expected ${pt.wy}, got ${invY} at scale=${scale}`,
                    );
                }
            }
        }
    }
});

// ------------------------------------------------------------
// CHALLENGE 3: SPATIAL GIZMOS RECURSIVE DEEP-FREEZE IMMUTABILITY
// ------------------------------------------------------------

test('inspector: inspector: drawGizmos runs cleanly on recursively frozen world with corrupted entity links', () => {
    const world = createWorld({ seed: 888, effects: false });
    for (let i = 0; i < 100; i++) stepWorld(world, FIXED_DT);

    // Corrupt entity IDs to test boundary tolerance
    const faultyFighter = makeShip(world, 'fighter', 0, 500, 500);
    faultyFighter.targetId = 999999;
    world.addShip(faultyFighter);

    const faultyMiner = makeShip(world, 'miner', 0, 600, 600);
    faultyMiner.claimId = 888888;
    world.addShip(faultyMiner);

    const faultyDrone = makeShip(world, 'drone', 0, 700, 700);
    faultyDrone.parentId = 777777;
    world.addShip(faultyDrone);

    function deepFreeze(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (ArrayBuffer.isView(obj)) return obj;
        Object.freeze(obj);
        for (const key of Object.keys(obj)) {
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                deepFreeze(obj[key]);
            }
        }
        return obj;
    }

    const frozenWorld = deepFreeze(world);
    const mockStage = createMockStage(2400, 1350);

    const initialRng = frozenWorld.rng.state;
    const initialFxRng = frozenWorld.fxRng.state;

    assert.doesNotThrow(() => {
        for (let i = 0; i < 30; i++) {
            drawGizmos(mockStage.ctx, frozenWorld, THEMES.void, mockStage, 1, 0);
            drawGizmos(mockStage.ctx, frozenWorld, THEMES.paper, mockStage, 1, faultyFighter.id);
            drawGizmos(mockStage.ctx, frozenWorld, THEMES.void, mockStage, 1, faultyMiner.id);
            drawGizmos(mockStage.ctx, frozenWorld, THEMES.paper, mockStage, 1, faultyDrone.id);
        }
    }, 'drawGizmos attempted mutation or threw on deep-frozen world');

    assert.equal(frozenWorld.rng.state, initialRng, 'drawGizmos advanced world.rng');
    assert.equal(frozenWorld.fxRng.state, initialFxRng, 'drawGizmos advanced world.fxRng');
});
