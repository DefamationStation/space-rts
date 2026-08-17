// ============================================================
// TESTS — THE EXCHANGE
// ============================================================
//
// A neutral market both fleets trade at, inside a bubble nobody may
// fire in. Three separate claims, and they fail in different ways:
//
//   neutrality   nobody is hostile to it, including the swarm
//   sanctuary    no round lands inside the bubble, ever
//   the route    both sides actually go, and the ledger stays honest
//
// The middle one is the one worth testing hardest. A sanctuary that
// holds 99% of the time is not a sanctuary — it is a place that
// looks safe and occasionally is not, which reads to a viewer as a
// bug in the collision code rather than as a rule with an exception.
// So the assertion is zero, over a full run, not a small proportion.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { isHostile, inSanctuary } from '../src/sim/behaviors/common.js';
import { isPlayed, FACTIONS } from '../src/data/factions.js';
import { FIXED_DT, SANCTUARY_RADIUS } from '../src/core/constants.js';
import { telemetry } from '../src/core/telemetry.js';

telemetry.quiet = true;

const DT = FIXED_DT;

/** Long enough for haulers to exist, cross the map and come back. */
const TRADE_SECONDS = 900;

test('exchange: the market is on the board, neutral, and equidistant', () => {
    for (const seed of [1, 2, 3, 4]) {
        const world = createWorld({ seed, effects: false });
        const hub = world.ships.find((s) => s.role === 'exchange');
        assert.ok(hub, `seed ${seed}: no exchange was placed`);

        // On the perpendicular bisector of the two stations, which is
        // what makes "equidistant" a fact rather than a good intention.
        const homes = world.factions.filter(isPlayed)
            .map((f) => world.ship(f.motherships[0]))
            .filter(Boolean);
        assert.equal(homes.length, 2, 'expected two stations to measure against');

        const d0 = Math.hypot(homes[0].x - hub.x, homes[0].y - hub.y);
        const d1 = Math.hypot(homes[1].x - hub.x, homes[1].y - hub.y);
        assert.ok(Math.abs(d0 - d1) < 1,
            `seed ${seed}: market favours one side — ${Math.round(d0)} vs ${Math.round(d1)}`);

        // And off the centre, which is the measured part: a bubble at
        // the middle of the map contains 13.5% of every shot fired.
        assert.ok(Math.abs(hub.y - world.height * 0.5) > world.height * 0.25,
            `seed ${seed}: market sat in the contested middle`);
    }
});

test('exchange: nobody is at war with the market, including the swarm', () => {
    const world = createWorld({ seed: 5, effects: false });
    const trader = FACTIONS.find((f) => f.neutral);
    assert.ok(trader, 'no neutral faction is declared');

    for (const other of FACTIONS) {
        if (other.id === trader.id) continue;
        assert.equal(isHostile(world, other.id, trader.id), false,
            `faction ${other.id} is hostile to the market`);
        assert.equal(isHostile(world, trader.id, other.id), false,
            `the market is hostile to faction ${other.id}`);
    }

    // Specifically under a truce and specifically not — the neutral
    // branch sits above the swarm branch in `isHostile`, and the whole
    // point of that ordering is that it does not depend on the state
    // of the war.
    const swarm = FACTIONS.find((f) => f.alien);
    for (const truce of [false, true]) {
        world.truce = truce;
        assert.equal(isHostile(world, swarm.id, trader.id), false,
            `the swarm turned on the market with truce=${truce}`);
    }
});

test('exchange: the bubble is geometry, not a suggestion', () => {
    const world = createWorld({ seed: 7, effects: false });
    const s = world.sanctuaries[0];
    assert.ok(s, 'worldgen opened no sanctuary');
    assert.equal(s.r, SANCTUARY_RADIUS);

    assert.ok(inSanctuary(world, s.x, s.y), 'the centre is not inside its own bubble');
    assert.ok(inSanctuary(world, s.x + s.r * 0.99, s.y), 'just inside the edge reads as outside');
    assert.ok(!inSanctuary(world, s.x + s.r * 1.01, s.y), 'just outside the edge reads as inside');
    assert.ok(!inSanctuary(world, 0, 0), 'the far corner is somehow sanctuary');
});

test('exchange: not one round lands inside the bubble in a whole run', () => {
    // The claim the feature lives or dies on. Zero, not "few" — see
    // the header.
    //
    // The second assertion is the one that earns its keep. It failed
    // once, and not because the sanctuary leaked: the ore gradient was
    // rebased on distance from the nearest station, the fighting moved
    // into the middle band, and the market was left in a dead corner
    // that no round came within 430 units of. The rule was perfect and
    // pointless. Placement moved to 0.24 in response — so this line is
    // what stops the bubble drifting somewhere nothing can reach it.
    let inside = 0;
    let total = 0;
    let justOutside = 0;
    let hubDamage = 0;

    for (const seed of [1, 2, 3]) {
        const world = createWorld({ seed, effects: false });
        const hub = world.ships.find((s) => s.role === 'exchange');
        const bubble = world.sanctuaries[0];

        world.events.on('shot:hit', (e) => {
            total++;
            const d = Math.hypot(e.x - bubble.x, e.y - bubble.y);
            if (d < bubble.r) inside++;
            else if (d < bubble.r * 1.5) justOutside++;
        });

        for (let i = 0; i < Math.round(TRADE_SECONDS / DT); i++) stepWorld(world, DT);
        hubDamage += hub.maxHp - hub.hp;
    }

    assert.ok(total > 500, `not enough shooting to prove anything: ${total} hits`);
    assert.equal(inside, 0, `${inside} of ${total} rounds landed inside the sanctuary`);
    assert.equal(hubDamage, 0, `the market took ${hubDamage} damage`);
    assert.ok(justOutside > 0,
        'no round landed near the bubble either — the market has drifted somewhere the '
        + 'war never reaches, so the no-fire rule has no occasion to apply. See TRADE_HUB_INSET.');
});

test('exchange: both sides trade, and the market runs down as they do', () => {
    const visits = [0, 0];
    let traded = 0;
    let lowWater = Infinity;

    for (const seed of [1, 2, 3]) {
        const world = createWorld({ seed, effects: false });
        const hub = world.ships.find((s) => s.role === 'exchange');
        const was = new Map();

        for (let i = 0; i < Math.round(TRADE_SECONDS / DT); i++) {
            stepWorld(world, DT);
            for (const s of world.ships) {
                if (s.dead || s.role !== 'hauler') continue;
                if (was.get(s.id) !== 'trade' && s.state === 'trade') visits[s.factionId]++;
                was.set(s.id, s.state);
            }
            lowWater = Math.min(lowWater, hub.cargo);
        }
        traded += world.tradedTotal;
    }

    assert.ok(visits[0] > 0 && visits[1] > 0,
        `the market is not serving both sides: ${visits.join(' / ')}`);
    assert.ok(traded > 0, 'no ore ever came out of the market');

    // Trade has to actually draw on the float.
    //
    // This used to assert the float ran *low* — below TRADE_MIN_FLOAT —
    // on the reasoning that scarcity is what makes the market a place
    // rather than a button, with two fleets competing for one stock.
    // That was a design choice and it has since been reversed
    // deliberately: the float is twenty times larger and refills ten
    // times faster, because a market that is empty when you arrive
    // reads as broken rather than as contested.
    //
    // So the claim worth keeping is the weaker and more durable one —
    // haulers are genuinely taking stock out of it, rather than the
    // number sitting at full while `tradedTotal` climbs from somewhere
    // else. Scarcity is no longer the mechanic; the drawdown is still
    // the proof the mechanic runs.
    const hub = createWorld({ seed: 1, effects: false }).ships.find((s) => s.role === 'exchange');
    assert.ok(lowWater < hub.cargoMax,
        `the float never moved off full (${Math.round(lowWater)}) — nothing is being taken out`);
});

test('exchange: nothing even aims into the bubble, mounts included', () => {
    // The sanctuary had two guards and needed three. `pickTarget`
    // refused targets inside it and projectile collision discarded
    // rounds that arrived — but a *mount* picks its own target and was
    // never asked, so turreted hulls locked onto ships in the bubble
    // and fired at them all day. The rounds were thrown away on
    // impact, so nothing measurable was wrong; what a viewer saw was
    // the swarm shooting into the market and the shots not landing,
    // which reads as broken collision rather than as a rule.
    //
    // The hulls that suffer are exactly the ones whose guns are *all*
    // on mounts — the frigate, and the swarm's harvester — so a test
    // that only exercises nose guns proves nothing.
    const world = createWorld({ seed: 11, effects: false });
    const bubble = world.sanctuaries[0];

    // An empty board, so the only thing the gunner can possibly shoot
    // at is the thing this test put in front of it.
    //
    // It used to run against a live world and assert that no round was
    // fired at all, which stopped being the same claim the moment
    // factions began opening with haulers: the freight runs to the
    // market, parks *just outside* the bubble, and a swarm hull
    // standing over the exchange shot at it — legitimately, since the
    // sanctuary protects what is inside it and not what is beside it.
    // The prey was untouched throughout; the count was measuring a war
    // going on next door.
    //
    // `sanctuaries` is worldgen's own list and survives this, so the
    // bubble is still there with nothing in it.
    world.ships.length = 0;
    world.byId.clear();

    // A turret-only warship, and prey inside the bubble with it.
    const gunner = makeShip(world, 'harvester', 2,
        bubble.x + bubble.r * 0.85, bubble.y, 0);
    gunner.fade = 1;
    world.addShip(gunner);

    const prey = makeShip(world, 'miner', 0, bubble.x, bubble.y, 0);
    prey.fade = 1;
    world.addShip(prey);
    world.refreshGrids();

    assert.ok(inSanctuary(world, prey.x, prey.y), 'the fixture put the prey outside the bubble');

    // Only this gunner's rounds. Both factions open with hulls on the
    // board and their stations are armed, so counting every shot in
    // the world would count a war going on elsewhere.
    let firedAt = 0;
    world.events.on('shot:fired', (e) => { if (e.id === gunner.id) firedAt++; });

    for (let i = 0; i < Math.round(30 / DT); i++) stepWorld(world, DT);

    assert.equal(prey.hp, prey.maxHp, 'a hull inside the sanctuary took damage');
    assert.ok(gunner.mounts.every((m) => m.targetId !== prey.id),
        'a mount locked onto a target inside the sanctuary');
    assert.equal(firedAt, 0,
        `${firedAt} rounds were fired at something in the bubble — they would be discarded `
        + 'on impact, so this is invisible except as shots that do nothing');
});

test('exchange: a forward store is never planted inside the bubble', () => {
    // A shed in there could neither be defended nor attacked, which is
    // not a safe shed but a shed removed from the game — and it would
    // turn a neutral trading post into a strategic square to squat in.
    for (const seed of [1, 2, 3, 4]) {
        const world = createWorld({ seed, effects: false });
        for (let i = 0; i < Math.round(900 / DT); i++) stepWorld(world, DT);

        for (const shed of world.ships) {
            if (shed.dead || shed.role !== 'outpost') continue;
            assert.ok(!inSanctuary(world, shed.x, shed.y),
                `seed ${seed}: an outpost was sited inside the market's bubble`);
        }
    }
});
