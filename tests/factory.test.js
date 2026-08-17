// ============================================================
// TESTS — THE YARD AND THE LINE SHIP
// ============================================================
//
// The destroyer is the first hull in the project that a faction
// cannot simply decide to build. Everything else is a row in
// PRODUCTION_POLICY with a price and a posture gate; this one needs a
// *building* standing first.
//
// That precondition is the whole feature, so it is what these tests
// are about. A destroyer that can appear without a yard is not an
// expensive fighter with extra steps — it is the mechanic silently
// not existing, and nothing else in the run would look wrong.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { PRODUCTION_POLICY, FACTORY_POLICY } from '../src/data/production.js';
import { SHIP_TYPES } from '../src/data/ships.js';
import { isPlayed } from '../src/data/factions.js';
import { FIXED_DT, FACTORY_OFFSET } from '../src/core/constants.js';
import { telemetry } from '../src/core/telemetry.js';

telemetry.quiet = true;

const DT = FIXED_DT;

test('yard: nothing but a factory can produce a destroyer', () => {
    // The gate, stated against the data rather than against a run —
    // a run can only ever show that it did not happen to occur.
    assert.ok(!PRODUCTION_POLICY.some((r) => r.type === 'destroyer'),
        'a station can build destroyers directly, so the yard is decorative');
    assert.ok(FACTORY_POLICY.some((r) => r.type === 'destroyer'),
        'the yard cannot build the one hull it exists for');

    // And the yard itself must be buyable somewhere, or the whole
    // branch is unreachable.
    assert.ok(PRODUCTION_POLICY.some((r) => r.type === 'factory'),
        'nothing can build a factory');
});

test('yard: a destroyer is never built without a yard standing', () => {
    // The invariant, checked continuously rather than at the end: at
    // no point in a run may a faction hold a destroyer without ever
    // having held a factory. Sampling only the final state would miss
    // a destroyer produced before the yard existed.
    const everHadYard = new Set();

    for (const seed of [1, 2, 3]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(700 / DT); i++) {
            stepWorld(world, DT);
            if (i % 30) continue;

            for (const f of world.factions) {
                if (!isPlayed(f)) continue;
                const key = seed + ':' + f.id;
                if ((f.counts.factory || 0) > 0) everHadYard.add(key);
                if ((f.counts.destroyer || 0) > 0) {
                    assert.ok(everHadYard.has(key),
                        `seed ${seed}: faction ${f.id} fielded a destroyer with no yard ever built`);
                }
            }
        }
    }
});

test('yard: the factory is planted behind the line, not on the frontier', () => {
    // A shed belongs where the ore is; a yard belongs where it is
    // defended. They share `launch`, and routing the factory through
    // `outpostSite` would have put the slowest, softest structure in
    // the game out at the frontier — which is the one place it must
    // not be, and which nothing else in a run would report.
    let checked = 0;

    // Three seeds and 700 s, which is enough: measured, the first
    // yard goes up between 150 s and 420 s on most seeds. Running
    // longer buys more yards to check and no new way for the siting
    // to be wrong, and this file is otherwise the slowest in the
    // suite for no reason anybody benefits from.
    for (const seed of [2, 3, 4]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(700 / DT); i++) stepWorld(world, DT);

        for (const yard of world.ships) {
            if (yard.dead || yard.role !== 'factory') continue;
            const faction = world.faction(yard.factionId);
            const home = world.ship(faction.motherships[0]);
            if (!home) continue;

            const d = Math.hypot(yard.x - home.x, yard.y - home.y);
            assert.ok(d < FACTORY_OFFSET * 1.5,
                `seed ${seed}: yard sat ${Math.round(d)} from its station `
                + `(expected within ${Math.round(FACTORY_OFFSET * 1.5)})`);
            checked++;
        }
    }
    assert.ok(checked > 0, 'no factory was ever built — the test proved nothing');
});

test('yard: a destroyer is a line ship, not an escort', () => {
    // The heaviest hull in the fleet tied to a mining barge is the
    // most expensive way to do a fighter's job. Asserted against the
    // table, because the escort roll reads `def.escorts` directly.
    assert.equal(SHIP_TYPES.destroyer.escorts, 0,
        'destroyers are eligible to escort miners');

    // And it is genuinely the heavy: above the frigate on every axis
    // that matters, or the rung is decorative.
    const d = SHIP_TYPES.destroyer;
    const f = SHIP_TYPES.frigate;
    assert.ok(d.hp > f.hp, 'destroyer is not tougher than a frigate');
    assert.ok(d.cost > f.cost, 'destroyer is not dearer than a frigate');
    assert.ok(d.radius > f.radius, 'destroyer does not read as larger than a frigate');
    assert.ok(d.mounts.length >= f.mounts.length, 'destroyer is not better armed than a frigate');
});
