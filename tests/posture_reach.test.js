// ============================================================
// TESTS — POSTURE, FULL-WORLD RUN: POSTURE REACHABILITY
// ============================================================
//
// Split out of posture.test.js purely for wall-clock. `node --test`
// runs *files* concurrently and the tests inside one file serially,
// so two multi-seed world runs sharing a file are two runs waiting
// on each other while thirty cores sit idle. Nothing about the
// assertions changed; they are slow because they simulate, and the
// only way to make a simulation of fifteen minutes take less than
// fifteen minutes of somebody's attention is to run it beside the
// others rather than after them.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { POSTURES } from '../src/data/postures.js';
import { FIXED_DT } from '../src/core/constants.js';

const DT = FIXED_DT;

test('posture: every posture is reachable in a real run', () => {
    // The failure that already happened. The first version anchored a
    // besieging fleet's *leash* on the enemy station but left its
    // steering pointed at its own miners, so no fleet ever arrived,
    // so no station was ever threatened, so DEFEND could not fire.
    // Two of five postures were unreachable and everything still
    // looked fine — no crash, no failing test, no visible symptom.
    // 900 s, matching the siege-closing test below. Every time the
    // fleet has got slower or more deliberate — heavier hulls, a
    // rally before a siege, a garrison that stays home — the time to
    // observe the full posture range has grown with it. All five are
    // reached comfortably at 900 s and DEFEND is the marginal one at
    // 660 s.
    // Six seeds, because RAID is genuinely rare and a small sample
    // cannot tell "unreachable" from "narrow". Its band is only
    // [1.4, 2.0) of strength ratio, and a truce collapses a native's
    // hostile strength to the swarm's alone — which usually lands
    // above the band, in SIEGE. Measured across six seeds and fifteen
    // minutes: siege 7775 faction-seconds, expand 1913, rebuild 800,
    // defend 221, raid 92. Reachable, and only just.
    const seen = new Set();
    for (const seed of [1, 2, 3, 4, 5, 6]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(900 / DT); i++) {
            stepWorld(world, DT);
            if (i % 15 === 0) {
                for (const f of world.factions) if (!f.alien) seen.add(f.posture);
            }
        }
    }
    const missing = POSTURES.filter((p) => !seen.has(p));
    assert.deepEqual(missing, [], 'postures no run ever reaches');
});
