// ============================================================
// TESTS — POSTURE, FULL-WORLD RUN: SIEGE CLOSING
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
import { FIXED_DT, DEFEND_RANGE } from '../src/core/constants.js';

const DT = FIXED_DT;

test('posture: a besieging fleet actually closes on the station', () => {
    // The observable consequence of the above, stated as a distance:
    // if SIEGE means anything, somebody gets within weapon range of
    // the thing being besieged.
    // 900 s over three seeds. The window had to grow with the fleet:
    // once corvettes and frigates entered the mix, a besieging force
    // is slower, tougher and takes longer to grind through the escorts
    // in its way — at 660 s over two seeds the nearest approach was
    // 1,514 units, and the same seeds reach the hull given time.
    let closest = Infinity;
    for (const seed of [1, 2, 3]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(900 / DT); i++) {
            stepWorld(world, DT);
            if (i % 30) continue;
            for (const station of world.ships) {
                if (station.role !== 'mothership') continue;
                for (const other of world.ships) {
                    if (other.dead || !other.weapon || other.factionId === station.factionId) continue;
                    closest = Math.min(closest, Math.hypot(other.x - station.x, other.y - station.y));
                }
            }
        }
    }
    assert.ok(closest < DEFEND_RANGE,
        `no armed hostile ever came within DEFEND_RANGE of a station (closest ${Math.round(closest)})`);
});
