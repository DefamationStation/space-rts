// ============================================================
// ADVERSARIAL STRESS TESTS — SPATIAL GIZMOS LAYER (T1-3)
// ============================================================
//
// Empirical verification test suite for src/render/gizmos.js:
// 1. State immutability & PRNG isolation under Object.freeze
// 2. Palette compliance & hex literal absence across void/paper
// 3. Robustness against corrupt/out-of-bounds IDs, empty worlds,
//    degenerate geometries, zero-division, and malformed inputs
// 4. Multi-seed simulation invariance verification

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEMES } from '../src/data/themes.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { FIXED_DT, FIELD_SCATTER, MINER_STANDOFF, MINING_RADIUS, ENGAGE_LEASH, ESCORT_RADIUS } from '../src/core/constants.js';
import { parseHex } from '../src/core/color.js';
import { MockContext2D } from './render.test.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GIZMOS_FILE = join(ROOT, 'src', 'render', 'gizmos.js');

// ------------------------------------------------------------
// HELPER: Deep Freeze
// ------------------------------------------------------------
function deepFreeze(obj, seen = new Set()) {
    if (obj === null || typeof obj !== 'object' || seen.has(obj)) {
        return obj;
    }
    if (ArrayBuffer.isView(obj)) {
        return obj;
    }
    seen.add(obj);
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
        const val = obj[key];
        if (val !== null && typeof val === 'object' && !Object.isFrozen(val)) {
            deepFreeze(val, seen);
        }
    }
    return obj;
}

// ------------------------------------------------------------
// HELPER: Mutation-Trapping Proxy
// ------------------------------------------------------------
//
// `Object.freeze` catches a write only in strict mode and says
// nothing about *which* property was written. A Proxy that throws on
// `set`/`defineProperty`/`deleteProperty` names the offender, so the
// two immutability tests below are complementary rather than
// redundant: freeze proves nothing is written, the trap proves what.
//
// It lives here and not in `gizmos_scale.test.js` for a reason worth
// keeping — see the header of that file.
function createStrictReadOnlyProxy(target, path = 'world') {
    if (target === null || typeof target !== 'object') {
        return target;
    }
    return new Proxy(target, {
        get(obj, prop, receiver) {
            const val = Reflect.get(obj, prop, obj);
            if (typeof val === 'function') {
                return val.bind(obj);
            }
            if (typeof val === 'object' && val !== null) {
                return createStrictReadOnlyProxy(val, `${path}.${String(prop)}`);
            }
            return val;
        },
        set(obj, prop) {
            throw new Error(`MUTATION VIOLATION: Attempted to write property "${String(prop)}" on ${path}`);
        },
        defineProperty(obj, prop) {
            throw new Error(`MUTATION VIOLATION: Attempted to define property "${String(prop)}" on ${path}`);
        },
        deleteProperty(obj, prop) {
            throw new Error(`MUTATION VIOLATION: Attempted to delete property "${String(prop)}" on ${path}`);
        },
    });
}

// ------------------------------------------------------------
// HELPER: Palette Validation
// ------------------------------------------------------------
function extractRgb(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return null;
    const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (match) {
        return {
            r: parseInt(match[1], 10),
            g: parseInt(match[2], 10),
            b: parseInt(match[3], 10),
            a: match[4] !== undefined ? parseFloat(match[4]) : 1.0,
        };
    }
    return null;
}

function isColorFromTheme(colorStr, theme) {
    const parsed = extractRgb(colorStr);
    if (!parsed) return false;

    // Alpha must be in valid [0, 1] range
    if (isNaN(parsed.a) || parsed.a < 0 || parsed.a > 1) return false;

    const themeHexes = [
        theme.ground,
        theme.grid,
        theme.hud?.text,
        theme.hud?.dim,
        theme.neutral?.rock,
        theme.neutral?.rockEdge,
        theme.neutral?.vein,
        theme.neutral?.debris,
    ].filter((s) => typeof s === 'string' && s.startsWith('#'));

    for (const f of theme.factions) {
        for (const k of ['plate', 'hull', 'accent', 'weapon', 'flash', 'thruster']) {
            if (typeof f[k] === 'string' && f[k].startsWith('#')) {
                themeHexes.push(f[k]);
            }
        }
    }

    const themeRgbs = themeHexes.map((hex) => parseHex(hex));

    for (const tr of themeRgbs) {
        if (Math.abs(parsed.r - tr.r) <= 1 &&
            Math.abs(parsed.g - tr.g) <= 1 &&
            Math.abs(parsed.b - tr.b) <= 1) {
            return true;
        }
    }

    return false;
}

// ============================================================
// TEST 1: IMMUTABILITY & PRNG PURITY UNDER DEEP FREEZE
// ============================================================

test('gizmos: gizmos: drawGizmos guarantees strict state immutability on deeply frozen world', () => {
    const world = createWorld({ seed: 501, effects: false });
    for (let i = 0; i < 400; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1, toWorld: () => ({ x: 0, y: 0 }) };
    const ctx = new MockContext2D();

    // Deep freeze world, all ships, all fields, all asteroids
    deepFreeze(world);

    // Spy on Math.random
    const originalMathRandom = Math.random;
    let mathRandomCalled = false;
    Math.random = () => {
        mathRandomCalled = true;
        return 0.5;
    };

    try {
        // Assert no TypeErrors or mutation exceptions are thrown when drawing with frozen world
        assert.doesNotThrow(() => {
            for (const themeKey of ['void', 'paper']) {
                const theme = THEMES[themeKey];
                for (const alpha of [0, 0.5, 1.0]) {
                    drawGizmos(ctx, world, theme, stage, alpha, 0);
                    if (world.ships.length > 0) {
                        drawGizmos(ctx, world, theme, stage, alpha, world.ships[0].id);
                        drawGizmos(ctx, world, theme, stage, alpha, world.ships[world.ships.length - 1].id);
                    }
                }
            }
        }, 'drawGizmos attempted to mutate frozen world or threw error');

        assert.equal(mathRandomCalled, false, 'drawGizmos invoked Math.random()');
    } finally {
        Math.random = originalMathRandom;
    }
});

test('gizmos: drawGizmos writes nothing through a mutation-trapping Proxy, over 100 ticks', () => {
    // Moved here from `gizmos_scale.test.js`, which holds the suite's
    // only performance budget. Pushing Proxy-wrapped objects through
    // `drawGizmos` leaves its inline caches megamorphic for the rest
    // of the process: measured steady-state cost went 14.04 ms → 28.48
    // ms per pass at 2,000 ships, permanently, and the 50 ms budget in
    // that file failed intermittently because of it.
    const world = createWorld({ seed: 777, effects: false });
    for (let i = 0; i < 100; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1 };
    const ctx = new MockContext2D();

    for (let tick = 0; tick < 100; tick++) {
        stepWorld(world, FIXED_DT);
        const proxyWorld = createStrictReadOnlyProxy(world);

        for (const theme of Object.values(THEMES)) {
            for (const alpha of [0, 0.5, 1]) {
                assert.doesNotThrow(() => {
                    drawGizmos(ctx, proxyWorld, theme, stage, alpha, 0);
                    if (world.ships.length > 0) {
                        drawGizmos(ctx, proxyWorld, theme, stage, alpha, world.ships[0].id);
                    }
                });
            }
        }
    }
});

test('gizmos: gizmos: drawGizmos does not advance world.rng or world.fxRng', () => {
    const world = createWorld({ seed: 502, effects: false });
    for (let i = 0; i < 300; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1 };
    const ctx = new MockContext2D();
    const theme = THEMES.void;

    const rngStateBefore = world.rng.state;
    const fxRngStateBefore = world.fxRng.state;
    const hashBefore = world.hash();

    for (let i = 0; i < 100; i++) {
        drawGizmos(ctx, world, theme, stage, 0.75, world.ships[i % world.ships.length]?.id || 0);
    }

    assert.equal(world.rng.state, rngStateBefore, 'world.rng advanced during drawGizmos');
    assert.equal(world.fxRng.state, fxRngStateBefore, 'world.fxRng advanced during drawGizmos');
    assert.equal(world.hash(), hashBefore, 'world.hash changed after drawGizmos');
});

// ============================================================
// TEST 2: PALETTE COMPLIANCE & HEX LITERAL AUDIT
// ============================================================

test('gizmos: gizmos: src/render/gizmos.js contains zero hardcoded hex literals', () => {
    const src = readFileSync(GIZMOS_FILE, 'utf8');
    // Strip comments
    const noComments = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hexMatches = noComments.match(/#[0-9a-fA-F]{3,8}\b/g);
    assert.deepEqual(hexMatches || [], [], `Found forbidden hex literals in gizmos.js: ${hexMatches}`);
});

test('gizmos: gizmos: all emitted stroke/fill colors strictly belong to active theme', () => {
    const world = createWorld({ seed: 503, effects: false });
    for (let i = 0; i < 350; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1.5 };

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        const ctx = new MockContext2D();

        drawGizmos(ctx, world, theme, stage, 0.5, world.ships[0]?.id || 1);

        assert.ok(ctx.emittedColors.size > 0, `No colors emitted for ${themeKey}`);
        for (const color of ctx.emittedColors) {
            assert.ok(
                isColorFromTheme(color, theme),
                `Color "${color}" is not in palette of theme "${themeKey}"`,
            );
        }
    }
});

// ============================================================
// TEST 3: ADVERSARIAL EDGE CASES & CORRUPT DATA ROBUSTNESS
// ============================================================

test('gizmos: gizmos: handles null/undefined world and empty entity lists gracefully', () => {
    const stage = { pixel: 1 };
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    assert.doesNotThrow(() => {
        drawGizmos(ctx, null, theme, stage, 1, 0);
        drawGizmos(ctx, undefined, theme, stage, 1, 0);
    });

    const emptyWorld = {
        ships: [],
        fields: [],
        asteroids: [],
        ship: () => null,
    };

    assert.doesNotThrow(() => {
        drawGizmos(ctx, emptyWorld, theme, stage, 1, 0);
        drawGizmos(ctx, emptyWorld, theme, stage, 1, 999);
    });

    assert.equal(ctx.matrixStack.length, 0, 'save/restore matrix stack unbalanced on empty world');
});

test('gizmos: gizmos: handles all-dead ships and depleted fields without error', () => {
    const world = createWorld({ seed: 504, effects: false });
    const stage = { pixel: 1 };
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    // Mark all ships dead
    for (const s of world.ships) {
        s.dead = true;
        s.hp = 0;
    }
    // Deplete all fields
    for (const f of world.fields) {
        f.ore = 0;
        f.rocks = 0;
    }

    assert.doesNotThrow(() => {
        drawGizmos(ctx, world, theme, stage, 1, world.ships[0]?.id || 1);
    });

    // Drawing operations for live entities should be skipped
    const strokes = ctx.calls.filter((c) => c.op === 'stroke');
    assert.equal(strokes.length, 0, 'Dead ships and depleted fields should produce 0 strokes');
    assert.equal(ctx.matrixStack.length, 0, 'save/restore unbalanced');
});

test('gizmos: gizmos: handles invalid references, NaN/Infinity coordinates, and corrupted ship properties', () => {
    const world = createWorld({ seed: 505, effects: false });
    for (let i = 0; i < 200; i++) stepWorld(world, FIXED_DT);

    const stage = { pixel: 1 };
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    // Corrupt ship properties intentionally
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (i % 6 === 0) {
            // Corrupt miner claims & home
            s.claimId = -999;
            s.homeId = 999999;
        } else if (i % 6 === 1) {
            // Out of bounds claim index
            s.claimId = world.fields.length + 50;
            s.homeId = -1;
        } else if (i % 6 === 2) {
            // Corrupt fighter targets & escorts
            s.targetId = -50;
            s.escortId = 999999;
            s.anchorX = NaN;
            s.anchorY = Infinity;
        } else if (i % 6 === 3) {
            // Corrupt drone parent
            s.parentId = -1;
        } else if (i % 6 === 4) {
            // Corrupt faction ID (out of bounds)
            s.factionId = 99;
        } else if (i % 6 === 5) {
            // Coincident coordinates with home (standoff zero division test)
            const home = world.ship(s.homeId);
            if (home) {
                s.x = home.x;
                s.y = home.y;
                s.prevX = home.x;
                s.prevY = home.y;
                if (world.fields[s.claimId]) {
                    world.fields[s.claimId].x = home.x;
                    world.fields[s.claimId].y = home.y;
                }
            }
        }
    }

    assert.doesNotThrow(() => {
        drawGizmos(ctx, world, theme, stage, 0.5, -999);
        drawGizmos(ctx, world, theme, stage, 0.5, 999999);
        drawGizmos(ctx, world, theme, stage, 0.5, NaN);
    }, 'drawGizmos threw error on corrupted entity references');

    assert.equal(ctx.matrixStack.length, 0, 'save/restore unbalanced');
});

test('gizmos: gizmos: handles extreme/degenerate stage and alpha parameters', () => {
    const world = createWorld({ seed: 506, effects: false });
    for (let i = 0; i < 150; i++) stepWorld(world, FIXED_DT);

    const theme = THEMES.void;
    const ctx = new MockContext2D();

    const stagePermutations = [
        null,
        undefined,
        {},
        { pixel: 0 },
        { pixel: -1 },
        { pixel: 100 },
    ];

    const alphaPermutations = [0, 1, 0.5, -10, 10, NaN, Infinity];

    for (const stage of stagePermutations) {
        for (const alpha of alphaPermutations) {
            assert.doesNotThrow(() => {
                drawGizmos(ctx, world, theme, stage, alpha, 0);
            }, `Failed on stage=${JSON.stringify(stage)}, alpha=${alpha}`);
            assert.equal(ctx.matrixStack.length, 0, 'save/restore unbalanced');
        }
    }
});

// ============================================================
// TEST 4: MULTI-SEED SIMULATION DETERMINISM INTEGRITY
// ============================================================

test('gizmos: gizmos: repeated gizmo rendering across simulation steps causes zero divergence', () => {
    for (const seed of [101, 102, 103]) {
        const worldA = createWorld({ seed, effects: false });
        const worldB = createWorld({ seed, effects: false });
        const stage = { pixel: 1 };
        const theme = THEMES.void;
        const ctx = new MockContext2D();

        for (let tick = 0; tick < 300; tick++) {
            stepWorld(worldA, FIXED_DT);
            stepWorld(worldB, FIXED_DT);

            // worldA gets gizmos rendered every tick with various selected ship IDs
            const selId = worldA.ships[tick % Math.max(1, worldA.ships.length)]?.id || 0;
            drawGizmos(ctx, worldA, theme, stage, 0.6, selId);

            // worldB runs headless without gizmos
        }

        assert.equal(
            worldA.hash(),
            worldB.hash(),
            `Determinism diverged on seed ${seed} when gizmos were rendered`,
        );
    }
});
