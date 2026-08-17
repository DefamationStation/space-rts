// ============================================================
// TESTS — CORE
// ============================================================
//
// The generator and the broadphase. Both are load-bearing for
// everything else: if the RNG is not reproducible the determinism
// test is meaningless, and if the grid misses neighbours then
// collision, targeting and separation all quietly misbehave in
// ways that look like AI bugs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../src/core/rng.js';
import { SpatialGrid } from '../src/core/spatial.js';

test('rng: the same seed produces the same sequence', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 500; i++) assert.equal(a.next(), b.next());
});

test('rng: different seeds diverge', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    assert.equal(same, 0);
});

test('rng: seed 0 is replaced rather than producing a constant stream', () => {
    // mulberry32 has a fixed point at 0; a world seeded from a
    // query string could easily hand us one.
    const rng = new Rng(0);
    const values = new Set();
    for (let i = 0; i < 20; i++) values.add(rng.next());
    assert.equal(values.size, 20);
});

test('rng: output stays in [0, 1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 2000; i++) {
        const v = rng.next();
        assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
});

test('rng: fork produces an independent stream', () => {
    const parent = new Rng(7);
    const forked = parent.fork();
    // Forking must not simply mirror the parent — effects draw from
    // a fork precisely so they cannot perturb the simulation.
    const a = [];
    const b = [];
    for (let i = 0; i < 20; i++) { a.push(parent.next()); b.push(forked.next()); }
    assert.notDeepEqual(a, b);
});

// ------------------------------------------------------------

/** Brute-force reference for what a radius query ought to return. */
function bruteForce(entities, x, y, r) {
    return entities
        .filter((e) => !e.dead && Math.hypot(e.x - x, e.y - y) <= r)
        .map((e) => e.id)
        .sort((p, q) => p - q);
}

test('spatial: circle query returns every entity a brute-force scan finds', () => {
    const rng = new Rng(3);
    const grid = new SpatialGrid(130);
    grid.resize(2400, 1400);

    const entities = [];
    for (let i = 0; i < 400; i++) {
        entities.push({ id: i + 1, x: rng.range(0, 2400), y: rng.range(0, 1400), dead: false });
    }
    grid.rebuild(entities);

    for (let trial = 0; trial < 40; trial++) {
        const x = rng.range(0, 2400);
        const y = rng.range(0, 1400);
        const r = rng.range(20, 400);

        const found = [];
        grid.queryCircle(x, y, r, (e) => {
            // The grid is a broadphase: it yields cell candidates, and
            // callers do the exact test. Mirror that here.
            if (Math.hypot(e.x - x, e.y - y) <= r) found.push(e.id);
        });
        found.sort((p, q) => p - q);

        assert.deepEqual(found, bruteForce(entities, x, y, r),
            `mismatch at (${x.toFixed(0)}, ${y.toFixed(0)}) r=${r.toFixed(0)}`);
    }
});

test('spatial: nearest agrees with a brute-force scan', () => {
    const rng = new Rng(11);
    const grid = new SpatialGrid(130);
    grid.resize(2400, 1400);

    const entities = [];
    for (let i = 0; i < 250; i++) {
        entities.push({ id: i + 1, x: rng.range(0, 2400), y: rng.range(0, 1400), dead: false });
    }
    grid.rebuild(entities);

    for (let trial = 0; trial < 40; trial++) {
        const x = rng.range(0, 2400);
        const y = rng.range(0, 1400);
        const maxR = rng.range(100, 900);

        const got = grid.nearest(x, y, maxR, () => true);

        let want = null;
        let bestD = maxR;
        for (const e of entities) {
            const d = Math.hypot(e.x - x, e.y - y);
            if (d < bestD) { bestD = d; want = e; }
        }

        assert.equal(got ? got.id : null, want ? want.id : null);
    }
});

test('spatial: dead entities are excluded on rebuild', () => {
    const grid = new SpatialGrid(100);
    grid.resize(500, 500);
    const entities = [
        { id: 1, x: 50, y: 50, dead: false },
        { id: 2, x: 55, y: 55, dead: true },
    ];
    grid.rebuild(entities);

    const seen = [];
    grid.queryCircle(50, 50, 40, (e) => seen.push(e.id));
    assert.deepEqual(seen, [1]);
});
