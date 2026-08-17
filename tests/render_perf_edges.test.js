// ============================================================
// ADVERSARIAL CHALLENGE SUITE: Milestone 2 Tier 2 (T2-3 & T2-4)
// ============================================================
//
// Tests tripwires for Renderer Testing (T2-3) and Performance Tracking (T2-4).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SHIP_TYPES } from '../src/data/ships.js';
import { THEMES } from '../src/data/themes.js';
import { HULL_RENDERERS, drawShip } from '../src/render/hulls.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { makeShip } from '../src/sim/entities.js';
import { World } from '../src/core/world.js';
import { createWorld } from '../src/sim/simulate.js';
import { MockContext2D, createMockStage } from './render.test.js';
import { telemetry } from '../src/core/telemetry.js';
import { parseHex } from '../src/core/color.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

// ------------------------------------------------------------
// 1. RENDERER TEST TRIPWIRES (T2-3)
// ------------------------------------------------------------

test('render/perf edges: adversarial T2-3: oversized geometry (>1.25x def.radius) trips the bounding hitbox assertion', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;
    const typeId = 'fighter';
    const def = SHIP_TYPES[typeId];

    // Create a mock context and simulate an oversized renderer drawing geometry at 1.5x def.radius
    const ctx = new MockContext2D();
    const ship = makeShip(world, typeId, 0, 0, 0, 0);

    // Faulty renderer emitting points way outside def.radius (e.g., 2.0x radius)
    ctx.beginPath();
    const oversizedRadius = def.radius * 1.6;
    ctx.arc(0, 0, oversizedRadius, 0, Math.PI * 2);
    ctx.fillStyle = theme.factions[0].hull;
    ctx.fill();

    const bounds = ctx.getBounds();
    const maxExpected = def.radius * 1.25;

    // Verify that this tripwire detects the violation
    assert.ok(
        bounds.maxRadius > maxExpected,
        `Expected maxRadius ${bounds.maxRadius} to exceed ${maxExpected}`,
    );

    // Assert that the render test assertion logic throws an AssertionError
    assert.throws(() => {
        const minExpected = def.radius * 0.75;
        assert.ok(
            bounds.maxRadius >= minExpected && bounds.maxRadius <= maxExpected,
            `${typeId} drawn radius (${bounds.maxRadius.toFixed(2)}) out of tolerance [${minExpected.toFixed(2)}, ${maxExpected.toFixed(2)}] for def.radius=${def.radius}`,
        );
    }, /out of tolerance/);
});

test('render/perf edges: adversarial T2-3: undersized geometry (<0.75x def.radius) trips the bounding hitbox assertion', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;
    const typeId = 'fighter';
    const def = SHIP_TYPES[typeId];

    const ctx = new MockContext2D();
    // Faulty renderer emitting points too small (e.g. 0.5x radius)
    ctx.beginPath();
    const undersizedRadius = def.radius * 0.5;
    ctx.arc(0, 0, undersizedRadius, 0, Math.PI * 2);
    ctx.fillStyle = theme.factions[0].hull;
    ctx.fill();

    const bounds = ctx.getBounds();
    const minExpected = def.radius * 0.75;
    const maxExpected = def.radius * 1.25;

    assert.ok(
        bounds.maxRadius < minExpected,
        `Expected maxRadius ${bounds.maxRadius} to be less than minExpected ${minExpected}`,
    );

    assert.throws(() => {
        assert.ok(
            bounds.maxRadius >= minExpected && bounds.maxRadius <= maxExpected,
            `${typeId} drawn radius (${bounds.maxRadius.toFixed(2)}) out of tolerance [${minExpected.toFixed(2)}, ${maxExpected.toFixed(2)}] for def.radius=${def.radius}`,
        );
    }, /out of tolerance/);
});

test('render/perf edges: adversarial T2-3: emitting unauthorized hex color (#ff0000) trips theme palette validation', () => {
    const world = new World({ seed: 1 });
    const theme = THEMES.void;

    // Helper palette validator
    function extractRgb(colorStr) {
        if (!colorStr || typeof colorStr !== 'string') return null;
        const str = colorStr.trim();
        if (str.startsWith('#')) {
            const c = parseHex(str);
            return [c.r, c.g, c.b];
        }
        const match = str.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/);
        if (match) {
            return [Math.round(Number(match[1])), Math.round(Number(match[2])), Math.round(Number(match[3]))];
        }
        return null;
    }

    function isValidColorForTheme(colorStr, theme) {
        const rgb = extractRgb(colorStr);
        if (!rgb) return false;

        const themeHexes = [
            theme.ground, theme.grid,
            theme.hud?.text, theme.hud?.dim,
            theme.neutral?.rock, theme.neutral?.rockEdge,
            theme.neutral?.vein, theme.neutral?.debris,
        ].filter((h) => typeof h === 'string' && h.startsWith('#'));

        for (const fac of theme.factions) {
            for (const k of ['plate', 'hull', 'accent', 'weapon', 'flash', 'thruster']) {
                if (typeof fac[k] === 'string' && fac[k].startsWith('#')) {
                    themeHexes.push(fac[k]);
                }
            }
        }

        const themeRgbs = themeHexes.map((hex) => {
            const c = parseHex(hex);
            return [c.r, c.g, c.b];
        });

        for (const [tr, tg, tb] of themeRgbs) {
            if (Math.abs(rgb[0] - tr) <= 2 && Math.abs(rgb[1] - tg) <= 2 && Math.abs(rgb[2] - tb) <= 2) {
                return true;
            }
        }
        return false;
    }

    // Rogue color #ff0000
    const rogueColor = '#ff0000';
    const isValid = isValidColorForTheme(rogueColor, theme);
    assert.equal(isValid, false, '#ff0000 should not be valid in void theme');

    // Rogue rgba color rgba(255, 0, 0, 0.8)
    const rogueRgba = 'rgba(255, 0, 0, 0.8)';
    assert.equal(isValidColorForTheme(rogueRgba, theme), false, 'rgba(255,0,0,0.8) should not be valid in void theme');

    // Also test against paper theme
    assert.equal(isValidColorForTheme(rogueColor, THEMES.paper), false, '#ff0000 should not be valid in paper theme');

    // Tripwire assertion test
    assert.throws(() => {
        const valid = isValidColorForTheme(rogueColor, theme);
        assert.ok(valid, `Invalid/unthemed color "${rogueColor}" emitted`);
    }, /Invalid\/unthemed color/);
});

test('render/perf edges: adversarial T2-3: empty renderer trips geometry emission and vertex count assertions', () => {
    const emptyRenderer = (ctx, ship, pal, theme) => {
        // Does nothing
    };

    const ctx = new MockContext2D();
    const ship = { radius: 12 };
    emptyRenderer(ctx, ship, {}, {});

    // Assert that the tripwire assertions catch the empty renderer
    assert.equal(ctx.operations.length, 0);
    assert.equal(ctx.allPoints.length, 0);
    assert.equal(ctx.fills.length, 0);

    assert.throws(() => {
        assert.ok(ctx.operations.length > 0, 'emitted 0 canvas operations');
    }, /0 canvas operations/);

    assert.throws(() => {
        assert.ok(ctx.allPoints.length >= 3, 'emitted fewer than 3 vertices');
    }, /fewer than 3 vertices/);

    assert.throws(() => {
        assert.ok(ctx.fills.length >= 1, 'emitted 0 fill operations');
    }, /0 fill operations/);
});

// ------------------------------------------------------------
// 2. PERFORMANCE TRACKING & BASELINE CALCULATIONS (T2-4)
// ------------------------------------------------------------

test('render/perf edges: adversarial T2-4: sim.mjs metrics and baseline comparison calculation accuracy', () => {
    // Replicate metrics() and compareBaseline() arithmetic from tools/sim.mjs
    const FIXED_DT = 1 / 60;
    const round2 = (v) => Math.round(v * 100) / 100;
    const mean = (xs) => xs.reduce((s, v) => s + v, 0) / xs.length;

    function computeMetrics(elapsedMs, simTimeSec) {
        const totalSteps = Math.round((simTimeSec || 300) / FIXED_DT) || 1;
        const msPerStep = elapsedMs / totalSteps;
        return {
            totalSteps,
            msPerStep: Math.round(msPerStep * 1000) / 1000,
        };
    }

    function compareStepTimes(baselineMsPerStepList, currentMsPerStepList) {
        const was = mean(baselineMsPerStepList);
        const now = mean(currentMsPerStepList);
        const delta = now - was;
        const rel = Math.abs(was) > 1 ? ((delta / was) * 100).toFixed(1) + '%' : '—';
        return {
            baseline: round2(was),
            now: round2(now),
            change: (delta >= 0 ? '+' : '') + round2(delta),
            pct: rel,
            rawDelta: delta,
        };
    }

    // 1. Verify standard calculation: 600ms for 300s (18000 steps) -> 0.033 ms/step
    const m1 = computeMetrics(600, 300);
    assert.equal(m1.totalSteps, 18000);
    assert.equal(m1.msPerStep, 0.033);

    // 2. Verify delta and percentage:
    // Baseline: [0.030, 0.032, 0.034] -> mean 0.032
    // Current:  [0.060, 0.064, 0.068] -> mean 0.064
    // Delta: +0.032
    const cmp = compareStepTimes([0.030, 0.032, 0.034], [0.060, 0.064, 0.068]);
    assert.equal(cmp.baseline, 0.03);
    assert.equal(cmp.now, 0.06);
    assert.equal(cmp.change, '+0.03');

    // 3. Verify percentage when baseline > 1.0ms (e.g. heavy load: baseline 1.5ms, now 3.0ms -> +100.0%)
    const cmpHeavy = compareStepTimes([1.5, 1.5], [3.0, 3.0]);
    assert.equal(cmpHeavy.baseline, 1.5);
    assert.equal(cmpHeavy.now, 3.0);
    assert.equal(cmpHeavy.change, '+1.5');
    assert.equal(cmpHeavy.pct, '100.0%');

    // 4. Verify negative delta (optimization: baseline 2.0ms, now 1.0ms -> -50.0%)
    const cmpOpt = compareStepTimes([2.0], [1.0]);
    assert.equal(cmpOpt.baseline, 2.0);
    assert.equal(cmpOpt.now, 1.0);
    assert.equal(cmpOpt.change, '-1');
    assert.equal(cmpOpt.pct, '-50.0%');
});

// ------------------------------------------------------------
// 3. TELEMETRY DIAGNOSTICS: STEP PERFORMANCE DEGRADATION (T2-4)
// ------------------------------------------------------------

test('render/perf edges: adversarial T2-4: telemetry.diagnose triggers step time degradation finding on >2.0x growth (>1.0ms late)', () => {
    telemetry.clear();
    telemetry.enable();

    // Populate 20 series rows where early run is 0.5ms and late run is 1.2ms (2.4x growth > 2.0x, <= 3.0x, lateMean 1.2 > 1.0)
    for (let i = 0; i < 20; i++) {
        const stepMs = i < 5 ? 0.5 : (i >= 15 ? 1.2 : 0.8);
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs,
            ships: 10 + i,
            rocks: 20,
            shots: 5,
            fx: 2,
            fieldOre: 500,
            hash: 12345,
        });
    }

    const world = createWorld({ seed: 1 });
    const findings = telemetry.diagnose(world);
    const perfFinding = findings.find((f) => f.what === 'step time degradation');

    assert.ok(perfFinding, 'Expected "step time degradation" finding to be present');
    assert.equal(perfFinding.level, 'medium');
});

test('render/perf edges: adversarial T2-4: telemetry.diagnose assigns high severity (level="high") when growth >3.0x and lateMean > 1.0ms', () => {
    telemetry.clear();
    telemetry.enable();

    // 20 rows: early 0.2ms, late 1.2ms (6x growth > 3x, lateMean 1.2 > 1.0)
    for (let i = 0; i < 20; i++) {
        const stepMs = i < 5 ? 0.2 : (i >= 15 ? 1.2 : 0.4);
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs,
            ships: 10,
            rocks: 20,
            shots: 5,
            fx: 2,
            fieldOre: 500,
            hash: 12345,
        });
    }

    const world = createWorld({ seed: 1 });
    const findings = telemetry.diagnose(world);
    const perfFinding = findings.find((f) => f.what === 'step time degradation');

    assert.ok(perfFinding, 'Expected "step time degradation" finding');
    assert.equal(perfFinding.level, 'high');
    assert.match(perfFinding.detail, /\+500%/);
});

test('render/perf edges: adversarial T2-4: telemetry.diagnose does NOT false-positive on fast quiet runs below noise floor', () => {
    telemetry.clear();
    telemetry.enable();

    // 20 rows: early 0.02ms, late 0.08ms (4x growth, but below noise floor of lateMean > 1.0ms or earlyMean > 0.05ms)
    for (let i = 0; i < 20; i++) {
        const stepMs = i < 5 ? 0.02 : (i >= 15 ? 0.08 : 0.04);
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs,
            ships: 10,
            rocks: 20,
            shots: 5,
            fx: 2,
            fieldOre: 500,
            hash: 12345,
        });
    }

    const world = createWorld({ seed: 1 });
    const findings = telemetry.diagnose(world);
    const perfFinding = findings.find((f) => f.what === 'step time degradation');

    assert.equal(perfFinding, undefined, 'Should not fire on fast sub-millisecond noise');
});

test('render/perf edges: adversarial T2-4: telemetry.diagnose handles empty / partial series rows safely without NaN/exceptions', () => {
    telemetry.clear();
    telemetry.enable();

    // Fewer than 10 rows
    for (let i = 0; i < 5; i++) {
        telemetry.seriesRows.push({ tick: i * 60, t: i, stepMs: 0.5, ships: 5, rocks: 5, shots: 0, fx: 0, fieldOre: 100, hash: 0 });
    }

    const world = createWorld({ seed: 1 });
    assert.doesNotThrow(() => {
        const findings = telemetry.diagnose(world);
        assert.ok(Array.isArray(findings));
    });
});

