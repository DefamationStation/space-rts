// ============================================================
// TESTS — SIMULATION
// ============================================================
//
// The whole simulation runs here under Node with no DOM and no
// stubbing, because `src/sim` imports nothing from `src/render`.
// That separation is worth the discipline it costs: these tests
// exercise the real code paths a real run takes, at hundreds of
// steps per millisecond.
//
// What is checked, and why each one earns its place:
//
//   determinism   a self-playing sim that cannot be replayed from
//                 a seed cannot be debugged at all
//   conservation  an economy that leaks or mints looks fine on
//                 screen for a long time before it obviously
//                 doesn't, and by then the cause is far behind you
//   collision     fast rounds versus small hulls is exactly where
//                 a naive point test silently fails
//   policy        production is a data table, so it should be
//                 testable as one
//   liveness      the run must never reach a dead state

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { applyMotion, orbit } from '../src/sim/steering.js';
import { stepProjectiles, tryFire, killShip } from '../src/sim/combat.js';
import { oreInTransit } from '../src/sim/economy.js';
import {
    FIXED_DT, START_METAL, THRUST_PROFILE, SPACE_DRAG, ARRIVE_GAIN, MINING_RADIUS,
    DRONE_MINE_RATE,
} from '../src/core/constants.js';
import { angleDelta, dist } from '../src/core/math.js';
import { telemetry } from '../src/core/telemetry.js';
import { FACTIONS, isPlayed } from '../src/data/factions.js';
import { WEAPON_TYPES } from '../src/data/weapons.js';
import { SHIP_TYPES } from '../src/data/ships.js';
import { BEHAVIORS } from '../src/sim/behaviors/index.js';
import { triggerIncursion } from '../src/sim/incursion.js';
import { EV } from '../src/core/events.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

const DT = FIXED_DT;

/**
 * Simulated seconds a test must run before it may assume a war.
 *
 * Several tests below are about the *recorder* — that kills are
 * attributed, that a continuing condition folds into one row — and
 * they get their material by running a real world until it fights.
 * How long that takes is a property of the map, and the map changed:
 * on the old 2400×1400 world the two factions were in contact within
 * a couple of minutes, so 150–300 s was ample. At 7200×4200 a miner
 * spends around 50 s each way reaching the contested middle, and
 * first contact across twelve seeds ranges from 111 s to 392 s.
 *
 * It has since had to grow again, for the same reason one layer up.
 * Heavy hulls retreat across the whole map to repair and a siege now
 * commits for two minutes, so a full REGROUP → repaired cycle takes
 * minutes: on seed 4242 no hull completed one inside 480 s and eight
 * did inside 900 s, which read as `fighter:regroup` being a state
 * with no exit.
 *
 * 720 s clears the slowest observed seed with room to spare. It is
 * deliberately one named constant rather than a number edited into
 * each test: when the map or the fleet next changes, the failure
 * should be one obvious thing to re-measure, not five tests failing
 * for what looks like five different reasons.
 *
 * `tests/sim.test.js` is the slowest file in the suite because of
 * this, and that is the trade — these assertions are worth more than
 * the seconds they cost.
 */
const WAR_SECONDS = 720;

/** Run a headless world for `seconds` and return it. */
function run(seconds, seed = 1) {
    const world = createWorld({ seed, effects: false });
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) stepWorld(world, DT);
    return world;
}

// ------------------------------------------------------------
// DETERMINISM
// ------------------------------------------------------------

test('determinism: identical seeds produce identical worlds', () => {
    const a = run(20, 4242);
    const b = run(20, 4242);
    assert.equal(a.hash(), b.hash());
    assert.equal(a.ships.length, b.ships.length);
    assert.equal(Math.round(a.oreExtracted), Math.round(b.oreExtracted));
});

test('determinism: different seeds produce different worlds', () => {
    const a = run(20, 1);
    const b = run(20, 2);
    assert.notEqual(a.hash(), b.hash());
});

test('determinism: effects do not perturb the simulation', () => {
    // Effects draw from a forked RNG stream precisely so that a
    // rendered run and a headless run stay in lockstep. If this ever
    // fails, someone has reached for world.rng inside sim/effects.js.
    const steps = Math.round(20 / DT);

    const plain = createWorld({ seed: 777, effects: false });
    for (let i = 0; i < steps; i++) stepWorld(plain, DT);

    const withFx = createWorld({ seed: 777, effects: true });
    for (let i = 0; i < steps; i++) stepWorld(withFx, DT);

    assert.equal(plain.hash(), withFx.hash());
});

test('determinism: recording a run does not change it', () => {
    // The flight recorder is a diagnostic, and a diagnostic that
    // perturbs the thing it measures is worse than none: every bug
    // you chase with it becomes a bug that might be the tool. It
    // reads, derives and stores, and touches nothing — this is what
    // says so.
    const steps = Math.round(30 / DT);

    telemetry.disable().clear();
    const quiet = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < steps; i++) stepWorld(quiet, DT);

    telemetry.enable();
    const recorded = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < steps; i++) stepWorld(recorded, DT);
    const captured = telemetry.rows.length;
    telemetry.disable().clear();

    assert.ok(captured > 100, `recorder captured almost nothing: ${captured} rows`);
    assert.equal(quiet.hash(), recorded.hash(), 'the recorder altered the run it was watching');
    assert.equal(quiet.ships.length, recorded.ships.length);
});


// ------------------------------------------------------------
// ECONOMY
// ------------------------------------------------------------

/**
 * Metal enters the world three ways and leaves two. See the ledger
 * note in sim/economy.js.
 */
function ledger(world) {
    const cargo = oreInTransit(world);

    let banked = 0;
    let spent = 0;
    let salvage = 0;
    for (const faction of world.factions) {
        banked += faction.metal;
        spent += faction.metalSpent;
        salvage += faction.salvageTotal;
    }

    // `tradedTotal` is the third way ore enters the world, beside
    // mining and the salvage trickle: the neutral market pays visiting
    // haulers out of a float, and that float is not something anybody
    // mined. Declared here rather than netted off quietly, for the
    // reason the header of sim/economy.js gives.
    const incoming = world.oreExtracted + salvage + world.tradedTotal
        + START_METAL * world.factions.length;
    const outgoing = cargo + banked + spent + world.oreLost;
    return { incoming, outgoing, delta: incoming - outgoing };
}

test('economy: the ledger balances after a long run', () => {
    const world = run(240, 9);
    const { incoming, delta } = ledger(world);

    assert.ok(incoming > 200, `expected real mining activity, got ${incoming.toFixed(1)}`);
    assert.ok(Math.abs(delta) < 1e-6, `ledger drifted by ${delta}`);
});

test('economy: ore actually flows from rock to treasury', () => {
    const world = run(180, 5);
    assert.ok(world.oreExtracted > 100, `only ${world.oreExtracted.toFixed(1)} ore mined`);

    const mined = world.factions.reduce((sum, f) => sum + f.minedTotal, 0);
    assert.ok(mined > 50, `only ${mined.toFixed(1)} ore banked`);
});

test('economy: no asteroid is ever mined past empty', () => {
    const world = run(180, 6);
    for (const rock of world.asteroids) {
        assert.ok(rock.ore >= 0, `negative ore: ${rock.ore}`);
        assert.ok(rock.ore <= rock.oreMax + 1e-9, `ore exceeds capacity: ${rock.ore}`);
    }
});

test('economy: no ship ever carries more than its hold', () => {
    const world = run(180, 8);
    for (const ship of world.ships) {
        assert.ok(ship.cargo >= -1e-9, `negative cargo on ${ship.type}`);
        assert.ok(ship.cargo <= ship.cargoMax + 1e-9,
            `${ship.type} over capacity: ${ship.cargo} > ${ship.cargoMax}`);
    }
});

test('economy: drones spend sustained time cutting rocks and miners deliver full cargo to base', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const base = makeShip(world, 'mothership', 0, 300, 700, 0);
    base.fade = 1;
    world.addShip(base);
    world.factions[0].motherships.push(base.id);

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.homeId = base.id;
    miner.state = 'work';
    miner.claimId = 0;
    world.addShip(miner);

    const field = world.fields[0];
    field.x = 700;
    field.y = 700;
    field.claimedBy[miner.factionId] = miner.id;
    field.claimedAt[miner.factionId] = 0;

    // Field 0 must contain *only* this rock.
    //
    // The fixture clears the ships and then borrows a field and a rock
    // from worldgen, which was fine while a miner stationed itself on
    // the field's nominal centre — the test sets that centre and the
    // other rocks were irrelevant. A miner now stations on the centre
    // of mass of the rocks still standing, so worldgen's leftovers
    // dragged the hold point a thousand units away and the drone could
    // no longer reach the one rock the test cares about.
    //
    // Retiring them makes the scenario say what it means rather than
    // depending on how many rocks a seed happened to put in field 0.
    for (const other of world.asteroids) {
        if (other.fieldId === 0) other.fieldId = -1;
    }

    const rock = world.asteroids[0];
    rock.fieldId = 0;
    rock.x = 750;
    rock.y = 700;
    rock.ore = 100;
    rock.oreMax = 100;
    rock.depleting = false;
    rock.dead = false;
    world.byId.set(rock.id, rock);

    const drone = makeShip(world, 'drone', 0, 720, 700, 0);
    drone.fade = 1;
    drone.parentId = miner.id;
    drone.homeId = base.id;
    drone.state = 'mine';
    drone.beamTargetId = rock.id;
    world.addShip(drone);
    world.refreshGrids();

    // One second of cutting yields one second's worth of ore, not a
    // full hold. Written against the rate rather than against a copy
    // of it: the assertion is that extraction is *rated*, and hard-
    // coding 1.0 made it fail the day the rate was retuned for the
    // bigger map — which is the test objecting to a number it was
    // never about.
    for (let i = 0; i < 60; i++) stepWorld(world, DT);
    assert.ok(drone.cargo > DRONE_MINE_RATE * 0.8 && drone.cargo < DRONE_MINE_RATE * 1.2,
        `expected ~${DRONE_MINE_RATE.toFixed(1)} ore after 1s, got ${drone.cargo.toFixed(2)}`);
    assert.equal(drone.state, 'mine', 'drone should still be mining after 1s');

    // Fill miner to capacity: miner in 'work' waits for drone to dock
    miner.cargo = miner.cargoMax;
    miner.state = 'work';
    stepWorld(world, DT);
    assert.equal(miner.state, 'work', 'miner should wait for drone to dock before returning');

    // Drone returns and docks
    for (let i = 0; i < 120; i++) stepWorld(world, DT);
    assert.equal(miner.state, 'return', 'miner should transition to return once drone is docked');
});

test('economy: drones must dock to deposit cargo into miner without beaming', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.state = 'work';
    miner.claimId = 0;
    world.addShip(miner);

    const field = world.fields[0];
    field.x = 700;
    field.y = 700;
    field.claimedBy[miner.factionId] = miner.id;

    // Drone has 8 cargo and starts 80 units away
    const drone = makeShip(world, 'drone', 0, 780, 700, 0);
    drone.fade = 1;
    drone.parentId = miner.id;
    drone.state = 'to_parent';
    drone.cargo = 8;
    world.addShip(drone);
    world.refreshGrids();

    // While en route, cargo is NOT unloaded prematurely
    for (let i = 0; i < 10; i++) stepWorld(world, DT);
    assert.equal(drone.cargo, 8, 'drone should not unload while flying to parent');
    assert.equal(drone.state, 'to_parent', 'drone should still be flying to parent');

    // Step until drone docks in unload state
    while (drone.state === 'to_parent') {
        stepWorld(world, DT);
    }
    assert.equal(drone.state, 'unload', 'drone should enter unload when docked');
    assert.ok(!drone.transferId, 'drone should dock directly without a transfer beam ID');

    // In 0.2s of unloading at rate = 10, ~2.0 ore should be transferred
    for (let i = 0; i < 12; i++) stepWorld(world, DT);
    assert.ok(drone.cargo > 5.0 && drone.cargo < 7.0, `expected ~6.0 ore remaining, got ${drone.cargo.toFixed(2)}`);
    assert.ok(miner.cargo > 1.0 && miner.cargo < 3.0, `expected ~2.0 ore transferred, got ${miner.cargo.toFixed(2)}`);
});

test('economy: full miner flees immediately when under attack without waiting for drones', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const base = makeShip(world, 'mothership', 0, 300, 700, 0);
    base.fade = 1;
    world.addShip(base);
    world.factions[0].motherships.push(base.id);

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.homeId = base.id;
    miner.state = 'work';
    miner.cargo = miner.cargoMax;
    miner.claimId = 0;
    world.addShip(miner);

    const drone = makeShip(world, 'drone', 0, 850, 700, 0);
    drone.fade = 1;
    drone.parentId = miner.id;
    drone.state = 'to_rock';
    world.addShip(drone);

    // Hostile fighter approaches within MINER_FLEE_RADIUS (340 units)
    const hostile = makeShip(world, 'fighter', 1, 800, 700, 0);
    hostile.fade = 1;
    world.addShip(hostile);
    world.refreshGrids();

    stepWorld(world, DT);
    assert.equal(miner.state, 'flee', 'miner under attack should flee immediately without waiting for drones');
});

// ------------------------------------------------------------
// BEHAVIOUR — THINGS THE RECORDER FOUND
// ------------------------------------------------------------
//
// Five faults, none of which crashed anything, failed a test, or
// looked wrong on screen. Every one was found by `npm run sim`
// reading its own logs, and each test below states the invariant the
// fix restored rather than the symptom it produced.

test('behaviour: no state machine has a state it cannot leave', () => {
    // The mothership entered `building` on its first hull and stayed
    // there for the rest of the run. Nothing broke — it kept building
    // — but `?debug=1` and every occupancy figure reported a station
    // that had been busy for ten minutes.
    //
    // Stated as a general invariant, because the next dead end will
    // not be in the same file: over a long run, every state any role
    // *enters* must also be one some ship has *left*.
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    // A longer horizon than the other tests, because this one is
    // asking about *cycles* and the slowest honest cycle in the sim is
    // now much slower than a war.
    //
    // A hauler leaves `idle` when a forward store has enough ore to be
    // worth the trip. A shed has to be built first, then filled, and
    // on seed 4242 the first hauler run happens at 690 s — inside the
    // 720 s window by thirty seconds, which is not a margin, it is a
    // coincidence. Raising HAULER_MIN_LOAD moved it to 741 s and this
    // test reported `hauler:idle` as a dead end, which it is not: the
    // cycle had not finished starting.
    //
    // Tuning the constant back down until the test passed was the
    // available shortcut and the wrong one — the window was wrong, not
    // the game. A test for "can this machine get trapped" has to run
    // longer than the slowest thing that is merely slow.
    const CYCLE_SECONDS = 1200;

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(CYCLE_SECONDS / DT); i++) stepWorld(world, DT);

    // Roles whose exits depend on something that may simply not
    // happen in a given run.
    //
    // A wreck drifts, thins out and is gone: there is no state it can
    // be in afterwards, because there is no afterwards. An outpost
    // leaves `holding` only when something attacks it, and a run in
    // which nobody raids a shed is a perfectly ordinary run — the
    // machine is not stuck, the event did not occur.
    //
    // The invariant this test protects is that a state machine must
    // not be able to get *trapped*, and neither of these can be:
    // one has a lifespan, the other is waiting on the world. Inventing
    // a terminal state for either to "leave" would be writing code to
    // satisfy a test rather than to say something true.
    //
    // Declared as a list, in the same spirit as LOITER_STATES and
    // DESIGNED_CYCLES in core/telemetry.js: written down and narrow,
    // rather than a threshold nudged until the noise stops. Anything
    // not on it is a finding.
    const EPHEMERAL = new Set(['wreck', 'outpost']);

    const left = new Set(telemetry.stateRows.map((r) => r.role + ':' + r.from));
    const entered = new Set(telemetry.stateRows.map((r) => r.role + ':' + r.to));
    const deadEnds = [...entered]
        .filter((k) => !EPHEMERAL.has(k.split(':')[0]))
        .filter((k) => !left.has(k));
    assert.deepEqual(deadEnds, [], 'states that are entered and never left');

    telemetry.disable().clear();
});

test('behaviour: a drone waiting on its miner is stowed, not unloading', () => {
    // A drone whose parent is full has nothing to transfer and nowhere
    // to fly, so it rode along in `unload` for the miner's entire round
    // trip — single visits over a minute, and indistinguishable from a
    // jam. The work did not change; the state machine now says what
    // the drone is actually doing.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.state = 'work';
    miner.claimId = 0;
    miner.cargo = miner.cargoMax;          // no room for anything
    world.addShip(miner);

    const drone = makeShip(world, 'drone', 0, 705, 700, 0);
    drone.fade = 1;
    drone.parentId = miner.id;
    drone.state = 'unload';
    drone.cargo = 4;
    world.addShip(drone);
    world.refreshGrids();

    for (let i = 0; i < 240; i++) stepWorld(world, DT);
    assert.equal(drone.state, 'stowed', 'a drone with nowhere to put its cargo should stow');
    assert.equal(drone.cargo, 4, 'a stowed drone should still be holding its load');

    // And it goes straight back to work the moment the miner can take
    // it. The miner has since hauled its load off, so put it back on
    // station with an empty hold — that is the condition the drone is
    // waiting on, not the passage of time.
    miner.cargo = 0;
    miner.state = 'work';
    miner.claimId = 0;

    // Watched over the window rather than sampled at the end of it.
    //
    // The end-state assertion was wrong in a way that only showed up
    // once drones stopped launching into empty space: this drone
    // resumes on the *first* step, spends about half a second moving
    // its four ore across, and then correctly stows again, because
    // this fixture has no rock inside MINING_RADIUS for it to go to.
    // Sampling at step 30 caught it back in `stowed` and called that a
    // failure to resume, when what it had actually done was resume,
    // finish, and go back to waiting.
    //
    // What is under test is that being stowed is not a trap — so the
    // assertions are that it left, and that the ore moved.
    let resumed = false;
    for (let i = 0; i < 30; i++) {
        stepWorld(world, DT);
        if (drone.state === 'unload' || drone.state === 'to_rock' || drone.state === 'mine') resumed = true;
    }
    assert.ok(resumed, `stowed drone never resumed, sat in '${drone.state}'`);
    assert.ok(miner.cargo > 0,
        'the drone left stowed but never actually handed its load over');
});

test('behaviour: a re-homed drone closes on its new miner before working', () => {
    // An orphan re-homes to any friendly miner within 520 units, then
    // used to head straight out to a rock if its hold was empty — so it
    // spent the whole approach up to 500 units from a parent whose
    // tether is 250, which the rest of drone.js treats as inviolable.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.state = 'work';
    miner.claimId = 0;
    world.addShip(miner);

    // Orphaned, empty, and most of the re-home radius away.
    const drone = makeShip(world, 'drone', 0, 700 + 480, 700, 0);
    drone.fade = 1;
    drone.parentId = 9999;                 // a parent that does not exist
    drone.state = 'to_rock';
    world.addShip(drone);
    world.refreshGrids();

    stepWorld(world, DT);
    assert.equal(drone.parentId, miner.id, 'the orphan did not re-home');
    assert.equal(drone.state, 'to_parent', 'a re-homed drone should close on its parent first');

    // And it never works a rock from outside the tether on the way in.
    for (let i = 0; i < 900; i++) {
        stepWorld(world, DT);
        if (drone.state !== 'to_rock' && drone.state !== 'mine') continue;
        const d = Math.hypot(drone.x - miner.x, drone.y - miner.y);
        assert.ok(d <= MINING_RADIUS * 1.6,
            `drone worked from ${d.toFixed(0)}u, tether is ${MINING_RADIUS}`);
    }
});

test('behaviour: a fighter off its leash flies home instead of dithering', () => {
    // `pickTarget` bounds the *target* to the leash but nothing bounded
    // the fighter, so one that had drifted outside could acquire, be
    // dropped by PURSUE on its first step, and acquire again — thirteen
    // times a second. Both states hand off before they steer, so it
    // never flew home either: it just sat there changing its mind.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const base = makeShip(world, 'mothership', 0, 300, 700, 0);
    base.fade = 1;
    world.addShip(base);
    world.factions[0].motherships.push(base.id);

    const fighter = makeShip(world, 'fighter', 0, 2000, 700, 0);
    fighter.fade = 1;
    fighter.homeId = base.id;
    world.addShip(fighter);

    // Bait, well inside the fighter's search radius.
    const bait = makeShip(world, 'fighter', 1, 2100, 700, 0);
    bait.fade = 1;
    world.addShip(bait);
    world.refreshGrids();

    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const startD = dist(fighter.x, fighter.y, base.x, base.y);
    for (let i = 0; i < 600; i++) stepWorld(world, DT);
    const flips = telemetry.stateRows.filter((r) => r.id === fighter.id).length;
    telemetry.disable().clear();

    // Ten seconds of a hull that cannot legally fight is a handful of
    // decisions, not hundreds.
    assert.ok(flips < 40, `fighter changed state ${flips} times in ten seconds`);
    const endD = dist(fighter.x, fighter.y, base.x, base.y);
    assert.ok(endD < startD - 100,
        `fighter got no closer to what it guards: ${startD.toFixed(0)} → ${endD.toFixed(0)}`);
});

test('behaviour: a field claim cannot be taken by the other side', () => {
    // Claims are deliberately not respected across factions — that is
    // what puts two fleets on the same rocks. But both sides shared one
    // slot, so each overwrote the other every step and neither side's
    // miners could coordinate with their own. Per-faction slots keep
    // the contention and lose the churn.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const ours = makeShip(world, 'miner', 0, 700, 700, 0);
    const theirs = makeShip(world, 'miner', 1, 720, 700, 0);
    for (const m of [ours, theirs]) { m.fade = 1; world.addShip(m); }
    world.refreshGrids();

    telemetry.disable().clear();
    telemetry.enable({ motion: false });
    for (let i = 0; i < Math.round(60 / DT); i++) stepWorld(world, DT);

    // Both sides hold claims, and neither holds the other's slot.
    for (const field of world.fields) {
        for (let f = 0; f < field.claimedBy.length; f++) {
            const id = field.claimedBy[f];
            if (!id) continue;
            const holder = world.byId.get(id);
            assert.ok(holder, `field ${field.id} slot ${f} holds a ghost`);
            assert.equal(holder.factionId, f, 'a claim landed in the wrong faction slot');
        }
    }

    // And a settled miner is not re-claiming every step.
    const claims = telemetry.eventRows.filter((r) => r.event === 'claim').length;
    assert.ok(claims < 60, `${claims} claims in a minute for two miners — still churning`);
    telemetry.disable().clear();
});

// ------------------------------------------------------------
// COMBAT
// ------------------------------------------------------------

test('combat: swept collision catches a round that crosses a hull in one step', () => {
    // The anti-tunnelling case, set up so that *neither* endpoint of
    // the round's path is inside the hull: it starts short of the
    // drone and finishes past it, all within a single step. A test
    // against the round's position alone would report a clean miss.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const target = makeShip(world, 'drone', 1, 500, 500, 0);   // radius 4.5
    target.fade = 1;
    world.addShip(target);
    world.refreshGrids();

    const speed = 1200;                       // 20 world units per step
    const startX = 490;
    const endX = startX + speed * DT;
    assert.ok(startX < 500 - target.radius, 'setup: round should start clear of the hull');
    assert.ok(endX > 500 + target.radius, 'setup: round should finish clear of the hull');

    const weapon = WEAPON_TYPES.pulse;
    world.addProjectile({
        id: world.nextId(),
        x: startX, y: 500, prevX: startX, prevY: 500,
        vx: speed, vy: 0,
        damage: weapon.damage, weapon,
        factionId: 0, ownerId: 0,
        life: 1, maxLife: 1, dead: false,
    });

    const before = target.hp;
    stepProjectiles(world, DT);
    assert.ok(target.hp < before, 'round tunnelled through the hull');
});

test('combat: a round passing beside a hull does not hit it', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const target = makeShip(world, 'drone', 1, 500, 500, 0);
    target.fade = 1;
    world.addShip(target);
    world.refreshGrids();

    const weapon = WEAPON_TYPES.pulse;
    world.addProjectile({
        id: world.nextId(),
        // Offset well clear of the 4.5-unit hull radius.
        x: 480, y: 540, prevX: 480, prevY: 540,
        vx: weapon.speed, vy: 0,
        damage: weapon.damage, weapon,
        factionId: 0, ownerId: 0,
        life: 1, maxLife: 1, dead: false,
    });

    const before = target.hp;
    stepProjectiles(world, DT);
    assert.equal(target.hp, before, 'round hit a target it should have missed');
});

test('combat: rounds never damage their own faction', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const friend = makeShip(world, 'miner', 0, 500, 500, 0);
    friend.fade = 1;
    world.addShip(friend);
    world.refreshGrids();

    const weapon = WEAPON_TYPES.pulse;
    world.addProjectile({
        id: world.nextId(),
        x: 460, y: 500, prevX: 460, prevY: 500,
        vx: weapon.speed, vy: 0,
        damage: weapon.damage, weapon,
        factionId: 0, ownerId: 0,
        life: 1, maxLife: 1, dead: false,
    });

    const before = friend.hp;
    stepProjectiles(world, DT);
    assert.equal(friend.hp, before);
});

test('combat: fire control produces bursts separated by a cooldown', () => {
    // The rhythm is the point (see data/weapons.js), so this checks
    // the actual pattern of shot times rather than a raw count:
    // rounds inside a burst are close together, and each burst is
    // separated from the next by the full cooldown.
    const world = createWorld({ seed: 1, effects: false });
    const shooter = makeShip(world, 'fighter', 0, 500, 500, 0);
    world.addShip(shooter);

    const weapon = WEAPON_TYPES.pulse;
    const times = [];
    for (let i = 0; i < Math.round(4 / DT); i++) {
        world.time += DT;
        if (tryFire(world, shooter, 0)) times.push(world.time);
    }

    assert.ok(times.length >= 4, `expected several bursts, got ${times.length} shots`);

    const gapWithin = weapon.burstGapMs / 1000;
    const gapBetween = weapon.cooldownMs / 1000;
    const tolerance = DT * 1.5;

    // Split the timeline into bursts on every long gap.
    const bursts = [[times[0]]];
    for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (Math.abs(gap - gapWithin) <= tolerance) {
            bursts[bursts.length - 1].push(times[i]);
        } else if (Math.abs(gap - gapBetween) <= tolerance) {
            bursts.push([times[i]]);
        } else {
            assert.fail(`unexpected gap between shots: ${gap.toFixed(3)}s`);
        }
    }

    assert.ok(bursts.length >= 2, `expected at least two bursts, got ${bursts.length}`);
    // The last burst may be cut short by the end of the sample window.
    for (const burst of bursts.slice(0, -1)) {
        assert.equal(burst.length, weapon.burst,
            `a burst fired ${burst.length} rounds instead of ${weapon.burst}`);
    }
});

test('combat: fighter performs fly-by attack runs and extends past target', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const fighter = makeShip(world, 'fighter', 0, 400, 500, 0);
    fighter.fade = 1;
    world.addShip(fighter);

    const target = makeShip(world, 'miner', 1, 700, 500, 0);
    target.fade = 1;
    world.addShip(target);
    world.refreshGrids();

    let sawEngage = false;
    let sawShots = false;
    let sawExtend = false;
    let sawReengage = false;

    // Run combat sequence for ~4 seconds
    for (let i = 0; i < 240; i++) {
        stepWorld(world, DT);
        if (fighter.state === 'engage') sawEngage = true;
        if (world.projectiles.length > 0) sawShots = true;
        if (fighter.state === 'extend') sawExtend = true;
        if (sawExtend && fighter.state === 'engage') sawReengage = true;
    }

    assert.ok(sawEngage, 'fighter should enter engage state for fly-by attack run');
    assert.ok(sawShots, 'fighter should fire shots during attack run');
    assert.ok(sawExtend, 'fighter should zoom past target and enter extend state');
    assert.ok(sawReengage, 'fighter should loop back around and re-engage for another pass');
});

test('combat: opposing fighters execute crossing fly-by passes', () => {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();

    const f1 = makeShip(world, 'fighter', 0, 400, 500, 0);
    f1.fade = 1;
    world.addShip(f1);

    const f2 = makeShip(world, 'fighter', 1, 700, 500, Math.PI);
    f2.fade = 1;
    world.addShip(f2);
    world.refreshGrids();

    let crossed = false;
    for (let i = 0; i < 180; i++) {
        stepWorld(world, DT);
        // If f1's X coordinate crosses past f2's X coordinate while both are alive
        if (f1.x > f2.x && !f1.dead && !f2.dead) {
            crossed = true;
            break;
        }
    }

    assert.ok(crossed, 'opposing fighters should fly past each other in a crossing pass');
});


// ------------------------------------------------------------
// PRODUCTION
// ------------------------------------------------------------

test('production: a faction builds miners before warships', () => {
    const world = run(75, 3);
    // Natives only. Neither the swarm nor the exchange has a station,
    // an economy or any production — one arrives through a rift and
    // the other was here first — so asserting that they built miners
    // is asserting the wrong thing about both. `isPlayed` is the
    // question actually being asked: does this faction play?
    for (const faction of world.factions) {
        if (!isPlayed(faction)) continue;
        const miners = faction.counts.miner || 0;
        assert.ok(miners >= 1, `faction ${faction.id} built no miners`);
    }
});

test('production: both factions grow a fleet', () => {
    const world = run(300, 21);
    for (const faction of world.factions) {
        if (!isPlayed(faction)) continue;     // builds nothing, by design
        assert.ok(faction.builtTotal >= 3,
            `faction ${faction.id} built only ${faction.builtTotal} ships`);
    }
});

// ------------------------------------------------------------
// LIVENESS
// ------------------------------------------------------------

test('liveness: a wiped faction gets its station back', () => {
    const world = createWorld({ seed: 31, effects: false });

    // Destroy one faction's station outright.
    const victim = world.factions[1];
    for (const id of [...victim.motherships]) killShip(world, world.ship(id));
    world.compact();
    assert.equal(world.ships.filter((s) => s.factionId === 1 && s.role === 'mothership').length, 0);

    // Long enough to clear FACTION_RESPAWN_DELAY.
    for (let i = 0; i < Math.round(70 / DT); i++) stepWorld(world, DT);

    const rebuilt = world.ships.filter((s) => s.factionId === 1 && s.role === 'mothership');
    assert.equal(rebuilt.length, 1, 'faction never recovered its station');
    // The replacement arrives with a fresh stake, and the point of
    // that stake is that it gets spent — so check the faction is
    // *building* again rather than that it still holds the metal.
    assert.ok(world.factions[1].builtTotal > 0, 'recovered faction never resumed production');
});

test('liveness: a long run keeps both factions playing', () => {
    // The failure this guards against is not a crash. It is the run
    // quietly settling into one faction mining an empty map, which
    // is what happened before motherships could defend themselves.
    const world = run(600, 11);

    for (const def of FACTIONS) {
        if (!isPlayed(def)) continue;         // no station by design
        const faction = world.factions[def.id];
        assert.ok(faction.motherships.length > 0,
            `faction ${def.id} has no station after ten minutes`);
        assert.ok(faction.builtTotal >= 4,
            `faction ${def.id} only ever built ${faction.builtTotal} ships`);
    }

    assert.ok(world.asteroids.length > 0, 'the map ran out of ore entirely');
});

test('liveness: entity counts stay bounded', () => {
    const world = run(600, 12);
    assert.ok(world.ships.length < 120, `ship count ran away: ${world.ships.length}`);
    assert.ok(world.projectiles.length < 500);
    assert.ok(world.particles.length < 900);
});

test('liveness: no NaN ever enters a transform', () => {
    const world = run(300, 13);
    for (const ship of world.ships) {
        for (const key of ['x', 'y', 'vx', 'vy', 'angle', 'hp']) {
            assert.ok(Number.isFinite(ship[key]), `${ship.type}.${key} is ${ship[key]}`);
        }
    }
});

// ------------------------------------------------------------
// FLIGHT MODEL
// ------------------------------------------------------------
//
// The thrust envelope is the project's motion signature, and it is
// the kind of thing that decays silently: nothing crashes when a
// ship regains the ability to fly sideways at full power, the fleet
// just quietly goes back to looking like it is sliding on ice. So
// the envelope is asserted directly rather than inferred from how a
// run turns out.

/** A lone ship on a bare world, with its facing pinned by `aimAngle`. */
function bench(type = 'fighter', angle = 0) {
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();
    const ship = makeShip(world, type, 0, 1200, 700, angle);
    ship.fade = 1;
    world.addShip(ship);
    world.refreshGrids();
    return { world, ship };
}

/** Acceleration actually delivered for one over-sized request, in u/s². */
function deliver(ship, requestAngle, lockFacing = true) {
    ship.vx = ship.vy = 0;
    if (lockFacing) ship.aimAngle = ship.angle;
    // Ask for far more than any engine can give, so the answer is the
    // envelope itself rather than the size of the request.
    const push = ship.def.accel * 4;
    ship.ax = Math.cos(requestAngle) * push;
    ship.ay = Math.sin(requestAngle) * push;
    applyMotion(ship, DT);
    // Undo the one step of damping so this reports thrust, not thrust
    // minus drag.
    const k = Math.exp(SPACE_DRAG * DT) / DT;
    return { x: ship.vx * k, y: ship.vy * k };
}

test('flight: thrust is far stronger out the back than in any other direction', () => {
    const { ship } = bench('fighter');
    const p = ship.def.thrust;

    const fwd = deliver(ship, 0);
    const side = deliver(ship, Math.PI / 2);
    const back = deliver(ship, Math.PI);

    assert.ok(Math.abs(fwd.x - ship.def.accel * p.main) < 1,
        `main drive delivered ${fwd.x.toFixed(1)}, expected ${ship.def.accel * p.main}`);

    // The whole point of the model: sideways and backward are weak.
    const sideRatio = Math.abs(side.y) / Math.abs(fwd.x);
    const backRatio = Math.abs(back.x) / Math.abs(fwd.x);
    assert.ok(Math.abs(sideRatio - p.lateral) < 0.02,
        `lateral thrust was ${(sideRatio * 100).toFixed(0)}% of main, expected ${p.lateral * 100}%`);
    assert.ok(Math.abs(backRatio - p.retro) < 0.02,
        `retro thrust was ${(backRatio * 100).toFixed(0)}% of main, expected ${p.retro * 100}%`);
    assert.ok(sideRatio < 0.5 && backRatio < 0.5,
        'a warship should not be able to fly sideways or backwards at half power');
});

test('flight: no request in any direction escapes the envelope', () => {
    for (const type of Object.keys(SHIP_TYPES)) {
        const def = SHIP_TYPES[type];
        if (def.immobile) continue;
        const { ship } = bench(type);
        const p = def.thrust || THRUST_PROFILE;

        // Sweep the full circle, including the diagonals where a
        // per-axis clamp is easiest to get wrong.
        for (let i = 0; i < 64; i++) {
            const a = (i / 64) * Math.PI * 2;
            const got = deliver(ship, a);
            const fwd = got.x * Math.cos(ship.angle) + got.y * Math.sin(ship.angle);
            const lat = got.y * Math.cos(ship.angle) - got.x * Math.sin(ship.angle);
            assert.ok(fwd <= def.accel * p.main + 0.5,
                `${type} exceeded main thrust at ${a.toFixed(2)} rad: ${fwd.toFixed(1)}`);
            assert.ok(fwd >= -def.accel * p.retro - 0.5,
                `${type} exceeded retro thrust at ${a.toFixed(2)} rad: ${fwd.toFixed(1)}`);
            assert.ok(Math.abs(lat) <= def.accel * p.lateral + 0.5,
                `${type} exceeded lateral thrust at ${a.toFixed(2)} rad: ${lat.toFixed(1)}`);
        }
    }
});

test('flight: a ship turns to face the way it wants to thrust', () => {
    // Without this the envelope deadlocks — a ship that can only push
    // where its nose points, and only points where it is already
    // going, can never begin a turn at all.
    const { ship } = bench('fighter', 0);
    ship.aimAngle = null;

    for (let i = 0; i < 30; i++) {
        ship.ax = 0;
        ship.ay = ship.def.accel;          // due +Y, ninety degrees off the nose
        applyMotion(ship, DT);
    }

    assert.ok(ship.angle > 0.9 && ship.angle < Math.PI / 2 + 0.05,
        `nose swung to ${ship.angle.toFixed(2)} rad, expected to be tracking toward ${(Math.PI / 2).toFixed(2)}`);
    // And having turned, it is now making real progress that way.
    assert.ok(ship.vy > 40, `only reached ${ship.vy.toFixed(1)} u/s toward the target direction`);
});

test('flight: aimAngle holds the nose, and costs the ship its main drive', () => {
    // The combat case. A fighter aiming across its own course is
    // choosing to fly on jets alone, and that trade has to be real
    // or the aim override is free.
    const { ship } = bench('fighter', 0);
    ship.aimAngle = 0;

    for (let i = 0; i < 30; i++) {
        ship.aimAngle = 0;
        ship.ax = 0;
        ship.ay = ship.def.accel * 4;
        applyMotion(ship, DT);
    }

    assert.ok(Math.abs(ship.angle) < 1e-6, 'aimAngle should have pinned the nose');
    const cap = ship.def.accel * ship.def.thrust.lateral * (30 * DT);
    assert.ok(ship.vy <= cap + 1,
        `strafed to ${ship.vy.toFixed(1)} u/s, more than the jets could deliver (${cap.toFixed(1)})`);
});

test('flight: a ship brakes on its bow thruster instead of turning around', () => {
    // Ships carry a retro pack precisely so they do not have to spin
    // end-over-end to stop. A steering request to slow down points
    // backwards along the ship's own track, and taking that literally
    // as "point where you want to thrust" swung the hull right round
    // to burn its main drive against its own travel.
    for (const type of ['miner', 'drone', 'fighter']) {
        const { ship } = bench(type, 0);
        ship.aimAngle = null;
        ship.vx = ship.def.speed;                  // at cruise, due +X

        let worstOff = 0;
        let mainWhileBraking = 0;
        let maxRetro = 0;
        for (let i = 0; i < 240; i++) {
            // Ask, every step, for a stop.
            ship.ax = -Math.min(ship.def.accel, ship.vx * ARRIVE_GAIN);
            ship.ay = 0;
            applyMotion(ship, DT);
            maxRetro = Math.max(maxRetro, ship.rcsRetro);
            if (Math.hypot(ship.vx, ship.vy) < 8) break;

            const travel = Math.atan2(ship.vy, ship.vx);
            worstOff = Math.max(worstOff, Math.abs(angleDelta(travel, ship.angle)));
            if (Math.abs(angleDelta(travel, ship.angle)) > Math.PI / 2) mainWhileBraking++;
        }

        assert.equal(mainWhileBraking, 0,
            `${type} turned its main drive against its own travel to brake`);
        // Bounding the nose to some arc is not enough on its own —
        // any rule that clamps an angle satisfies that and still
        // parks the hull at the clamp's edge, because a braking
        // request sits near 180° and saturates it every step. A
        // request to stop and nothing else must hold the bow
        // *straight*, which is a much harder thing to pass by
        // accident.
        assert.ok(worstOff < 0.02,
            `${type} crabbed ${(worstOff * 180 / Math.PI).toFixed(0)}° off a pure braking request`);
        assert.ok(maxRetro > 0.5,
            `${type} braked without lighting its retro pack (${maxRetro.toFixed(2)})`);
        // And it did actually stop.
        assert.ok(Math.hypot(ship.vx, ship.vy) < 8, `${type} never shed its speed`);
    }
});

test('flight: braking with a sideways bias steers, proportionally', () => {
    // The other half. Holding the bow straight through a pure brake
    // must not come from ignoring the request — a brake that also
    // wants to bend the course should bend it, by an amount that
    // tracks the sideways demand rather than jumping to the limit.
    const seen = [];
    for (const bias of [0.05, 0.15, 0.35, 0.7]) {
        const { ship } = bench('miner', 0);
        ship.aimAngle = null;
        ship.vx = ship.def.speed;

        for (let i = 0; i < 20; i++) {
            // Mostly retrograde, with a small and growing side component.
            ship.ax = -ship.def.accel;
            ship.ay = ship.def.accel * bias;
            applyMotion(ship, DT);
        }
        seen.push(angleDelta(Math.atan2(ship.vy, ship.vx), ship.angle));
    }

    for (const off of seen) {
        assert.ok(off > 0, 'the nose should lean toward the side the request pulls');
        // Never past square to the flight path: beyond that the main
        // drive is pointing backwards and the ship is braking on it.
        assert.ok(off < Math.PI / 2,
            `nose swung past square to the flight path: ${off.toFixed(2)}`);
    }
    // Monotonic in the size of the bias — the tell that it is
    // proportional rather than saturated.
    for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i] > seen[i - 1],
            `nose offset did not grow with sideways demand: ${seen.map((v) => v.toFixed(2)).join(', ')}`);
    }
});

test('flight: a ship reversing course brakes first, then turns', () => {
    // The corollary. Holding the bow forward while braking must not
    // mean a ship can never go back the way it came — it means it
    // does so in the order a real hull would: stop, turn, go.
    const { ship } = bench('miner', 0);
    ship.aimAngle = null;
    ship.vx = ship.def.speed;

    let turnedWhileFast = 0;
    for (let i = 0; i < 60 * 12; i++) {
        // Steady demand to travel due -X, the way we came.
        ship.ax = -ship.def.accel;
        ship.ay = 0;
        applyMotion(ship, DT);
        // Still carrying real forward momentum? Then the bow should
        // still be forward — the turn belongs after the stop.
        if (ship.vx > 25 && Math.abs(angleDelta(0, ship.angle)) > 0.2) turnedWhileFast++;
    }

    assert.equal(turnedWhileFast, 0, 'the miner turned round before it had slowed down');
    assert.ok(ship.vx < -20, `expected the miner to be under way in reverse, got ${ship.vx.toFixed(1)}`);
    assert.ok(Math.abs(angleDelta(Math.PI, ship.angle)) < 0.2,
        'having turned, it should be flying nose-first the other way');
});

test('flight: a hull settling to a stop does not shiver', () => {
    // The bug that produced the current facing rule, and the reason
    // the flight recorder exists.
    //
    // It was invisible in every angle-versus-flight-path measure,
    // because at a standstill the flight path is numerical residue —
    // the nose looked like it was swinging 120° when the hull had
    // barely moved and the *reference* had spun. It only showed up
    // in the hull's own turn rate, which was slamming between +96
    // and -96 deg/s — a miner's entire turning authority — ten times
    // on a single trip home. So that is what this measures.
    const world = createWorld({ seed: 1, effects: false });
    world.ships.length = 0;
    world.byId.clear();
    world.fields.length = 0;
    world.asteroids.length = 0;

    const base = makeShip(world, 'mothership', 0, 1600, 700, 0);
    base.fade = 1;
    world.addShip(base);
    world.factions[0].motherships.push(base.id);

    const miner = makeShip(world, 'miner', 0, 700, 700, 0);
    miner.fade = 1;
    miner.homeId = base.id;
    miner.state = 'return';
    miner.cargo = miner.cargoMax;
    miner.vx = miner.def.speed;
    world.addShip(miner);
    world.refreshGrids();

    let prevAngle = miner.angle;
    let prevTurn = 0;
    let reversals = 0;
    for (let i = 0; i < Math.round(26 / DT); i++) {
        stepWorld(world, DT);
        const turn = angleDelta(prevAngle, miner.angle) / DT;
        prevAngle = miner.angle;
        // A reversal at a rate you could actually see, not a twitch.
        if (Math.abs(turn) > 0.1 && Math.abs(prevTurn) > 0.1
            && Math.sign(turn) !== Math.sign(prevTurn)) reversals++;
        if (Math.abs(turn) > 0.02) prevTurn = turn;
    }

    // A round trip contains a couple of genuine turns; ten is a hull
    // shivering as it parks.
    assert.ok(reversals <= 3,
        `the hull reversed its turn ${reversals} times on one trip — it is shivering`);
});

test('flight: a ship that stops thrusting coasts instead of stopping dead', () => {
    // Momentum is what makes sideways motion read as inherited rather
    // than powered. It is also what the old damping destroyed.
    const { ship } = bench('fighter');
    ship.aimAngle = ship.angle;
    ship.vx = 120;

    for (let i = 0; i < 60; i++) { ship.ax = ship.ay = 0; applyMotion(ship, DT); }

    assert.ok(ship.vx > 90,
        `kept only ${ship.vx.toFixed(1)} of 120 u/s after a second of coasting`);
    assert.ok(ship.vx < 120, 'a coast should still bleed a little speed');
});

test('flight: the orbit controller holds its radius on a ship that can only thrust forward', () => {
    // The regression this guards is specific: an orbit expressed as
    // "lean toward the ring" needs lateral thrust to fly, so a
    // rear-thrust hull sags inside it and props itself off on retro.
    const { world, ship } = bench('fighter');
    const cx = 1200, cy = 700, radius = 270;

    ship.x = cx + radius;
    ship.y = cy;
    ship.vx = 0;
    ship.vy = ship.def.speed * 0.85;        // already circling
    ship.angle = Math.PI;                   // nose on the centre, as in ENGAGE

    let min = Infinity, max = 0;
    for (let i = 0; i < 60 * 12; i++) {
        ship.aimAngle = Math.atan2(cy - ship.y, cx - ship.x);
        orbit(ship, cx, cy, radius, 1, 0.85);
        applyMotion(ship, DT);
        if (i > 60) {                       // ignore the first second of settling
            const d = Math.hypot(ship.x - cx, ship.y - cy);
            min = Math.min(min, d);
            max = Math.max(max, d);
        }
    }

    assert.ok(min > radius * 0.8, `orbit sagged to ${min.toFixed(0)}, ring is ${radius}`);
    assert.ok(max < radius * 1.2, `orbit ballooned to ${max.toFixed(0)}, ring is ${radius}`);
});

// ------------------------------------------------------------
// RESILIENCE & ERROR CONTAINMENT (T2-1)
// ------------------------------------------------------------

test('resilience: broken behaviour is quarantined and does not crash the step', () => {
    const originalFighter = BEHAVIORS.fighter;
    try {
        BEHAVIORS.fighter = () => {
            throw new Error('synthetic actuator fault');
        };

        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 42, effects: false });
        const victim = makeShip(world, 'fighter', 0, 500, 500, 0);
        victim.fade = 1;
        world.addShip(victim);
        world.refreshGrids();

        // Step world - must not throw
        assert.doesNotThrow(() => {
            stepWorld(world, DT);
        });

        assert.equal(victim.quarantined, true, 'ship should be marked quarantined');
        assert.equal(victim.state, 'quarantined', 'ship state should be quarantined');
        assert.equal(victim.quarantineError, 'synthetic actuator fault');
        assert.equal(victim.throttle, 0);
        assert.equal(victim.rcsLat, 0);
        assert.equal(victim.rcsRetro, 0);
        assert.equal(victim.ax, 0);
        assert.equal(victim.ay, 0);
        assert.equal(victim.aimAngle, null);
        assert.equal(victim.beamOn, 0);
        assert.equal(victim.transferOn, 0);

        // Check world.errors array
        assert.ok(world.errors.length > 0, 'world.errors should record the fault');
        const errLog = world.errors.find((e) => e.id === victim.id);
        assert.ok(errLog, 'world.errors contains victim record');
        assert.equal(errLog.error, 'synthetic actuator fault');

        // Check telemetry diagnosis
        const findings = telemetry.diagnose();
        const quarantineFinding = findings.find((f) => f.what === 'ship quarantined');
        assert.ok(quarantineFinding, 'diagnose() should flag ship quarantined');
        assert.equal(quarantineFinding.level, 'high', 'quarantine finding must be high severity');

        // Subsequent steps should skip the quarantined ship
        let calledForQuarantined = false;
        BEHAVIORS.fighter = (ship) => {
            if (ship.id === victim.id) calledForQuarantined = true;
        };
        stepWorld(world, DT);
        assert.equal(calledForQuarantined, false, 'quarantined ship should not invoke behaviour in subsequent steps');
    } finally {
        BEHAVIORS.fighter = originalFighter;
        telemetry.disable().clear();
    }
});

// ------------------------------------------------------------
// PERFORMANCE TRACKING (T2-4)
// ------------------------------------------------------------

test('telemetry: step time degradation rule flags regression in diagnose', () => {
    telemetry.disable().clear();
    telemetry.enable();

    // Populate seriesRows with 20 rows: early rows fast (0.1ms), late rows slow (2.5ms)
    for (let i = 0; i < 20; i++) {
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs: i < 10 ? 0.1 : 2.5,
            ships: 10,
            rocks: 10,
            shots: 0,
            fx: 0,
            fieldOre: 100,
            oreExtracted: 10,
            oreLost: 0,
            oreInTransit: 0,
            hash: 12345,
            f0_metal: 50, f0_miner: 2, f0_drone: 4, f0_fighter: 1, f0_built: 0, f0_lost: 0,
            f1_metal: 50, f1_miner: 2, f1_drone: 4, f1_fighter: 1, f1_built: 0, f1_lost: 0,
        });
    }

    const findings = telemetry.diagnose();
    const deg = findings.find((f) => f.what === 'step time degradation');
    assert.ok(deg, 'diagnose() should detect step time degradation');
    assert.ok(deg.level === 'high' || deg.level === 'medium');

    telemetry.disable().clear();
});

test('behaviour: a drone never launches with nowhere to go', () => {
    // The bug this pins down was visible on screen as drones
    // flickering and miners that would not leave, and invisible to
    // every test in the suite — nothing crashed, the ledger balanced,
    // and the economy merely ran slower than it should have.
    //
    // `unload` sent a drone back out whenever its parent wanted more
    // ore, without asking whether there was any ore in reach to get.
    // `toRock` discovered the answer 0.02 s later and turned round, so
    // the pair oscillated at about two cycles a second:
    //
    //     unload → to_rock → (no rock) → to_parent → dock → unload → ...
    //
    // Measured over fifteen minutes on seed 1: 1,961 of 2,475 launches
    // — 79% — never reached a rock. The miner is collateral damage,
    // because `allDronesDocked` keeps catching a drone mid-flight and
    // a full miner cannot set off for home.
    //
    // Stated as a ratio rather than a count, so it survives the fields
    // and rock counts being retuned again.
    telemetry.disable().clear();
    telemetry.enable({ motion: false, burstGap: 0, max: 400000 });

    const world = createWorld({ seed: 1, effects: false });
    for (let i = 0; i < Math.round(600 / DT); i++) stepWorld(world, DT);

    let launched = 0;
    let wasted = 0;
    for (const r of telemetry.stateRows) {
        if (r.role !== 'drone') continue;
        if (r.to === 'to_rock') launched += r.n;
        if (r.from === 'to_rock' && r.reason === 'no-rock-in-reach') wasted += r.n;
    }
    telemetry.disable().clear();

    assert.ok(launched > 100, `too few launches to judge: ${launched}`);
    const share = wasted / launched;
    assert.ok(share < 0.15,
        `${(share * 100).toFixed(0)}% of drone launches found no rock `
        + `(${wasted} of ${launched}) — drones are being sent out with nowhere to go`);
});

test('behaviour: a manually triggered incursion arrives like a scheduled one', () => {
    // The controls panel can call an incursion in. That path built its
    // own arrival record as an object literal that happened to match
    // the scheduled one — fine until the shape gained a field.
    //
    // Waves became echelons, `beginIncursion` learned about `groups`,
    // and the manual path kept building the old shape and threw on the
    // very next step. Nothing in the suite covered it, because every
    // other test lets the schedule do the summoning: the one entry
    // point a *person* can reach on purpose was the one with no test.
    for (const size of [1, 7, 40]) {
        const world = createWorld({ seed: 4242, effects: false });
        for (let i = 0; i < 60; i++) stepWorld(world, DT);

        // Counted as they *arrive*, not as survivors. A lone hull
        // dropped into the middle of a war is often dead well before
        // the window closes, and that is the simulation working.
        let arrived = 0;
        world.events.on(EV.SHIP_SPAWNED, (e) => { if (e.ship.factionId === 2) arrived++; });

        const asked = triggerIncursion(world, world.width * 0.5, world.height * 0.5, size);
        assert.equal(asked, size, 'the trigger did not honour the size it was given');

        assert.doesNotThrow(() => {
            for (let i = 0; i < Math.round(45 / DT); i++) stepWorld(world, DT);
        }, `a manual incursion of ${size} threw while arriving`);

        assert.equal(arrived, size, `asked for ${size} hulls and ${arrived} arrived`);
        assert.deepEqual(world.errors, [], 'a hull quarantined during a manual incursion');
    }
});

test('behaviour: a manual incursion still arrives in echelons', () => {
    // Same shape as the scheduled path, which is the point of the two
    // sharing one constructor: light hulls lead, the heavies follow.
    const world = createWorld({ seed: 9, effects: false });
    for (let i = 0; i < 60; i++) stepWorld(world, DT);

    const order = [];
    world.events.on(EV.SHIP_SPAWNED, (e) => {
        if (e.ship.factionId === 2) order.push(e.ship.type);
    });
    triggerIncursion(world, world.width * 0.5, world.height * 0.5, 14);
    for (let i = 0; i < Math.round(45 / DT); i++) stepWorld(world, DT);

    const firstHeavy = order.indexOf('harvester');
    assert.ok(firstHeavy > 0,
        `the capitals did not follow a screen: ${order.join(',')}`);
    assert.ok(order.slice(0, firstHeavy).every((t) => t === 'swarmer'),
        'something other than light hulls led the wave');
});
