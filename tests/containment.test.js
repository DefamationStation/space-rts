// ============================================================
// ADVERSARIAL STRESS TESTS — MILESTONE 2 TIER 2 (T2-1 ERROR CONTAINMENT)
// ============================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { applyDamage, killShip } from '../src/sim/combat.js';
import { BEHAVIORS } from '../src/sim/behaviors/index.js';
import { STATES } from '../src/sim/behaviors/states.js';
import { SHIP_TYPES } from '../src/data/ships.js';
import { telemetry } from '../src/core/telemetry.js';
import { EV } from '../src/core/events.js';
import { FIXED_DT } from '../src/core/constants.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

test('containment: multiple ships across all distinct roles throwing simultaneously are safely quarantined', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 777, effects: false });

        // Faulty behaviors for all four core ship roles
        BEHAVIORS.fighter = (ship) => { throw new Error(`fighter-crash-${ship.id}`); };
        BEHAVIORS.miner = (ship) => { throw new Error(`miner-crash-${ship.id}`); };
        BEHAVIORS.drone = (ship) => { throw new Error(`drone-crash-${ship.id}`); };
        BEHAVIORS.mothership = (ship) => { throw new Error(`mothership-crash-${ship.id}`); };
        // The exchange is placed by worldgen like a station, so it is
        // already in the world when this runs — and the assertion
        // below is over *every* ship, not just the ones added here.
        BEHAVIORS.exchange = (ship) => { throw new Error(`exchange-crash-${ship.id}`); };
        // Every faction now opens with miners and haulers on the board,
        // and the assertion below is over *every* ship in the world —
        // so every role that can exist at t=0 has to be faulted.
        BEHAVIORS.hauler = (ship) => { throw new Error(`hauler-crash-${ship.id}`); };

        const testFighter = makeShip(world, 'fighter', 0, 100, 100, 0);
        const testMiner = makeShip(world, 'miner', 0, 200, 200, 0);
        const testDrone = makeShip(world, 'drone', 0, 300, 300, 0);
        testDrone.parentId = testMiner.id;
        const testMothership = makeShip(world, 'mothership', 0, 400, 400, 0);

        // Pre-set active engine and beam states
        for (const s of [testFighter, testMiner, testDrone, testMothership]) {
            s.fade = 1;
            s.ax = 80;
            s.ay = -40;
            s.throttle = 1.0;
            s.rcsLat = -0.7;
            s.rcsRetro = 0.5;
            s.aimAngle = Math.PI / 4;
            s.beamOn = 1;
            s.beamTargetId = 12345;
            s.transferOn = 1;
            s.transferId = 67890;
            world.addShip(s);
        }
        world.refreshGrids();

        const totalShips = world.ships.length;
        assert.ok(totalShips >= 4, 'Should have multiple ships');

        // Step world - must not throw any exception despite 100% of ships throwing
        assert.doesNotThrow(() => {
            stepWorld(world, FIXED_DT);
        }, 'stepWorld must absorb all concurrent exceptions');

        // Verify every ship is quarantined and neutralized
        for (const s of world.ships) {
            assert.equal(s.quarantined, true, `Ship ${s.id} (${s.role}) must be quarantined`);
            assert.equal(s.state, 'quarantined', `Ship ${s.id} state must be quarantined`);
            assert.ok(s.quarantineError.includes(`${s.role}-crash-${s.id}`), `Error string must identify ${s.role}`);
            
            // Actuator and load neutralization checks
            assert.equal(s.throttle, 0, `Ship ${s.id} throttle must be 0`);
            assert.equal(s.ax, 0, `Ship ${s.id} ax must be 0`);
            assert.equal(s.ay, 0, `Ship ${s.id} ay must be 0`);
            assert.equal(s.rcsLat, 0, `Ship ${s.id} rcsLat must be 0`);
            assert.equal(s.rcsRetro, 0, `Ship ${s.id} rcsRetro must be 0`);
            assert.equal(s.aimAngle, null, `Ship ${s.id} aimAngle must be null`);
            assert.equal(s.beamOn, 0, `Ship ${s.id} beamOn must be 0`);
            assert.equal(s.beamTargetId, 0, `Ship ${s.id} beamTargetId must be 0`);
            assert.equal(s.transferOn, 0, `Ship ${s.id} transferOn must be 0`);
            assert.equal(s.transferId, 0, `Ship ${s.id} transferId must be 0`);
        }

        // Verify world.errors logged all ships accurately
        assert.equal(world.errors.length, totalShips, 'All ship errors must be logged in world.errors');
        for (const s of world.ships) {
            const errEntry = world.errors.find((e) => e.id === s.id);
            assert.ok(errEntry, `world.errors must have record for ship ${s.id}`);
            assert.equal(errEntry.type, s.type);
            assert.equal(errEntry.role, s.role);
            assert.equal(errEntry.state, 'quarantined');
            assert.equal(errEntry.tick, world.tick);
            assert.equal(errEntry.error, s.quarantineError);
        }

        // Verify telemetry diagnose flags all quarantined ships as high severity
        const findings = telemetry.diagnose();
        const quarantineFindings = findings.filter((f) => f.what === 'ship quarantined');
        assert.ok(quarantineFindings.length > 0, 'telemetry.diagnose() must have quarantined findings');
        for (const qf of quarantineFindings) {
            assert.equal(qf.level, 'high', 'All quarantine findings must have level: high');
        }
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: exotic / non-Error exceptions (primitives, symbols, custom objects, null, undefined)', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 42, effects: false });

        const exoticThrows = [
            { label: 'string', value: 'fatal string exception' },
            { label: 'number', value: 503 },
            { label: 'zero', value: 0 },
            { label: 'boolean', value: false },
            { label: 'null', value: null },
            { label: 'undefined', value: undefined },
            { label: 'symbol', value: Symbol('fault_sym') },
            { label: 'plain object', value: { status: 'CRITICAL', code: 99 } },
            { label: 'custom toString object', value: { toString() { return 'custom-err-repr'; } } },
            { label: 'circular object', value: (() => { const o = {}; o.self = o; return o; })() },
        ];

        for (let i = 0; i < exoticThrows.length; i++) {
            const { label, value } = exoticThrows[i];
            BEHAVIORS.fighter = () => { throw value; };

            const testShip = makeShip(world, 'fighter', 0, 500 + i * 20, 500 + i * 20, 0);
            testShip.fade = 1;
            testShip.throttle = 0.9;
            testShip.ax = 100;
            world.addShip(testShip);
            world.refreshGrids();

            assert.doesNotThrow(() => {
                stepWorld(world, FIXED_DT);
            }, `stepWorld must survive throwing ${label}`);

            assert.equal(testShip.quarantined, true, `Ship with ${label} throw must be quarantined`);
            assert.equal(testShip.state, 'quarantined');
            assert.equal(typeof testShip.quarantineError, 'string', 'quarantineError must be normalized to string');
            assert.ok(testShip.quarantineError.length > 0, 'quarantineError must not be empty');
            assert.equal(testShip.throttle, 0);
            assert.equal(testShip.ax, 0);

            const errLog = world.errors.find((e) => e.id === testShip.id);
            assert.ok(errLog, `world.errors must record ${label} fault`);
            assert.equal(errLog.error, testShip.quarantineError);
        }
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: quarantined ships never execute behavior again across repeated simulation steps', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 123, effects: false });

        // Step 1: Throwing behavior quarantines a ship
        BEHAVIORS.fighter = () => { throw new Error('one-time crash'); };
        const buggyShip = makeShip(world, 'fighter', 0, 400, 400, 0);
        buggyShip.fade = 1;
        world.addShip(buggyShip);
        world.refreshGrids();

        stepWorld(world, FIXED_DT);
        assert.equal(buggyShip.quarantined, true);

        // Step 2..60: Reset behavior to tracking function, run for 60 ticks (1 second)
        let buggyShipCalled = 0;
        let healthyShipCalls = 0;

        const healthyShip = makeShip(world, 'fighter', 0, 500, 500, 0);
        healthyShip.fade = 1;
        world.addShip(healthyShip);
        world.refreshGrids();

        BEHAVIORS.fighter = (ship) => {
            if (ship.id === buggyShip.id) {
                buggyShipCalled++;
            }
            if (ship.id === healthyShip.id) {
                healthyShipCalls++;
            }
        };

        for (let tick = 0; tick < 60; tick++) {
            stepWorld(world, FIXED_DT);
            // Verify buggy ship kinematics remain completely zeroed throughout all steps
            assert.equal(buggyShip.throttle, 0);
            assert.equal(buggyShip.ax, 0);
            assert.equal(buggyShip.ay, 0);
            assert.equal(buggyShip.rcsLat, 0);
            assert.equal(buggyShip.rcsRetro, 0);
            assert.equal(buggyShip.aimAngle, null);
            assert.equal(buggyShip.beamOn, 0);
            assert.equal(buggyShip.transferOn, 0);
        }

        assert.equal(buggyShipCalled, 0, 'Quarantined ship must NEVER have its behavior invoked again');
        assert.equal(healthyShipCalls, 60, 'Healthy ship must execute its behavior every tick');
        assert.equal(healthyShip.quarantined, false);
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: combat, damage, and destruction interactions with quarantined ships', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 888, effects: false });

        // Quarantine a fighter
        BEHAVIORS.fighter = () => { throw new Error('inert-target-fault'); };
        const victim = makeShip(world, 'fighter', 0, 600, 600, 0);
        victim.fade = 1;
        victim.hp = 100;
        world.addShip(victim);
        world.refreshGrids();

        stepWorld(world, FIXED_DT);
        assert.equal(victim.quarantined, true);

        // Apply combat damage to the quarantined ship
        assert.doesNotThrow(() => {
            applyDamage(world, victim, 40, 999);
        }, 'Applying damage to quarantined ship must not throw');
        assert.equal(victim.hp, 60);

        // Apply fatal damage
        let shipDiedEmitted = false;
        world.events.on(EV.SHIP_DIED, (e) => {
            if (e.ship.id === victim.id) shipDiedEmitted = true;
        });

        assert.doesNotThrow(() => {
            killShip(world, victim, 999);
        }, 'Killing a quarantined ship must not throw');

        assert.equal(victim.dead, true);
        assert.equal(victim.hp, 0);
        assert.equal(shipDiedEmitted, true);

        // Next step should sweep and compact dead quarantined ship cleanly
        assert.doesNotThrow(() => {
            stepWorld(world, FIXED_DT);
        });
        assert.ok(!world.ships.includes(victim), 'Dead quarantined ship should be swept cleanly');
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: eventBus SHIP_ERROR emission and telemetry anomaly payload accuracy', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 999, effects: false });

        let eventPayload = null;
        world.events.on(EV.SHIP_ERROR, (payload) => {
            eventPayload = payload;
        });

        BEHAVIORS.miner = () => { throw new Error('subsystem-cascade-failure'); };
        const victim = makeShip(world, 'miner', 1, 350, 450, 0);
        victim.fade = 1;
        world.addShip(victim);
        world.refreshGrids();

        stepWorld(world, FIXED_DT);

        // Assert EventBus payload
        assert.ok(eventPayload, 'EV.SHIP_ERROR must be emitted');
        assert.equal(eventPayload.ship.id, victim.id);
        assert.equal(eventPayload.error, 'subsystem-cascade-failure');

        // Assert telemetry anomaly row
        const anomaly = telemetry.anomalies.find((a) => a.what === 'ship quarantined' && a.id === victim.id);
        assert.ok(anomaly, 'Telemetry must record ship quarantined anomaly');
        assert.ok(anomaly.detail.includes('miner'), 'Anomaly detail must contain ship role');
        assert.ok(anomaly.detail.includes('subsystem-cascade-failure'), 'Anomaly detail must contain error message');

        // Assert telemetry diagnose severity ranking
        const diag = telemetry.diagnose();
        const diagFinding = diag.find((d) => d.what === 'ship quarantined' && d.detail.includes('subsystem-cascade-failure'));
        assert.ok(diagFinding, 'Diagnose must report quarantined anomaly');
        assert.equal(diagFinding.level, 'high', 'Diagnose level must be high');
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: dirty state mutation before throwing is completely neutralized by quarantine', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 555, effects: false });

        // Behavior that mutates many fields to dangerous values before throwing
        BEHAVIORS.fighter = (ship) => {
            ship.state = 'corrupted_state';
            ship.stateTime = 999;
            ship.ax = 500;
            ship.ay = -500;
            ship.throttle = 1.0;
            ship.rcsLat = 1.0;
            ship.rcsRetro = 1.0;
            ship.aimAngle = 3.14159;
            ship.beamOn = 1;
            ship.beamTargetId = 777;
            ship.transferOn = 1;
            ship.transferId = 888;
            throw new Error('mid-execution exception');
        };

        const dirtyShip = makeShip(world, 'fighter', 0, 300, 300, 0);
        dirtyShip.fade = 1;
        world.addShip(dirtyShip);
        world.refreshGrids();

        stepWorld(world, FIXED_DT);

        assert.equal(dirtyShip.quarantined, true);
        assert.equal(dirtyShip.state, 'quarantined');
        assert.equal(dirtyShip.stateTime, 0);
        assert.equal(dirtyShip.ax, 0);
        assert.equal(dirtyShip.ay, 0);
        assert.equal(dirtyShip.throttle, 0);
        assert.equal(dirtyShip.rcsLat, 0);
        assert.equal(dirtyShip.rcsRetro, 0);
        assert.equal(dirtyShip.aimAngle, null);
        assert.equal(dirtyShip.beamOn, 0);
        assert.equal(dirtyShip.beamTargetId, 0);
        assert.equal(dirtyShip.transferOn, 0);
        assert.equal(dirtyShip.transferId, 0);
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('containment: interleaved faults across simulation time retain temporal fidelity in world.errors', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 333, effects: false });

        const shipA = makeShip(world, 'fighter', 0, 100, 100, 0);
        shipA.fade = 1;
        const shipB = makeShip(world, 'miner', 0, 200, 200, 0);
        shipB.fade = 1;
        world.addShip(shipA);
        world.addShip(shipB);
        world.refreshGrids();

        // Ship A throws at tick 1
        BEHAVIORS.fighter = (ship) => {
            if (ship.id === shipA.id) throw new Error('shipA-early-fault');
        };
        BEHAVIORS.miner = () => {};

        stepWorld(world, FIXED_DT);
        assert.equal(shipA.quarantined, true);
        assert.equal(shipB.quarantined, false);

        // Step 20 ticks normally
        for (let i = 0; i < 20; i++) {
            stepWorld(world, FIXED_DT);
        }

        // Ship B throws at tick 22
        BEHAVIORS.miner = (ship) => {
            if (ship.id === shipB.id) throw new Error('shipB-delayed-fault');
        };

        stepWorld(world, FIXED_DT);
        assert.equal(shipB.quarantined, true);

        // Check world.errors timing and sequencing
        const errA = world.errors.find((e) => e.id === shipA.id);
        const errB = world.errors.find((e) => e.id === shipB.id);

        assert.ok(errA);
        assert.ok(errB);
        assert.equal(errA.tick, 1);
        assert.equal(errB.tick, 22);
        assert.ok(errB.t > errA.t);
        assert.equal(errA.error, 'shipA-early-fault');
        assert.equal(errB.error, 'shipB-delayed-fault');
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});


// ------------------------------------------------------------
// THE OTHER HALF OF CONTAINMENT
// ------------------------------------------------------------
//
// Everything above asserts that a throwing ship is caught. Nothing
// asserted that no ship throws — and those are very different claims.
// Quarantine is deliberately silent: the hull stops flying, the sim
// carries on, the ledger still balances, every existing test stays
// green. A warship going permanently inert mid-run looked exactly
// like a warship behaving.
//
// It cost a real bug to notice. `scout` read `ship.weapon.range` on
// the handover to an attack run, which is null on the two hulls whose
// guns are *all* on turrets — the frigate and the swarm's harvester —
// so the first time a picket went to look at something it quarantined
// and sat there. Six seeds, forty-five hulls, no failing test.
//
// So the two tests below are the missing halves: nothing throws in a
// normal run, and no hull throws when simply *placed* in a state its
// own role declares it can be in.

// Two seeds and 900 s, not six and 1800.
//
// This one is the backstop, not the net. The vocabulary test below
// catches the same class of bug in 96 ms by *placing* a hull in each
// state, and it does not care whether a run happens to wander
// through one. What this adds is the case that test cannot reach —
// a throw that needs real world state to provoke — and for that,
// breadth of seeds buys much less than it costs. The original bug
// produced 45 quarantines across six seeds; anything that common
// does not need half a minute of CPU to find twice.
test('containment: a long run quarantines nothing', () => {
    for (const seed of [3, 11]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(900 / FIXED_DT); i++) stepWorld(world, FIXED_DT);

        const hit = world.ships.filter((s) => s.quarantined)
            .map((s) => `${s.type} (${s.role}) threw: ${s.quarantineError}`);
        assert.deepEqual(hit, [], `seed ${seed} quarantined ${hit.length} hull(s):\n  ${hit.join('\n  ')}`);
    }
});

test('containment: no hull type throws in any state its own role declares', () => {
    // Reaching a state by driving the sim until it happens is exactly
    // what failed to catch this: the frigate had to be a picket, with
    // a contact in a specific annulus, on a specific tick. The state
    // vocabulary already lists every state each role can be in, so
    // this puts the hull *in* each one and steps it rather than
    // hoping a run wanders through.
    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < 900; i++) stepWorld(world, FIXED_DT);   // rocks, sheds, hostiles to point at

    const failures = [];
    for (const type of Object.keys(SHIP_TYPES)) {
        const def = SHIP_TYPES[type];
        const states = STATES[def.role];
        if (!states) continue;

        for (const state of states) {
            const ship = makeShip(world, type, 0, world.width * 0.5, world.height * 0.5, 0);
            world.addShip(ship);
            world.refreshGrids();

            // Plausible referents, so a handler that legitimately needs
            // something to point at gets one. A null referent is a
            // separate case and every handler already guards it.
            const mate = world.ships.find((s) => !s.dead && s.factionId === 0 && s.id !== ship.id);
            const foe = world.ships.find((s) => !s.dead && s.factionId !== 0);
            ship.state = state;
            ship.parentId = ship.escortId = ship.transferId = mate ? mate.id : 0;
            ship.targetId = foe ? foe.id : 0;
            ship.post = 'picket';          // the duty that found this bug

            try {
                for (let i = 0; i < 30; i++) BEHAVIORS[def.role](ship, world, FIXED_DT);
            } catch (err) {
                failures.push(`${type} (${def.role}) in '${state}': ${err.message}`);
            }
            ship.dead = true;
        }
    }
    world.refreshGrids();

    assert.deepEqual(failures, [],
        `hull states that throw:\n  ${failures.join('\n  ')}`);
});
