// ============================================================
// TESTS — POSTURE
// ============================================================
//
// A faction-level state machine is harder to test than a ship-level
// one, because there is no single object you can put in a situation
// and step. What there *is* is a classifier with named inputs, so
// these tests build the inputs directly and assert the strategy that
// falls out — then a handful of full-world runs check that every
// posture is actually reachable, which is the failure that already
// happened once and was invisible from the inside.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from '../src/sim/simulate.js';
import { updatePostures } from '../src/sim/posture.js';
import { POSTURE, POSTURES } from '../src/data/postures.js';
import { PRODUCTION_POLICY } from '../src/data/production.js';
import {
    FIXED_DT, POSTURE_DWELL, SIEGE_ENTER, SIEGE_EXIT, RAID_ENTER, RAID_EXIT,
    SIEGE_COOLDOWN,
    DEFEND_RANGE,
} from '../src/core/constants.js';

const DT = FIXED_DT;

/** A world whose factions can be posed directly, with no ships in the way. */
function posed(seed = 7) {
    const world = createWorld({ seed, effects: false });
    for (const f of world.factions) {
        f.counts.miner = 2;
        f.strength = 100;
        f.hostileStrength = 100;
        f.posture = POSTURE.EXPAND;
        f.postureSince = -1000;          // dwell already served
    }
    // Park the stations' damage clocks far in the past so DEFEND does
    // not fire from the world's own history.
    for (const s of world.ships) s.lastHitAt = -1e9;
    return world;
}

test('posture: an even fight is EXPAND', () => {
    const world = posed();
    updatePostures(world);
    assert.equal(world.factions[0].posture, POSTURE.EXPAND);
});

test('posture: a clear advantage escalates to RAID, a decisive one to SIEGE', () => {
    const world = posed();
    const f = world.factions[0];

    f.strength = 100 * RAID_ENTER;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.RAID, 'did not raid at the raid threshold');

    f.postureSince = -1000;
    f.strength = 100 * SIEGE_ENTER;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.SIEGE, 'did not siege at the siege threshold');
});

test('posture: losing every miner is REBUILD, whatever the fleet says', () => {
    // Ordering matters: an economy that no longer exists outranks a
    // fleet advantage, because there is nothing left to press one for.
    const world = posed();
    const f = world.factions[0];
    f.strength = 100 * SIEGE_ENTER * 2;
    f.counts.miner = 0;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.REBUILD);
});

test('posture: an armed hostile at the station forces DEFEND over any advantage', () => {
    const world = posed();
    const f = world.factions[0];
    const station = world.ship(f.motherships[0]);

    // A hostile warship parked just inside the perimeter.
    const enemy = world.ships.find((s) => s.role === 'fighter' && s.factionId !== f.id)
        || world.ships.find((s) => s.factionId !== f.id && s.weapon);
    enemy.x = station.x + DEFEND_RANGE * 0.5;
    enemy.y = station.y;
    world.refreshGrids();

    f.strength = 100 * SIEGE_ENTER * 2;   // would otherwise be sieging
    updatePostures(world);
    assert.equal(f.posture, POSTURE.DEFEND);
});

test('posture: a faction with no warships never adopts an offensive posture', () => {
    // The opening-seconds bug: at t=0 nobody has built a hull, so
    // hostile strength is zero, so the ratio is Infinity, so both
    // sides "committed to a siege" with nothing to commit. Harmless in
    // effect and wrong in the trace, which for a layer whose whole job
    // is to say what a faction is doing is the same thing as broken.
    const world = posed();
    const f = world.factions[0];
    f.strength = 0;
    f.hostileStrength = 0;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.EXPAND);
});

test('posture: the bands are hysteretic, so a faction on a threshold does not oscillate', () => {
    const world = posed();
    const f = world.factions[0];

    f.strength = 100 * SIEGE_ENTER;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.SIEGE);

    // Between the exit and the entry: a single threshold would drop
    // it, a band holds it.
    f.postureSince = -1000;
    f.strength = 100 * ((SIEGE_ENTER + SIEGE_EXIT) / 2);
    updatePostures(world);
    assert.equal(f.posture, POSTURE.SIEGE, 'dropped the siege inside the band');

    // Below the exit it genuinely breaks off.
    f.postureSince = -1000;
    f.strength = 100 * (RAID_EXIT * 0.9);
    updatePostures(world);
    assert.notEqual(f.posture, POSTURE.SIEGE, 'held a siege below the exit ratio');
});

test('posture: the dwell holds a non-urgent change, and urgent ones jump it', () => {
    const world = posed();
    const f = world.factions[0];
    f.postureSince = world.time;          // just changed

    f.strength = 100 * SIEGE_ENTER;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.EXPAND, 'escalated inside the dwell');

    // REBUILD is an emergency and does not wait.
    f.counts.miner = 0;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.REBUILD, 'emergency waited out the dwell');

    // And once the dwell has elapsed, ordinary changes land.
    f.counts.miner = 2;
    f.postureSince = world.time - POSTURE_DWELL - 1;
    updatePostures(world);
    assert.equal(f.posture, POSTURE.SIEGE);
});

test('posture: every production rule names a posture that exists', () => {
    // The same class of guard as `telemetry exemption lists name real
    // states`: a rule gated on a posture that has been renamed is a
    // rule that silently never fires again.
    const names = new Set(POSTURES);
    for (const rule of PRODUCTION_POLICY) {
        const src = rule.when ? rule.when.toString() : '';
        for (const m of src.matchAll(/POSTURE\.([A-Z_]+)/g)) {
            assert.ok(POSTURE[m[1]] !== undefined, 'unknown POSTURE.' + m[1]);
            assert.ok(names.has(POSTURE[m[1]]), 'POSTURE.' + m[1] + ' is not in POSTURES');
        }
    }
});

test('posture: a siege cannot immediately follow a siege', () => {
    // The fix for a strategy layer that had five postures and used
    // two. Measured over six seeds: siege 63% of faction-time and
    // raid 1%, because nothing stopped a siege following a siege and
    // a winning fleet's strength ratio sits far above any threshold
    // you can reasonably set — pushing SIEGE_ENTER from 2.6 to 3.8
    // *raised* the siege share rather than lowering it.
    const world = posed();
    const f = world.factions[0];

    f.posture = POSTURE.SIEGE;
    f.postureSince = -1000;              // commit already served
    f.strength = 400;
    f.hostileStrength = 100;             // ratio 4 — decisively ahead

    // Break it off, which stamps the cooldown.
    f.hostileStrength = 100000;          // ratio ~0, forces the exit
    updatePostures(world, DT);
    assert.notEqual(f.posture, POSTURE.SIEGE, 'the siege never ended');
    assert.ok(world.time - f.siegeEndedAt < 1, 'leaving a siege did not stamp the cooldown');

    // Now hand it back a decisive advantage immediately. It should
    // press the advantage as a *raid* rather than mounting a second
    // assault it is in no state to mount.
    f.hostileStrength = 100;             // ratio 4 again
    f.postureSince = -1000;
    updatePostures(world, DT);
    assert.equal(f.posture, POSTURE.RAID,
        `expected RAID during the cooldown, got ${f.posture}`);

    // And once rested, it may commit again.
    f.siegeEndedAt = world.time - SIEGE_COOLDOWN - 1;
    f.postureSince = -1000;
    updatePostures(world, DT);
    assert.equal(f.posture, POSTURE.SIEGE, 'a rested fleet still refused to besiege');
});

test('posture: breaking off a siege lands in a raid, not back at expand', () => {
    // SIEGE_EXIT and RAID_ENTER were both 1.4, so the raid band sat
    // entirely inside the siege's hold: a faction dropping out of a
    // siege was below RAID_ENTER on the same step and fell straight
    // to EXPAND. RAID was only reachable by climbing through 1.4 from
    // below without overshooting, which a fleet exchange rarely does.
    assert.ok(SIEGE_EXIT > RAID_ENTER,
        `SIEGE_EXIT (${SIEGE_EXIT}) must clear RAID_ENTER (${RAID_ENTER}) `
        + 'or a decaying siege skips the raid band entirely');

    const world = posed();
    const f = world.factions[0];
    f.posture = POSTURE.SIEGE;
    f.postureSince = -1000;
    f.strength = 100;

    // Decay to just under the siege's exit, but still comfortably a
    // raiding advantage.
    f.hostileStrength = 100 / ((SIEGE_EXIT + RAID_ENTER) / 2);
    updatePostures(world, DT);
    assert.equal(f.posture, POSTURE.RAID,
        `a siege decaying to ${(f.strength / f.hostileStrength).toFixed(2)} became ${f.posture}`);
});
