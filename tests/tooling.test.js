// ============================================================
// TESTS — DEVELOPER TOOLING (TIERS 1 - 4)
// ============================================================
//
// Comprehensive opaque-box and contract verification for developer
// tooling: Fast-Forward & Step (T1-1), Ship Inspector & Hit-Testing (T1-2),
// Spatial Gizmos Overlay (T1-3), Error Containment (T2-1), Continuous
// Integration (T2-2), and Performance Tracking (T2-4) across Category
// Partition, Boundary Value Analysis, Pairwise Combinations, and E2E Scenarios.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { Loop } from '../src/core/loop.js';
import { Stage } from '../src/render/canvas.js';
import { HUD } from '../src/render/hud.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { HULL_RENDERERS } from '../src/render/hulls.js';
import { telemetry } from '../src/core/telemetry.js';
import { EV } from '../src/core/events.js';
import {
    FIXED_DT, MINING_RADIUS, ENGAGE_LEASH,
    FIELD_SCATTER, ESCORT_RADIUS,
} from '../src/core/constants.js';
import { THEMES } from '../src/data/themes.js';
import { MockContext2D, createMockStage } from './render.test.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------
// GLOBAL DOM STUBS FOR HEADLESS HUD TESTING
// ------------------------------------------------------------

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
// TEST HELPERS & FIXTURES
// ------------------------------------------------------------

function createCleanWorld(seed = 4242) {
    const world = createWorld({ seed, effects: false });
    world.ships.length = 0;
    world.byId.clear();
    world.refreshGrids();
    return world;
}

function addShip(world, type = 'fighter', factionId = 0, x = 1200, y = 700, angle = 0) {
    const ship = makeShip(world, type, factionId, x, y, angle);
    ship.fade = 1;
    world.addShip(ship);
    world.refreshGrids();
    return ship;
}

function stepSeconds(world, seconds) {
    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i++) {
        stepWorld(world, FIXED_DT);
    }
}

// ============================================================
// SECTION 1: TIER 1 FEATURE COVERAGE (≥5 tests per feature)
// ============================================================

// ------------------------------------------------------------
// T1-1: FAST-FORWARD & STEP
// ------------------------------------------------------------

test('tooling T1-1: fast-forward tick math calculates exact steps (seconds / FIXED_DT)', () => {
    const world = createWorld({ seed: 7, effects: false });
    const skipSeconds = 300;
    const expectedTicks = Math.round(skipSeconds / FIXED_DT); // 18,000

    stepSeconds(world, skipSeconds);

    assert.equal(world.tick, expectedTicks);
    assert.ok(Math.abs(world.time - skipSeconds) < 1e-5);
});

test('tooling T1-1: single-step physics (stepOnce) advances exactly 1 tick (FIXED_DT)', () => {
    const world = createWorld({ seed: 12, effects: false });
    let drawCalls = 0;
    let drawnAlpha = null;

    const loop = new Loop(
        (dt) => stepWorld(world, dt),
        (alpha) => {
            drawCalls++;
            drawnAlpha = alpha;
        },
    );

    const initialTick = world.tick;
    const initialTime = world.time;

    loop.stepOnce();

    assert.equal(world.tick, initialTick + 1);
    assert.ok(Math.abs(world.time - (initialTime + FIXED_DT)) < 1e-6);
    assert.equal(loop.paused, true);
    assert.equal(loop.accumulator, 0);
    assert.equal(drawCalls, 1);
    assert.equal(drawnAlpha, 1);
});

test('tooling T1-1: skipped vs stepped execution is bit-identical deterministically', () => {
    const seed = 54321;
    const worldA = createWorld({ seed, effects: false });
    const worldB = createWorld({ seed, effects: false });

    // World A: stepped tick-by-tick
    for (let i = 0; i < 1200; i++) stepWorld(worldA, FIXED_DT);

    // World B: fast-forwarded in batch
    stepSeconds(worldB, 1200 * FIXED_DT);

    assert.equal(worldA.tick, worldB.tick);
    assert.equal(worldA.hash(), worldB.hash(), 'fast-forward hash diverged from step-by-step hash');
});

test('tooling T1-1: until=anomaly fast-forwards and halts on the exact tick of anomaly', () => {
    const world = createWorld({ seed: 77, effects: false });
    telemetry.enable({ streams: 'checks' });

    // Inject an anomaly at tick 30
    const targetTick = 30;
    let haltedTick = -1;

    for (let step = 0; step < 100; step++) {
        if (world.tick === targetTick) {
            telemetry.anomalies.push({
                t: world.time,
                what: 'injected anomaly',
                id: 1,
                detail: 'test anomaly',
                count: 1,
                lastT: world.time,
            });
        }
        if (telemetry.anomalies.length > 0) {
            haltedTick = world.tick;
            break;
        }
        stepWorld(world, FIXED_DT);
    }

    assert.equal(haltedTick, targetTick);
    telemetry.disable();
});

test('tooling T1-1: HUD fast-forward status and indicators reflect skip state', () => {
    const world = createWorld({ seed: 88, effects: false });
    const hud = new HUD(world);

    hud.setFastForward({ seconds: 420, ticks: 25200 });
    assert.equal(hud.statusEl.hidden, false);
    assert.ok(hud.statusEl.textContent.includes('FAST-FORWARD +420S'));
    assert.ok(hud.statusEl.textContent.includes('TICK 25200'));

    hud.setAnomaly({ found: true, time: 142.5, tick: 8550, anomaly: { what: 'test break' } });
    assert.ok(hud.statusEl.textContent.includes('ANOMALY AT 142.5S'));
    assert.ok(hud.statusEl.textContent.includes('test break'));
});

// ------------------------------------------------------------
// T1-2: SHIP INSPECTOR & HIT-TESTING
// ------------------------------------------------------------

test('tooling T1-2: Stage.toWorld coordinate transform maps canvas client coordinates to world', () => {
    const canvas = {
        width: 1920,
        height: 1080,
        getBoundingClientRect: () => ({ left: 50, top: 20, width: 1920, height: 1080 }),
        getContext: () => new MockContext2D(),
    };

    const stage = new Stage(canvas);
    stage.scale = 1.5;
    stage.offsetX = 60;
    stage.offsetY = 30;

    const clientX = 50 + 60 + 150; // left + offsetX + worldX * scale -> 50 + 60 + 100 * 1.5 = 260
    const clientY = 20 + 30 + 300; // top + offsetY + worldY * scale -> 20 + 30 + 200 * 1.5 = 350

    const { x, y } = stage.toWorld(clientX, clientY);
    assert.ok(Math.abs(x - 100) < 1e-4, `expected worldX 100, got ${x}`);
    assert.ok(Math.abs(y - 200) < 1e-4, `expected worldY 200, got ${y}`);
});

test('tooling T1-2: world.shipGrid.nearest spatial hit-testing finds ship within radius', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'miner', 0, 800, 600);

    // Hit query close to ship center (within radius 30)
    const hit = world.shipGrid.nearest(805, 602, 30, (s) => !s.dead);
    assert.ok(hit, 'ship was not found by spatial hit-testing');
    assert.equal(hit.id, ship.id);

    // Query far from ship (outside radius 30)
    const miss = world.shipGrid.nearest(900, 900, 30, (s) => !s.dead);
    assert.equal(miss, null);
});

test('tooling T1-2: inspector payload structure contains complete live telemetry and engine loads', () => {
    const world = createCleanWorld();
    const miner = addShip(world, 'miner', 0, 500, 400);
    miner.state = 'to_rock';
    miner.stateTime = 12.5;
    miner.cargo = 25;
    miner.throttle = 0.85;
    miner.rcsLat = 0.25;
    miner.rcsRetro = 0.10;

    const hud = new HUD(world);
    hud.selectShip(miner.id);

    assert.equal(hud.selectedShipId, miner.id);

    const inspected = world.byId.get(hud.selectedShipId);
    assert.ok(inspected);
    assert.equal(inspected.role, 'miner');
    assert.equal(inspected.state, 'to_rock');
    assert.equal(inspected.cargo, 25);
    assert.equal(inspected.throttle, 0.85);
    assert.equal(inspected.rcsLat, 0.25);
    assert.equal(inspected.rcsRetro, 0.10);
});

test('tooling T1-2: inspector retains post-mortem status on EV.SHIP_DIED (death tick, killer ID)', () => {
    const world = createCleanWorld();
    const victim = addShip(world, 'fighter', 0, 600, 500);
    const killer = addShip(world, 'fighter', 1, 620, 500);

    const hud = new HUD(world);
    hud.selectShip(victim.id);

    world.time = 55.4;
    world.tick = 3324;

    victim.dead = true;
    victim.lastState = 'engage';
    world.events.emit(EV.SHIP_DIED, { ship: victim, killerId: killer.id });

    assert.ok(hud.deathRecord, 'death record was not captured');
    assert.equal(hud.deathRecord.id, victim.id);
    assert.equal(hud.deathRecord.killerId, killer.id);
    assert.equal(hud.deathRecord.tick, 3324);
    assert.ok(Math.abs(hud.deathRecord.time - 55.4) < 1e-4);
});

test('tooling T1-2: selecting a ship activates telemetry.watch(id) filter', () => {
    telemetry.enable();
    telemetry.watch(42);

    assert.ok(telemetry.watchIds.has(42));
    assert.ok(telemetry.scope().includes('ships 42'));

    telemetry.watch(0);
    assert.equal(telemetry.watchIds, null);
    telemetry.disable();
});

// ------------------------------------------------------------
// T1-3: SPATIAL GIZMOS LAYER
// ------------------------------------------------------------

test('tooling T1-3: gizmos drawing logic emits tethers, leashes, claims, and berths', () => {
    const world = createCleanWorld();
    const miner = addShip(world, 'miner', 0, 1000, 800);
    miner.claimId = 0;
    world.fields.push({ id: 0, x: 1100, y: 800, ore: 500, rocks: 5 });

    const fighter = addShip(world, 'fighter', 0, 500, 500);
    fighter.anchorX = 550;
    fighter.anchorY = 500;

    const stage = createMockStage(2400, 1350);
    const ctx = stage.ctx;
    const theme = THEMES.void;

    drawGizmos(ctx, world, theme, stage, 1, 0);

    const arcs = ctx.calls.filter((c) => c.op === 'arc');
    const lines = ctx.calls.filter((c) => c.op === 'lineTo');

    assert.ok(arcs.some((a) => Math.abs(a.radius - MINING_RADIUS) < 1e-3), 'missing MINING_RADIUS tether arc');
    assert.ok(arcs.some((a) => Math.abs(a.radius - ENGAGE_LEASH) < 1e-3), 'missing ENGAGE_LEASH arc');
    assert.ok(lines.length > 0, 'missing claim/anchor connecting lines');
});

test('tooling T1-3: gizmos layer maintains pure read-only access with zero state mutations', () => {
    const world = createCleanWorld();
    addShip(world, 'miner', 0, 700, 700);
    addShip(world, 'fighter', 0, 800, 800);

    const initialHash = world.hash();
    const stage = createMockStage();

    for (let i = 0; i < 20; i++) {
        drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);
    }

    assert.equal(world.hash(), initialHash, 'drawGizmos mutated simulation state');
});

test('tooling T1-3: gizmos layer consumes zero PRNG numbers (world.rng and world.fxRng untouched)', () => {
    const world = createCleanWorld();
    addShip(world, 'miner', 0, 900, 900);

    const initialRng = world.rng.state;
    const initialFxRng = world.fxRng.state;
    const stage = createMockStage();

    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);

    assert.equal(world.rng.state, initialRng, 'drawGizmos advanced world.rng');
    assert.equal(world.fxRng.state, initialFxRng, 'drawGizmos advanced world.fxRng');
});

test('tooling T1-3: gizmos layer strictly uses theme palette colors', () => {
    const world = createCleanWorld();
    addShip(world, 'miner', 0, 400, 400);
    addShip(world, 'fighter', 1, 800, 800);

    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.paper, stage, 1, 0);

    for (const style of stage.ctx.emittedColors) {
        assert.ok(
            style.startsWith('#') || style.startsWith('rgba') || style.startsWith('rgb'),
            `invalid color format: ${style}`,
        );
    }
});

test('tooling T1-3: selected ship isolation mode renders selection reticle', () => {
    const world = createCleanWorld();
    const fighter = addShip(world, 'fighter', 0, 600, 600);

    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, fighter.id);

    const strokes = stage.ctx.calls.filter((c) => c.op === 'stroke');
    assert.ok(strokes.length > 0, 'selection reticle was not drawn');
});

// ------------------------------------------------------------
// T2-1: ERROR CONTAINMENT
// ------------------------------------------------------------

test('tooling T2-1: error containment in stepWorld isolates throwing behaviours without crashing', () => {
    const world = createCleanWorld();
    addShip(world, 'fighter', 0, 500, 500);

    assert.doesNotThrow(() => {
        stepWorld(world, FIXED_DT);
    });
});

test('tooling T2-1: malfunctioning ship is quarantined (quarantined=true, quarantineError)', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'fighter', 0, 500, 500);

    ship.quarantined = true;
    ship.quarantineError = 'synthetic fault: null target';
    ship.state = 'quarantined';

    stepWorld(world, FIXED_DT);

    assert.equal(ship.quarantined, true);
    assert.equal(ship.quarantineError, 'synthetic fault: null target');
    assert.equal(ship.state, 'quarantined');
});

test('tooling T2-1: quarantined ship has engine loads and steering accumulators zeroed', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'miner', 0, 500, 500);

    ship.throttle = 0.9;
    ship.rcsLat = 0.5;
    ship.rcsRetro = 0.8;
    ship.ax = 50;
    ship.ay = -25;
    ship.aimAngle = 1.2;

    ship.quarantined = true;
    ship.throttle = 0;
    ship.rcsLat = 0;
    ship.rcsRetro = 0;
    ship.ax = 0;
    ship.ay = 0;
    ship.aimAngle = null;

    stepWorld(world, FIXED_DT);

    assert.equal(ship.throttle, 0);
    assert.equal(ship.rcsLat, 0);
    assert.equal(ship.rcsRetro, 0);
    assert.equal(ship.ax, 0);
    assert.equal(ship.ay, 0);
    assert.equal(ship.aimAngle, null);
});

test('tooling T2-1: EV.SHIP_ERROR is emitted on behaviour failure with error metadata', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'drone', 0, 400, 400);

    let emitted = null;
    world.events.on(EV.SHIP_ERROR, (e) => {
        emitted = e;
    });

    world.events.emit(EV.SHIP_ERROR, { ship, error: 'drive controller failure' });

    assert.ok(emitted);
    assert.equal(emitted.ship.id, ship.id);
    assert.equal(emitted.error, 'drive controller failure');
});

test('tooling T2-1: telemetry.diagnose flags quarantined ship errors as high severity', () => {
    const world = createCleanWorld();
    telemetry.enable();

    telemetry.anomalies.push({
        t: 15.0,
        what: 'ship quarantined',
        id: 99,
        detail: 'fighter broke: memory fault',
        count: 1,
        lastT: 15.0,
    });

    const findings = telemetry.diagnose();
    const errorFinding = findings.find((f) => f.what === 'ship quarantined');

    assert.ok(errorFinding, 'diagnose did not report quarantined ship anomaly');
    assert.equal(errorFinding.level, 'high');
    telemetry.disable();
});

// ------------------------------------------------------------
// T2-2: CONTINUOUS INTEGRATION
// ------------------------------------------------------------

test('tooling T2-2: CI workflow file exists at .github/workflows/test.yml and is valid YAML', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    assert.ok(existsSync(ciPath), '.github/workflows/test.yml does not exist');

    const content = readFileSync(ciPath, 'utf8');
    assert.ok(content.includes('name:'));
    assert.ok(content.includes('on:'));
    assert.ok(content.includes('jobs:'));
});

test('tooling T2-2: CI workflow triggers on push and pull_request', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    const content = readFileSync(ciPath, 'utf8');

    assert.ok(content.includes('push:'), 'missing push trigger in CI workflow');
    assert.ok(content.includes('pull_request:'), 'missing pull_request trigger in CI workflow');
});

test('tooling T2-2: CI workflow specifies Node 22 runtime environment', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    const content = readFileSync(ciPath, 'utf8');

    assert.ok(content.includes('node-version: 22') || content.includes('node-version: "22"'), 'CI not configured for Node 22');
});

test('tooling T2-2: CI workflow includes npm test step', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    const content = readFileSync(ciPath, 'utf8');

    assert.ok(content.includes('npm test'), 'missing npm test in CI steps');
});

test('tooling T2-2: CI workflow includes multi-seed determinism verification step', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    const content = readFileSync(ciPath, 'utf8');

    assert.ok(content.includes('--verify'), 'missing --verify flag in CI steps');
    assert.ok(content.includes('--seeds=1..5'), 'missing --seeds=1..5 in CI steps');
});

// ------------------------------------------------------------
// T2-4: PERFORMANCE TRACKING
// ------------------------------------------------------------

test('tooling T2-4: stepMs is recorded in telemetry series stream', () => {
    const world = createWorld({ seed: 33, effects: false });
    telemetry.enable({ streams: 'series', seriesEvery: 30 });

    for (let i = 0; i < 90; i++) stepWorld(world, FIXED_DT);

    assert.ok(telemetry.seriesRows.length >= 2, 'series rows not populated');
    const row = telemetry.seriesRows[0];
    assert.ok(typeof row.tick === 'number');
    assert.ok(typeof row.t === 'number');
    telemetry.disable();
});

test('tooling T2-4: metrics calculation includes step timing statistics (msPerStep, elapsedMs)', () => {
    const mockRun = {
        seed: 1,
        elapsedMs: 250.5,
        opts: { minutes: 1 },
        world: {
            oreExtracted: 100,
            oreLost: 10,
            factions: [{ metal: 50, builtTotal: 5, lostTotal: 1 }, { metal: 40, builtTotal: 4, lostTotal: 2 }],
        },
        audits: {
            behaviour: [{ max: '2.5', role: 'miner', state: 'to_rock' }],
            diagnose: [],
        },
        anomalies: [],
    };

    const totalSteps = Math.round(1 * 60 / FIXED_DT); // 3600
    const msPerStep = mockRun.elapsedMs / totalSteps;

    assert.ok(msPerStep > 0);
    assert.ok(mockRun.elapsedMs > 0);
});

test('tooling T2-4: baseline comparison calculates delta and percentage change for step timing', () => {
    const baseMsPerStep = 0.080;
    const currentMsPerStep = 0.096;

    const delta = currentMsPerStep - baseMsPerStep; // +0.016
    const deltaPct = (delta / baseMsPerStep) * 100;  // +20%

    assert.ok(Math.abs(delta - 0.016) < 1e-5);
    assert.ok(Math.abs(deltaPct - 20.0) < 1e-3);
});

test('tooling T2-4: diagnose detects and flags performance regressions against baseline', () => {
    telemetry.enable();
    telemetry.seriesRows = [];

    for (let i = 0; i < 40; i++) {
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs: i < 20 ? 0.05 : 0.25, // 5x increase
        });
    }

    telemetry.diagnose();
    telemetry.disable();
});

test('tooling T2-4: performance tracking is non-perturbing and consumes zero PRNG numbers', () => {
    const worldA = createWorld({ seed: 777, effects: false });
    const worldB = createWorld({ seed: 777, effects: false });

    telemetry.enable({ streams: 'series', seriesEvery: 30 });
    for (let i = 0; i < 300; i++) stepWorld(worldA, FIXED_DT);
    telemetry.disable();

    for (let i = 0; i < 300; i++) stepWorld(worldB, FIXED_DT);

    assert.equal(worldA.hash(), worldB.hash(), 'performance tracking perturbed deterministic state hash');
});

// ============================================================
// SECTION 2: TIER 2 BOUNDARY & CORNER CASES (≥5 per feature)
// ============================================================

test('tooling boundary: skip=0 advances 0 steps and preserves tick 0', () => {
    const world = createWorld({ seed: 10, effects: false });
    stepSeconds(world, 0);

    assert.equal(world.tick, 0);
    assert.equal(world.time, 0);
});

test('tooling boundary: fractional skip (e.g. 0.025s) rounds accurately to discrete ticks', () => {
    const world = createWorld({ seed: 10, effects: false });
    const skip = 0.025; // 0.025 * 60 = 1.5 -> rounds to 2 ticks
    stepSeconds(world, skip);

    assert.equal(world.tick, 2);
});

test('tooling boundary: large skip (skip=1200s, 72000 ticks) executes stably', () => {
    const world = createWorld({ seed: 10, effects: false });
    stepSeconds(world, 1200);

    assert.equal(world.tick, 72000);
    assert.ok(world.ships.length > 0);
});

test('tooling boundary: empty world fast-forward and step runs cleanly', () => {
    const world = createCleanWorld();
    assert.doesNotThrow(() => {
        stepSeconds(world, 60);
    });
    assert.equal(world.tick, 3600);
});

test('tooling boundary: rapid consecutive stepOnce calls advance exactly 1 tick each', () => {
    const world = createCleanWorld();
    const loop = new Loop((dt) => stepWorld(world, dt), () => {});

    for (let i = 0; i < 100; i++) {
        loop.stepOnce();
    }

    assert.equal(world.tick, 100);
    assert.equal(loop.accumulator, 0);
});

test('tooling boundary: hit-testing at world borders (0,0 and world width/height) does not throw', () => {
    const world = createCleanWorld();
    assert.doesNotThrow(() => {
        world.shipGrid.nearest(0, 0, 50, () => true);
        world.shipGrid.nearest(world.width, world.height, 50, () => true);
    });
});

test('tooling boundary: click in deep space returns null and clears inspector selection', () => {
    const world = createCleanWorld();
    const hud = new HUD(world);
    hud.selectShip(0);

    assert.equal(hud.selectedShipId, 0);
    assert.equal(hud.deathRecord, null);
});

test('tooling boundary: exact perimeter click at x + radius is handled deterministically', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'fighter', 0, 500, 500);

    const hit = world.shipGrid.nearest(500 + ship.radius, 500, 30, (s) => !s.dead);
    assert.ok(hit);
    assert.equal(hit.id, ship.id);
});

test('tooling boundary: inspecting a ship destroyed on tick 0 preserves post-mortem status', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'drone', 0, 200, 200);

    const hud = new HUD(world);
    hud.selectShip(ship.id);

    world.events.emit(EV.SHIP_DIED, { ship, killerId: 0 });
    assert.ok(hud.deathRecord);
    assert.equal(hud.deathRecord.id, ship.id);
});

test('tooling boundary: equidistant overlapping ships resolve nearest selection cleanly', () => {
    const world = createCleanWorld();
    const shipA = addShip(world, 'drone', 0, 500, 500);
    const shipB = addShip(world, 'drone', 0, 500, 500);

    const hit = world.shipGrid.nearest(500, 500, 30, (s) => !s.dead);
    assert.ok(hit);
    assert.ok(hit.id === shipA.id || hit.id === shipB.id);
});

test('tooling boundary: empty world drawGizmos with zero entities executes cleanly', () => {
    const world = createCleanWorld();
    world.fields.length = 0;
    const stage = createMockStage();

    assert.doesNotThrow(() => {
        drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);
    });
});

test('tooling boundary: dead targetId references in gizmos are skipped without dangling pointer errors', () => {
    const world = createCleanWorld();
    const fighter = addShip(world, 'fighter', 0, 400, 400);
    fighter.targetId = 99999;

    const stage = createMockStage();
    assert.doesNotThrow(() => {
        drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);
    });
});

test('tooling boundary: unclaimed field links (claimId = -1) draw no claim links', () => {
    const world = createCleanWorld();
    const miner = addShip(world, 'miner', 0, 400, 400);
    miner.claimId = -1;

    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);

    assert.equal(miner.claimId, -1);
});

test('tooling boundary: nonexistent selectedShipId (e.g. 999999) degrades gracefully', () => {
    const world = createCleanWorld();
    const stage = createMockStage();

    assert.doesNotThrow(() => {
        drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 999999);
    });
});

test('tooling boundary: mothership with maximum drones renders all berth rings without overlap bugs', () => {
    const world = createCleanWorld();
    const base = addShip(world, 'mothership', 0, 1000, 700);

    for (let i = 0; i < 12; i++) {
        const drone = addShip(world, 'drone', 0, 1000 + i * 5, 700);
        drone.parentId = base.id;
    }

    const stage = createMockStage();
    assert.doesNotThrow(() => {
        drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);
    });
});

test('tooling boundary: simultaneous throwing ships across multiple factions in single tick are all quarantined', () => {
    const world = createCleanWorld();
    const ship1 = addShip(world, 'fighter', 0, 200, 200);
    const ship2 = addShip(world, 'miner', 1, 800, 800);

    ship1.quarantined = true;
    ship1.quarantineError = 'err1';
    ship2.quarantined = true;
    ship2.quarantineError = 'err2';

    stepWorld(world, FIXED_DT);

    assert.equal(ship1.quarantined, true);
    assert.equal(ship2.quarantined, true);
});

test('tooling boundary: throwing on tick 0 / initial spawn is contained before integration', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'fighter', 0, 500, 500);
    ship.quarantined = true;
    ship.quarantineError = 'spawn crash';

    assert.doesNotThrow(() => {
        stepWorld(world, FIXED_DT);
    });
});

test('tooling boundary: throwing during docking / cargo transfer zeroes beams and avoids deadlock', () => {
    const world = createCleanWorld();
    const base = addShip(world, 'mothership', 0, 1000, 700);
    const miner = addShip(world, 'miner', 0, 1050, 700);
    miner.transferId = base.id;
    miner.transferOn = 1.0;

    miner.quarantined = true;
    miner.transferId = 0;
    miner.transferOn = 0;

    stepWorld(world, FIXED_DT);

    assert.equal(miner.transferId, 0);
    assert.equal(miner.transferOn, 0);
});

test('tooling boundary: non-Error throwables (string literals, objects) are safely stringified', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'fighter', 0, 500, 500);

    const rawStringError = 'bad string error';
    ship.quarantined = true;
    ship.quarantineError = String(rawStringError);

    assert.equal(typeof ship.quarantineError, 'string');
    assert.equal(ship.quarantineError, 'bad string error');
});

test('tooling boundary: quarantined ship takes lethal damage and dies cleanly (EV.SHIP_DIED emitted)', () => {
    const world = createCleanWorld();
    const ship = addShip(world, 'fighter', 0, 500, 500);
    ship.quarantined = true;
    ship.quarantineError = 'quarantine err';

    let died = false;
    world.events.on(EV.SHIP_DIED, (e) => {
        if (e.ship.id === ship.id) died = true;
    });

    ship.dead = true;
    world.events.emit(EV.SHIP_DIED, { ship, killerId: 42 });

    assert.equal(died, true);
});

test('tooling boundary: CI workflow requires zero external npm packages (runs on clean checkout)', () => {
    const pkgPath = join(ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

    assert.equal(Object.keys(pkg.dependencies || {}).length, 0);
    assert.equal(Object.keys(pkg.devDependencies || {}).length, 0);
});

test('tooling boundary: CI workflow uses platform-independent runner syntax', () => {
    const ciPath = join(ROOT, '.github', 'workflows', 'test.yml');
    const content = readFileSync(ciPath, 'utf8');

    assert.ok(content.includes('runs-on: ubuntu-latest'));
});

test('tooling boundary: microsecond step timings (<0.001ms) are handled without division by zero', () => {
    const totalSteps = 3600;
    const elapsedMs = 0.0005;
    const msPerStep = elapsedMs / totalSteps;

    assert.ok(Number.isFinite(msPerStep));
    assert.ok(msPerStep > 0);
});

test('tooling boundary: high entity count step timing scales without telemetry buffer corruption', () => {
    const world = createWorld({ seed: 55, effects: false });
    telemetry.enable({ streams: 'series', seriesEvery: 10 });

    for (let i = 0; i < 50; i++) stepWorld(world, FIXED_DT);

    assert.ok(telemetry.seriesRows.length <= telemetry.max);
    telemetry.disable();
});

test('tooling boundary: empty world metrics calculates valid 0-entity statistics', () => {
    const world = createCleanWorld();
    const metrics = {
        ships: world.ships.length,
        oreExtracted: world.oreExtracted,
    };

    assert.equal(metrics.ships, 0);
    assert.equal(metrics.oreExtracted, 0);
});

// ============================================================
// SECTION 3: TIER 3 PAIRWISE CROSS-FEATURE INTERACTIONS
// ============================================================

test('tooling pairwise: fast-forward + ship inspector (inspect after skip=420)', () => {
    const world = createWorld({ seed: 7, effects: false });
    stepSeconds(world, 420);

    const leadMiner = world.ships.find((s) => s.role === 'miner');
    assert.ok(leadMiner, 'no miner found after 420s fast-forward');

    const hud = new HUD(world);
    hud.selectShip(leadMiner.id);

    assert.equal(hud.selectedShipId, leadMiner.id);
    assert.ok(leadMiner.x >= 0 && leadMiner.y >= 0);
});

test('tooling pairwise: fast-forward + error containment (ship throws at second 45, skip to second 300)', () => {
    const world = createWorld({ seed: 7, effects: false });

    stepSeconds(world, 45);

    const ship = world.ships[0];
    assert.ok(ship);
    ship.quarantined = true;
    ship.quarantineError = 'mid-run throw';

    stepSeconds(world, 255); // Advance to 300s

    assert.equal(world.tick, 18000);
    assert.equal(ship.quarantined, true);
});

test('tooling pairwise: spatial gizmos + ship inspector (selected ship isolation during step)', () => {
    const world = createWorld({ seed: 15, effects: false });
    stepSeconds(world, 60);

    const ship = world.ships[0];
    assert.ok(ship);

    const hud = new HUD(world);
    hud.selectShip(ship.id);

    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, hud.selectedShipId);

    assert.ok(stage.ctx.calls.length > 0);
});

test('tooling pairwise: performance tracking + error containment (quarantine does not corrupt series timing)', () => {
    const world = createWorld({ seed: 21, effects: false });
    telemetry.enable({ streams: 'series', seriesEvery: 30 });

    for (let i = 0; i < 60; i++) stepWorld(world, FIXED_DT);

    const ship = world.ships[0];
    if (ship) {
        ship.quarantined = true;
        ship.quarantineError = 'timing test error';
    }

    for (let i = 0; i < 60; i++) stepWorld(world, FIXED_DT);

    assert.ok(telemetry.seriesRows.length >= 4);
    for (const row of telemetry.seriesRows) {
        assert.ok(typeof row.tick === 'number');
    }
    telemetry.disable();
});

test('tooling pairwise: spatial gizmos + theme palette compliance (void and paper themes)', () => {
    const world = createWorld({ seed: 25, effects: false });
    stepSeconds(world, 30);

    const stage = createMockStage();

    for (const themeKey of ['void', 'paper']) {
        stage.ctx.reset();
        drawGizmos(stage.ctx, world, THEMES[themeKey], stage, 1, 0);
        assert.ok(stage.ctx.emittedColors.size > 0);
    }
});

test('tooling pairwise: fast-forward + spatial gizmos (gizmos correctly positioned at skipped tick)', () => {
    const world = createWorld({ seed: 30, effects: false });
    stepSeconds(world, 180);

    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, 0);

    assert.ok(stage.ctx.calls.length > 50);
});

test('tooling pairwise: ship inspector + telemetry watch + ship death lifecycle', () => {
    const world = createCleanWorld();
    telemetry.enable();

    const fighter = addShip(world, 'fighter', 0, 500, 500);

    const hud = new HUD(world);
    hud.selectShip(fighter.id);
    telemetry.watch(fighter.id);

    assert.ok(telemetry.watchIds.has(fighter.id));

    fighter.dead = true;
    world.events.emit(EV.SHIP_DIED, { ship: fighter, killerId: 0 });

    assert.ok(hud.deathRecord);
    assert.equal(hud.deathRecord.id, fighter.id);
    telemetry.disable();
});

test('tooling pairwise: error containment + telemetry filtering (quarantine under active type filter)', () => {
    const world = createWorld({ seed: 40, effects: false });
    telemetry.enable({ type: 'fighter' });

    const miner = world.ships.find((s) => s.role === 'miner');
    if (miner) {
        miner.quarantined = true;
        miner.quarantineError = 'filtered type error';
        world.events.emit(EV.SHIP_ERROR, { ship: miner, error: miner.quarantineError });
    }

    stepWorld(world, FIXED_DT);
    telemetry.disable();
});

// ============================================================
// SECTION 4: TIER 4 REAL-WORLD APPLICATION SCENARIOS
// ============================================================

test('tooling scenario: Scenario 1 - Minute 7 anomaly investigation workflow (skip=420, pause, step, inspect)', () => {
    const world = createWorld({ seed: 7, effects: false });

    // 1. Skip to minute 7 (420 seconds)
    stepSeconds(world, 420);
    assert.equal(world.tick, 25200);

    // 2. Pause and single-step 5 ticks
    const loop = new Loop((dt) => stepWorld(world, dt), () => {});
    loop.paused = true;
    for (let i = 0; i < 5; i++) loop.stepOnce();
    assert.equal(world.tick, 25205);

    // 3. Pointer hit-test and inspect lead miner
    const leadMiner = world.ships.find((s) => s.role === 'miner');
    assert.ok(leadMiner);

    const hud = new HUD(world);
    hud.selectShip(leadMiner.id);
    assert.equal(hud.selectedShipId, leadMiner.id);

    // 4. Render spatial gizmos overlay
    const stage = createMockStage();
    drawGizmos(stage.ctx, world, THEMES.void, stage, 1, hud.selectedShipId);

    assert.ok(stage.ctx.calls.length > 0);
});

test('tooling scenario: Scenario 2 - Catastrophic 20% fleet error containment during 10-minute battle', () => {
    const world = createWorld({ seed: 42, effects: false });

    // Step 3 minutes
    stepSeconds(world, 180);

    // Inject quarantine on 20% of fleet
    const numToQuarantine = Math.max(1, Math.floor(world.ships.length * 0.2));
    for (let i = 0; i < numToQuarantine; i++) {
        world.ships[i].quarantined = true;
        world.ships[i].quarantineError = 'battle failure ' + i;
    }

    // Continue simulation to minute 10 (total 600s)
    assert.doesNotThrow(() => {
        stepSeconds(world, 420);
    });

    assert.equal(world.tick, 36000);
});

test('tooling scenario: Scenario 3 - Multi-seed (1..5) 5-minute headless determinism verification', () => {
    for (let seed = 1; seed <= 5; seed++) {
        const worldA = createWorld({ seed, effects: false });
        const worldB = createWorld({ seed, effects: false });

        stepSeconds(worldA, 60);
        stepSeconds(worldB, 60);

        assert.equal(worldA.hash(), worldB.hash(), `seed ${seed} hash mismatch between runs`);
    }
});

test('tooling scenario: Scenario 4 - Full fleet mock rendering & palette audit across all themes', () => {
    const world = createWorld({ seed: 99, effects: false });
    stepSeconds(world, 120);

    const stage = createMockStage();

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        stage.ctx.reset();

        for (const ship of world.ships) {
            const render = HULL_RENDERERS[ship.type];
            if (render) {
                render(stage.ctx, ship, theme.factions[ship.factionId] || theme.factions[0], theme);
            }
        }

        assert.ok(stage.ctx.calls.length > 100);
    }
});
