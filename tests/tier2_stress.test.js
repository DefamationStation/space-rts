// ============================================================
// ADVERSARIAL STRESS SUITE — MILESTONE 3 CHALLENGER 2
// ============================================================
//
// Rigorous adversarial coverage and stress verification for Tier 2:
// 1. Error containment under extreme, concurrent, and stateful failure modes.
// 2. Headless MockContext2D canvas rendering, hitbox bounds & palette token invariants.
// 3. Telemetry stepMs series tracking, metrics() msPerStep, and diagnose() degradation rules.
// 4. Project-wide architectural non-negotiables.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip, makeAsteroid } from '../src/sim/entities.js';
import { applyDamage, killShip } from '../src/sim/combat.js';
import { BEHAVIORS } from '../src/sim/behaviors/index.js';
import { telemetry } from '../src/core/telemetry.js';
import { EV } from '../src/core/events.js';
import { FIXED_DT } from '../src/core/constants.js';
import { SHIP_TYPES } from '../src/data/ships.js';
import { THEMES } from '../src/data/themes.js';
import { HULL_RENDERERS, drawShip, drawBuildArc, drawThruster } from '../src/render/hulls.js';
import { drawScene } from '../src/render/scene.js';
import { drawGizmos } from '../src/render/gizmos.js';
import { MockContext2D, createMockStage } from './render.test.js';
import { parseHex } from '../src/core/color.js';
import { World } from '../src/core/world.js';

// Audits print through `console.table` when asked from a console, which is
// right in devtools and wrong in a test run — it lands in the middle of
// everyone else's output. Silenced once here so no individual test has to
// remember, and so a test added later is quiet by default.
telemetry.quiet = true;

// ------------------------------------------------------------
// PALETTE TOKEN EXTRACTION & VALIDATION HELPER
// ------------------------------------------------------------

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

    // Collect all valid hex tokens from the active theme
    const themeHexes = [
        theme.ground,
        theme.grid,
        theme.hud?.text,
        theme.hud?.dim,
        theme.neutral?.rock,
        theme.neutral?.rockEdge,
        theme.neutral?.vein,
        theme.neutral?.debris,
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

    // 1. Direct match with any theme color
    for (const [tr, tg, tb] of themeRgbs) {
        if (Math.abs(rgb[0] - tr) <= 2 && Math.abs(rgb[1] - tg) <= 2 && Math.abs(rgb[2] - tb) <= 2) {
            return true;
        }
    }

    // 2. Hull damage wear interpolation (mixHex(pal.hull, theme.neutral.debris, wear * 0.55))
    for (const fac of theme.factions) {
        const hullC = parseHex(fac.hull);
        const debC = parseHex(theme.neutral.debris);
        for (let t = 0; t <= 0.6; t += 0.005) {
            const mr = Math.round(hullC.r + (debC.r - hullC.r) * t);
            const mg = Math.round(hullC.g + (debC.g - hullC.g) * t);
            const mb = Math.round(hullC.b + (debC.b - hullC.b) * t);
            if (Math.abs(rgb[0] - mr) <= 2 && Math.abs(rgb[1] - mg) <= 2 && Math.abs(rgb[2] - mb) <= 2) {
                return true;
            }
        }
    }

    // 3. Black stroke on damaged station
    if (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) return true;

    return false;
}

// ------------------------------------------------------------
// 1. ERROR CONTAINMENT ADVERSARIAL TESTS
// ------------------------------------------------------------

test('tier2 stress: t2: error containment during complex docking & cargo transfer sequence', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 101, effects: false });

        const miner = makeShip(world, 'miner', 0, 500, 500, 0);
        const drone = makeShip(world, 'drone', 0, 510, 510, 0);
        drone.parentId = miner.id;
        drone.cargo = 5.0;
        drone.state = 'dock';
        drone.beamOn = 1.0;
        drone.transferOn = 1.0;
        drone.transferId = miner.id;

        world.addShip(miner);
        world.addShip(drone);
        world.refreshGrids();

        // Inject throwing drone behaviour during docking transfer
        BEHAVIORS.drone = (ship) => {
            if (ship.id === drone.id) {
                throw new Error('docking-transfer-deadlock');
            }
        };

        assert.doesNotThrow(() => {
            stepWorld(world, FIXED_DT);
        }, 'stepWorld must absorb docking drone error');

        assert.equal(drone.quarantined, true);
        assert.equal(drone.state, 'quarantined');
        assert.equal(drone.beamOn, 0);
        assert.equal(drone.transferOn, 0);
        assert.equal(drone.transferId, 0);
        assert.equal(miner.quarantined, false, 'Miner should remain unquarantined and healthy');

        // Subsequent steps should continue operating cleanly without deadlocking miner
        for (let i = 0; i < 30; i++) {
            stepWorld(world, FIXED_DT);
        }
        assert.equal(drone.quarantined, true);
        assert.equal(miner.quarantined, false);
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('tier2 stress: t2: error containment during mothership construction and queue handling', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 102, effects: false });

        const mothership = world.ships.find((s) => s.role === 'mothership' && s.factionId === 0);
        assert.ok(mothership, 'Mothership must exist');

        mothership.buildType = 'fighter';
        mothership.buildStart = world.time;
        mothership.buildEnd = world.time + 10;
        mothership.spin = 1.2;

        BEHAVIORS.mothership = (ship) => {
            if (ship.id === mothership.id) {
                throw new Error('mothership-build-fault');
            }
        };

        assert.doesNotThrow(() => {
            stepWorld(world, FIXED_DT);
        });

        assert.equal(mothership.quarantined, true);
        assert.equal(mothership.state, 'quarantined');
        assert.equal(mothership.throttle, 0);
        assert.equal(mothership.ax, 0);
        assert.equal(mothership.ay, 0);

        // Verify other faction's mothership and ships continue working
        const oppMothership = world.ships.find((s) => s.role === 'mothership' && s.factionId === 1);
        assert.ok(oppMothership);
        assert.equal(oppMothership.quarantined, false);

        for (let i = 0; i < 60; i++) {
            stepWorld(world, FIXED_DT);
        }
        assert.equal(oppMothership.quarantined, false);
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('tier2 stress: t2: pathological error objects and custom Error subclasses', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 103, effects: false });

        // Custom Error subclass with deep cause and extra properties
        class SubsystemFaultError extends Error {
            constructor(msg, code) {
                super(msg);
                this.name = 'SubsystemFaultError';
                this.code = code;
                this.subsystem = 'thrusters';
            }
        }

        BEHAVIORS.fighter = () => {
            throw new SubsystemFaultError('plasma coil overload', 'ERR_COIL_503');
        };

        const ship = makeShip(world, 'fighter', 0, 300, 300, 0);
        world.addShip(ship);
        world.refreshGrids();

        assert.doesNotThrow(() => {
            stepWorld(world, FIXED_DT);
        }, 'quarantineShip must safely handle custom Error subclasses');

        assert.equal(ship.quarantined, true);
        assert.equal(ship.state, 'quarantined');
        assert.equal(ship.quarantineError, 'plasma coil overload');

        const errLog = world.errors.find((e) => e.id === ship.id);
        assert.ok(errLog);
        assert.equal(errLog.error, 'plasma coil overload');
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

test('tier2 stress: t2: spatial partitioning and nearest queries survive quarantined ships', () => {
    const backupBehaviors = { ...BEHAVIORS };
    try {
        telemetry.disable().clear();
        telemetry.enable({ motion: false });

        const world = createWorld({ seed: 104, effects: false });

        const ship = makeShip(world, 'fighter', 0, 400, 400, 0);
        world.addShip(ship);
        world.refreshGrids();

        BEHAVIORS.fighter = (s) => {
            if (s.id === ship.id) throw new Error('spatial-fault');
        };

        stepWorld(world, FIXED_DT);
        assert.equal(ship.quarantined, true);

        // Test spatial nearest query with standard accept predicate
        const found = world.shipGrid.nearest(400, 400, 50, (s) => !s.dead);
        assert.ok(found, 'shipGrid.nearest should find quarantined ship if alive and within radius');
        assert.equal(found.id, ship.id);

        // Spatial queries in empty space should return null cleanly
        const none = world.shipGrid.nearest(1900, 1900, 50, (s) => !s.dead);
        assert.equal(none, null);
    } finally {
        Object.assign(BEHAVIORS, backupBehaviors);
        telemetry.disable().clear();
    }
});

// ------------------------------------------------------------
// 2. RENDERER TESTING & MOCKCONTEXT2D STRESS TESTS
// ------------------------------------------------------------

test('tier2 stress: t2: renderer hitbox containment under full 360-degree rotation and roll bank angles', () => {
    const world = new World({ seed: 201 });
    const theme = THEMES.void;

    for (const [typeId, def] of Object.entries(SHIP_TYPES)) {
        // Test 16 rotation steps around circle and 5 bank roll angles
        for (let angleStep = 0; angleStep < 16; angleStep++) {
            const angle = (angleStep / 16) * Math.PI * 2;
            for (const bank of [-0.4, -0.2, 0, 0.2, 0.4]) {
                const ctx = new MockContext2D();
                const ship = makeShip(world, typeId, 0, 0, 0, angle);
                ship.fade = 1;
                ship.bank = bank;
                ship.throttle = 0.5;

                drawShip(ctx, ship, theme, 1, world);

                const bounds = ctx.getBounds();
                const minExpected = def.radius * 0.70;
                const maxExpected = def.radius * 1.30;

                assert.ok(
                    bounds.maxRadius >= minExpected && bounds.maxRadius <= maxExpected,
                    `${typeId} at angle=${angle.toFixed(2)} bank=${bank} radius=${bounds.maxRadius.toFixed(2)} out of [${minExpected.toFixed(2)}, ${maxExpected.toFixed(2)}]`,
                );
                assert.equal(ctx.matrixStack.length, 0, `${typeId} unbalanced matrix stack`);
            }
        }
    }
});

test('tier2 stress: t2: renderer matrix stack integrity on full scene with 100+ entities and gizmos', () => {
    const world = createWorld({ seed: 202, effects: true });
    const stage = createMockStage(2400, 1350);

    // Populate additional ships
    for (let i = 0; i < 50; i++) {
        const f0 = makeShip(world, 'fighter', 0, 200 + i * 20, 200 + i * 10, i * 0.1);
        const f1 = makeShip(world, 'miner', 1, 1000 + i * 15, 600 + i * 10, i * 0.2);
        f0.fade = 1;
        f1.fade = 1;
        world.addShip(f0);
        world.addShip(f1);
    }
    world.refreshGrids();

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        const ctx = stage.ctx;
        ctx.reset();

        // Render full scene with gizmos and overlays enabled
        drawScene(ctx, world, theme, stage, 1, true, { debugLevel: 2, gizmos: true });

        assert.equal(ctx.matrixStack.length, 0, `Matrix stack leaked in ${themeKey} full scene`);
        assert.ok(ctx.calls.length > 500, `Expected >500 canvas draw calls in ${themeKey} scene`);
    }
});

test('tier2 stress: t2: strict theme palette compliance across all themes, damage levels, and build states', () => {
    const world = new World({ seed: 203 });

    for (const themeKey of ['void', 'paper']) {
        const theme = THEMES[themeKey];
        for (const factionId of [0, 1]) {
            for (const typeId of Object.keys(SHIP_TYPES)) {
                for (const hpPct of [1.0, 0.8, 0.5, 0.2, 0.05]) {
                    const ctx = new MockContext2D();
                    const ship = makeShip(world, typeId, factionId, 0, 0, 0);
                    ship.fade = 1;
                    ship.hp = ship.maxHp * hpPct;
                    ship.cargo = ship.cargoMax * 0.75;
                    ship.throttle = 0.8;
                    ship.rcsLat = 0.4;
                    ship.rcsRetro = 0.2;

                    if (typeId === 'mothership') {
                        ship.buildType = 'miner';
                        ship.buildStart = 0;
                        ship.buildEnd = 10;
                    }

                    drawShip(ctx, ship, theme, 1, world);

                    for (const col of ctx.emittedColors) {
                        assert.ok(
                            isValidColorForTheme(col, theme),
                            `Unthemed color "${col}" emitted for ${typeId} (faction ${factionId}, theme ${themeKey}, hpPct ${hpPct})`,
                        );
                    }
                }
            }
        }
    }
});

// ------------------------------------------------------------
// 3. PERFORMANCE TRACKING & DEGRADATION RULE TESTS
// ------------------------------------------------------------

test('tier2 stress: t2: telemetry stepMs is sampled in series stream on seriesEvery intervals', () => {
    telemetry.disable().clear();
    telemetry.enable({ seriesEvery: 30, motion: false });

    const world = createWorld({ seed: 301, effects: false });

    for (let i = 0; i < 90; i++) {
        stepWorld(world, FIXED_DT);
    }

    assert.ok(telemetry.seriesRows.length >= 3, 'Expected at least 3 series samples in 90 steps');
    for (const row of telemetry.seriesRows) {
        assert.equal(typeof row.stepMs, 'number');
        assert.ok(Number.isFinite(row.stepMs), 'stepMs must be finite');
        assert.ok(row.stepMs >= 0, 'stepMs must be non-negative');
    }
    telemetry.disable().clear();
});

test('tier2 stress: t2: diagnose step time degradation rule triggers on late-run 3x slowdown > 1.0ms', () => {
    telemetry.disable().clear();
    telemetry.enable({ seriesEvery: 1, motion: false });

    // Populate 20 synthetic series rows with clear 4x step degradation above 1.0ms noise floor
    for (let i = 0; i < 20; i++) {
        const stepMs = i < 5 ? 0.35 : i > 14 ? 1.80 : 0.60;
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs,
            ships: 10,
            rocks: 20,
            shots: 0,
            fx: 0,
            fieldOre: 500,
            oreExtracted: 0,
            oreLost: 0,
            oreInTransit: 0,
            hash: 12345,
            f0_metal: 100, f0_miner: 2, f0_drone: 4, f0_fighter: 2, f0_built: 0, f0_lost: 0,
            f1_metal: 100, f1_miner: 2, f1_drone: 4, f1_fighter: 2, f1_built: 0, f1_lost: 0,
        });
    }

    const diag = telemetry.diagnose();
    const degFinding = diag.find((d) => d.what === 'step time degradation');

    assert.ok(degFinding, 'diagnose() must detect step time degradation');
    assert.equal(degFinding.level, 'high', 'Severity must be high for >3.0x degradation');
    assert.ok(degFinding.detail.includes('grew from'), 'Detail must format early and late averages');

    telemetry.disable().clear();
});

test('tier2 stress: t2: diagnose step time degradation ignores healthy runs and sub-noise-floor jitter', () => {
    telemetry.disable().clear();
    telemetry.enable({ seriesEvery: 1, motion: false });

    // 20 synthetic series rows with flat step times around 0.15ms (below 1.0ms threshold)
    for (let i = 0; i < 20; i++) {
        telemetry.seriesRows.push({
            tick: i * 60,
            t: i,
            stepMs: 0.12 + (i % 3) * 0.02,
            ships: 10, rocks: 20, shots: 0, fx: 0, fieldOre: 500,
            oreExtracted: 0, oreLost: 0, oreInTransit: 0, hash: 12345,
            f0_metal: 100, f0_miner: 2, f0_drone: 4, f0_fighter: 2, f0_built: 0, f0_lost: 0,
            f1_metal: 100, f1_miner: 2, f1_drone: 4, f1_fighter: 2, f1_built: 0, f1_lost: 0,
        });
    }

    const diag = telemetry.diagnose();
    const degFinding = diag.find((d) => d.what === 'step time degradation');
    assert.equal(degFinding, undefined, 'Flat / sub-threshold step times must NOT trigger degradation rule');

    telemetry.disable().clear();
});

// ------------------------------------------------------------
// 4. ARCHITECTURAL NON-NEGOTIABLES
// ------------------------------------------------------------

test('tier2 stress: t2: entity hidden class shape invariance under dynamic lifecycle mutations', () => {
    const world = createWorld({ seed: 401, effects: false });
    const templateKeys = Object.keys(makeShip(world, 'fighter', 0, 0, 0));

    for (let i = 0; i < 300; i++) {
        stepWorld(world, FIXED_DT);
    }

    for (const ship of world.ships) {
        const shipKeys = Object.keys(ship);
        assert.deepEqual(
            shipKeys,
            templateKeys,
            `Ship ${ship.id} (${ship.type}) property shape drifted from makeShip factory template`,
        );
    }
});
