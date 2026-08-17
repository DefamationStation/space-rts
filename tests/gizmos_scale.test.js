// ============================================================
// GIZMOS AT SCALE
// ============================================================
//
// Empirical verification of:
// 1. Extreme entity scaling & stress performance (2,000 ships)
// 2. Cyclic & degenerate entity reference graphs (self-escort, self-target, cyclic parentage)
// 3. Canvas state stack depth balance under all fault conditions
//
// ------------------------------------------------------------
// NOTHING IN THIS FILE MAY WRAP AN ARGUMENT TO `drawGizmos`
// ------------------------------------------------------------
//
// This is the only file in the suite carrying a performance budget,
// and a budget is only as trustworthy as the process it is measured
// in. `drawGizmos` walks ship after ship reading the same handful of
// properties, so it lives or dies on its inline caches — and one
// pass over Proxy-wrapped objects makes those caches megamorphic for
// the **remainder of the process**, whatever is drawn afterwards.
//
// Measured at 2,000 ships: 14.04 ms per pass in a clean process,
// 28.48 ms after a single Proxy-driven test had run. The budget is
// 50 ms, so on an unloaded machine that still passed, and under any
// real load it did not — 56 ms, and 530 ms once. It read as a flaky
// perf test, which is the worst thing for a perf test to read as,
// because the next failure gets waved through.
//
// The mutation-trap test that caused it now lives in
// `gizmos.test.js`, next to the deep-freeze test it complements, in
// a file with no timing assertions to poison. If a budget here ever
// fails for no visible reason, check this rule first.
//
// The same caution applies to `Object.freeze`, `Object.defineProperty`
// with accessors, and anything else that changes the *shape* of what
// `drawGizmos` is handed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { THEMES } from '../src/data/themes.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { createWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { MockContext2D } from './render.test.js';

test('gizmos scale: cyclic and degenerate reference topologies do not crash or infinite-loop', () => {
    const world = createWorld({ seed: 888, effects: false });
    const stage = { pixel: 1 };
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    // Fabricate pathological reference graphs
    const s1 = world.addShip(makeShip(world, 'fighter', 0, 100, 100));
    const s2 = world.addShip(makeShip(world, 'fighter', 0, 200, 200));
    const s3 = world.addShip(makeShip(world, 'miner', 0, 300, 300));
    const s4 = world.addShip(makeShip(world, 'drone', 0, 400, 400));

    // Mutual escort loop
    s1.escortId = s2.id;
    s2.escortId = s1.id;

    // Self target & self claim & self parent
    s1.targetId = s1.id;
    s3.claimId = 0;
    s3.homeId = s3.id; // miner is its own home
    s4.parentId = s4.id; // drone is its own parent

    assert.doesNotThrow(() => {
        drawGizmos(ctx, world, theme, stage, 0.5, s1.id);
        drawGizmos(ctx, world, theme, stage, 0.5, s3.id);
        drawGizmos(ctx, world, theme, stage, 0.5, s4.id);
    });

    assert.equal(ctx.matrixStack.length, 0, 'Canvas state unbalanced on cyclic entities');
});

/**
 * How much slower this process is running than an idle one.
 *
 * A fixed integer loop with no allocation, no I/O and nothing to do
 * with rendering, so the only thing that moves it is how much of a
 * core this process is actually getting. 19 ms is what it costs on an
 * unloaded machine; the whole suite running alongside takes it to
 * about 69 ms, a factor of 3.6.
 *
 * Never returns less than 1: a machine faster than the reference
 * should not be handed a *tighter* budget than the one that was
 * reasoned about, or the test starts failing for being on good
 * hardware.
 */
const REFERENCE_CALIBRATION_MS = 19;

function machineFactor() {
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
        const t0 = performance.now();
        let acc = 0;
        for (let i = 0; i < 3000000; i++) acc += (i * 2654435761) % 1024;
        const dt = performance.now() - t0;
        if (acc >= 0) best = Math.min(best, dt);
    }
    return Math.max(1, best / REFERENCE_CALIBRATION_MS);
}

test('gizmos scale: extreme entity density stress test (2,000 ships) executes under 50ms', () => {
    const world = createWorld({ seed: 999, effects: false });
    const stage = { pixel: 1 };
    const theme = THEMES.void;
    const ctx = new MockContext2D();

    // Spawn 2,000 ships with diverse roles and links
    for (let i = 0; i < 500; i++) {
        const miner = world.addShip(makeShip(world, 'miner', i % 2, i * 10, i * 10));
        miner.claimId = i % Math.max(1, world.fields.length);
        const drone = world.addShip(makeShip(world, 'drone', i % 2, i * 10 + 5, i * 10 + 5));
        drone.parentId = miner.id;
        const fighter = world.addShip(makeShip(world, 'fighter', (i + 1) % 2, i * 10 + 20, i * 10 + 20));
        fighter.anchorX = i * 10;
        fighter.anchorY = i * 10;
        fighter.escortId = miner.id;
        fighter.targetId = drone.id;
    }

    assert.ok(world.ships.length >= 1500, `Expected >= 1500 ships, got ${world.ships.length}`);

    // Warm-up passes, outside the timer.
    //
    // The budget is a claim about what the overlay costs when it is
    // running, not about how long V8 takes to compile it. Without
    // these the first of ten timed passes is an unoptimised one and
    // the average came out at 36 ms against a 50 ms budget — 72% of
    // the allowance spent on JIT, leaving so little headroom that
    // background load alone could fail the run. Warmed, the same work
    // measures 14 ms. The budget did not move; the measurement stopped
    // being mostly noise.
    for (let warm = 0; warm < 3; warm++) {
        ctx.reset();
        drawGizmos(ctx, world, theme, stage, 0.5, world.ships[0].id);
    }

    // The recorder is reset between passes, and the reset is outside
    // the clock.
    //
    // `MockContext2D` keeps every operation, path, point and colour it
    // is handed, in arrays it never trims. Left to accumulate over
    // thirteen passes of a 1,500-ship overlay those arrays reach
    // millions of entries, and the per-call cost of appending to them
    // starts to dominate the very thing being timed: measured 770 ms
    // for work that costs 5 ms against a real context. The budget was
    // no longer a claim about `drawGizmos`, it was a claim about the
    // instrument.
    //
    // Which is the same failure mode this file's header is about. A
    // budget is only as trustworthy as the process it is measured in,
    // and a recorder that gets slower the longer it records is exactly
    // as poisonous as a megamorphic inline cache — it just takes a
    // change in scene complexity, rather than a Proxy, to expose it.
    // The *fastest* pass, and a budget scaled to the machine.
    //
    // Same argument as the paragraph above, one level out. This file
    // runs beside fourteen others — `node --test` gives every file its
    // own process and starts them all at once — so a fixed millisecond
    // budget is not a claim about `drawGizmos`, it is a claim about how
    // busy the box was. It duly fired at 59 ms for work that costs
    // about fourteen. Nothing had regressed; thirty-two cores were
    // saturated.
    //
    // Taking the minimum of ten passes was the first attempt and it was
    // not enough: under a full suite *every* pass is slowed, so there
    // is no uninterrupted one to find. It still fired, at 54 ms.
    //
    // So the budget is calibrated instead. `machineFactor()` times a
    // fixed arithmetic loop that has nothing to do with rendering, and
    // the ratio against its unloaded cost says how much slower this
    // process is running right now — measured at 1.0 idle and 3.6 with
    // the rest of the suite alongside. A genuine regression in
    // `drawGizmos` moves the measured time without moving that ratio,
    // which is exactly the thing the assertion should be sensitive to.
    let bestMs = Infinity;
    for (let renderPass = 0; renderPass < 10; renderPass++) {
        ctx.reset();
        const t0 = performance.now();
        drawGizmos(ctx, world, theme, stage, 0.5, world.ships[0].id);
        bestMs = Math.min(bestMs, performance.now() - t0);
    }

    const budget = 50 * machineFactor();
    assert.ok(bestMs < budget,
        `drawGizmos took too long for 1500+ entities: ${bestMs.toFixed(2)}ms `
        + `(budget: ${budget.toFixed(1)}ms, machine factor ${machineFactor().toFixed(2)}x). `
        + 'Expected ~14ms. If this is 2x over and the overlay itself looks unchanged, check '
        + 'whether anything earlier in this file passed a Proxy or otherwise reshaped an '
        + 'argument to drawGizmos — see the header.');
    assert.equal(ctx.matrixStack.length, 0, 'Canvas stack unbalanced after high load');
});
