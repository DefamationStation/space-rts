// ============================================================
// TESTS — TELEMETRY / THE FLIGHT RECORDER
// ============================================================
//
// Split out of sim.test.js for wall-clock only; the assertions are
// unchanged. `node --test` runs *files* concurrently and the tests
// inside a file serially, so this block and the economy, behaviour
// and combat blocks were queueing behind one another while thirty
// cores sat idle. Two files finish in the time the slower one takes.
//
// These are the tests about the *recorder* rather than about the
// simulation, and they are expensive for a specific reason: they get
// their material by running a real world until it fights. See
// WAR_SECONDS.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorld, stepWorld } from '../src/sim/simulate.js';
import { makeShip } from '../src/sim/entities.js';
import { killShip } from '../src/sim/combat.js';
import { telemetry } from '../src/core/telemetry.js';
import { BEHAVIORS } from '../src/sim/behaviors/index.js';
import { FIXED_DT } from '../src/core/constants.js';

// Audits print through `console.table`, which is right in devtools
// and wrong in the middle of a test run. Silenced once, here.
telemetry.quiet = true;

const DT = FIXED_DT;

/**
 * Simulated seconds a test must run before it may assume a war.
 * Deliberately the same number as in sim.test.js — see the long note
 * there for why it is 720 and what makes it move.
 */
const WAR_SECONDS = 720;

/** Run a headless world for `seconds` and return it. */
function run(seconds, seed = 1) {
    const world = createWorld({ seed, effects: false });
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) stepWorld(world, DT);
    return world;
}

test('telemetry: filters and the ring buffer hold', () => {
    telemetry.disable().clear();
    const world = createWorld({ seed: 7, effects: false });
    for (let i = 0; i < Math.round(90 / DT); i++) stepWorld(world, DT);

    // One role only.
    telemetry.enable().only('miner');
    for (let i = 0; i < 120; i++) stepWorld(world, DT);
    assert.ok(telemetry.rows.length > 0, 'role filter captured nothing');
    assert.ok(telemetry.rows.every((r) => r.role === 'miner'), 'role filter leaked another role');

    // One ship only.
    const target = world.ships.find((s) => s.role === 'miner' && !s.dead);
    telemetry.clear().only(null).watch(target);
    for (let i = 0; i < 120; i++) stepWorld(world, DT);
    assert.ok(telemetry.rows.length > 0, 'watch captured nothing');
    assert.ok(telemetry.rows.every((r) => r.id === target.id), 'watch leaked another ship');

    // The cap is a cap, so a long run cannot exhaust memory.
    telemetry.clear().watch(0);
    telemetry.max = 50;
    for (let i = 0; i < 400; i++) stepWorld(world, DT);
    assert.ok(telemetry.rows.length <= 50, `ring buffer overran: ${telemetry.rows.length}`);

    // And it produces something usable at the end of it.
    const csv = telemetry.csv();
    assert.ok(csv.startsWith('tick,t,id,'), 'csv lost its header');
    assert.equal(csv.trim().split('\n').length, telemetry.rows.length + 1);

    telemetry.disable().clear();
    telemetry.max = 40000;
});

test('telemetry: the behavioural streams record what the motion stream cannot', () => {
    // Motion is sampled physics. A state that lives for three frames is
    // invisible to it and perfectly visible in the transition stream,
    // which is the whole reason the stream exists — so this checks the
    // three cheap streams fill up, carry their causes, and survive with
    // the expensive one switched off.
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(WAR_SECONDS / DT); i++) stepWorld(world, DT);

    assert.equal(telemetry.rows.length, 0, 'motion:false still recorded physics');
    assert.ok(telemetry.stateRows.length > 50, `only ${telemetry.stateRows.length} transitions`);
    assert.ok(telemetry.eventRows.length > 50, `only ${telemetry.eventRows.length} events`);
    assert.ok(telemetry.seriesRows.length > 100, `only ${telemetry.seriesRows.length} series rows`);

    // Every role's state machine should have been through something.
    const roles = new Set(telemetry.stateRows.map((r) => r.role));
    for (const role of ['miner', 'drone', 'fighter']) {
        assert.ok(roles.has(role), `no ${role} transition was ever recorded`);
    }

    // A transition out of a real state carries a cause. Entry
    // transitions — from '-' into a first state — legitimately do not.
    const labelled = telemetry.stateRows.filter((r) => r.from !== '-' && r.reason);
    const unlabelled = telemetry.stateRows.filter((r) => r.from !== '-' && !r.reason);
    assert.ok(labelled.length > unlabelled.length,
        `${unlabelled.length} unlabelled transitions vs ${labelled.length} labelled`);

    // Kills are attributed. Without the killer the log answers "a ship
    // died" and not "that fighter killed it", which is the version
    // worth having.
    const kills = telemetry.eventRows.filter((r) => r.event === 'kill');
    assert.ok(kills.length > 0, 'nothing died in two and a half minutes');
    assert.ok(kills.some((k) => k.otherId > 0), 'no kill was attributed to a killer');

    // Shots resolve into hits and misses, which is what makes accuracy
    // a number rather than an impression.
    const kinds = new Set(telemetry.eventRows.map((r) => r.event));
    for (const kind of ['shot', 'hit', 'miss', 'deposit', 'spawn']) {
        assert.ok(kinds.has(kind), `no '${kind}' event was ever recorded`);
    }

    // And each stream comes back out as its own CSV.
    for (const [kind, head] of [
        ['states', 'tick,t,id,'], ['events', 'tick,t,event,'], ['series', 'tick,t,stepMs,'],
    ]) {
        const csv = telemetry.csv(kind);
        assert.ok(csv.startsWith(head), `${kind} csv header is ${csv.slice(0, 24)}`);
        assert.equal(csv.trim().split('\n').length, telemetry._stream(kind).rows.length + 1);
    }

    // The audits run on real data without throwing, and say something.
    assert.ok(telemetry.behaviour().length > 0);
    assert.ok(telemetry.economy().length > 0);

    telemetry.disable().clear();
});

test('telemetry: a continuing condition collapses into one row per run', () => {
    // `EV.DEPOSIT` fires per transfer, which is per step while a miner
    // is docked — thousands of rows for tens of deliveries. Collapsed,
    // one row *is* one delivery, which removes the noise and produces
    // the better number at the same time: `amount` is what that trip
    // actually carried rather than what one step of it moved.
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(WAR_SECONDS / DT); i++) stepWorld(world, DT);

    const deposits = telemetry.eventRows.filter((r) => r.event === 'deposit');
    assert.ok(deposits.length > 0, 'nothing was ever delivered');
    const raw = deposits.reduce((s, r) => s + r.n, 0);
    assert.ok(raw > deposits.length * 10,
        `deposits barely collapsed: ${raw} emissions into ${deposits.length} rows`);
    // A delivery carries a real load, not one step's worth of one.
    const miner = world.ships.find((s) => s.role === 'miner');
    assert.ok(deposits.some((r) => r.amount > (miner ? miner.cargoMax : 20) * 0.25),
        'no collapsed delivery carried a meaningful load');
    for (const r of deposits) assert.ok(r.dur >= 0 && r.n >= 1);

    // Discrete events must NOT collapse — three rounds in a burst are
    // three rounds, and merging them would destroy the cadence that
    // the fire-control test exists to protect.
    const shots = telemetry.eventRows.filter((r) => r.event === 'shot');
    assert.ok(shots.length > 0, 'nothing ever fired');
    assert.ok(shots.every((r) => r.n === 1), 'shots were collapsed');

    // Working fields never reach the CSV or a console table.
    const csv = telemetry.csv('events');
    assert.ok(!csv.includes('_t0') && !csv.includes('_tick'), 'internal cursors leaked into the csv');
    assert.ok(telemetry.events(5).every((r) => !('_t0' in r)), 'internal cursors leaked into a table');

    telemetry.disable().clear();
});

test('telemetry: folding a burst loses rows and no information', () => {
    // The trade the folding makes has to be one-sided, or it is not a
    // trade. A hull repeating the same transition twice a second gets
    // one row with a count and a window instead of a hundred rows —
    // and every audit must read exactly the same numbers off either.
    //
    // Proved by running the same seed both ways. `burstGap: 0` is also
    // the switch you want when the folding itself is under suspicion.
    // A buffer big enough to hold the *unfolded* trace, which is the
    // whole point: this test treats the burstGap-0 run as ground
    // truth, and ground truth that has been silently truncated is not
    // ground truth. At the default 40,000 the raw run overflowed and
    // dropped 24,000 rows off the front, so `folded.visits` (60,692)
    // legitimately exceeded `raw.visits` (36,692) and the test
    // reported that folding had *invented* transitions. The recorder
    // was right and the measurement was clipped — 36,692 + 24,000 is
    // exactly 60,692.
    //
    // It surfaced when incursions started arriving as one dense wave
    // instead of a slow file, which is a change to the simulation
    // rather than to the recorder. Anything that raises the transition
    // rate would have done it.
    const play = (burstGap) => {
        telemetry.disable().clear();
        telemetry.enable({ motion: false, burstGap, max: 250000 });
        const world = createWorld({ seed: 7, effects: false });
        for (let i = 0; i < Math.round(WAR_SECONDS / DT); i++) stepWorld(world, DT);
        return {
            rows: telemetry.stateRows.length,
            behaviour: telemetry.behaviour(),
            reasons: telemetry.reasons(),
            visits: telemetry.stateRows.reduce((s, r) => s + r.n, 0),
            dropped: telemetry._dropped.states,
        };
    };

    const raw = play(0);
    const folded = play(1.5);

    // Belt and braces on the above: if either run ever truncates
    // again, say so plainly rather than blaming the folder.
    assert.equal(raw.dropped, 0, `the unfolded trace was truncated by ${raw.dropped} rows`);
    assert.equal(folded.dropped, 0, `the folded trace was truncated by ${folded.dropped} rows`);

    assert.equal(folded.visits, raw.visits, 'folding lost or invented transitions');
    // The bar is that folding does something, not that it does a
    // particular amount — because the amount is a property of the
    // *simulation*, not of the recorder.
    //
    // It sat at 0.8 and measured 44% saved, and the number that large
    // was mostly one fault: a fighter's EXTEND ended on the step it
    // began 72% of the time, so engage⇄extend flipped several times a
    // second and the folder was earning its keep on churn. Fixing the
    // fighter (see FIGHTER_EXTEND in core/constants.js) took the
    // saving to 9% — the folder did not get worse, the trace got
    // calmer, and a test that failed on *that* was asserting the
    // simulation stay broken.
    // Strictly fewer rows, and no threshold on *how many* fewer.
    //
    // This assertion has now been walked down twice by the same
    // mechanism, which is the sign it was measuring the wrong thing.
    // It began at 44% saved, fell to 9% when the fighter's EXTEND was
    // fixed, and fell again to under 1% when escorts started holding a
    // formation instead of re-deciding their charge every few seconds.
    // Each time the folder was fine and the *trace* had got calmer.
    //
    // A percentage bar therefore encodes "the simulation must keep
    // thrashing at least this much", and every improvement to
    // behaviour reads as a recorder regression. The claim worth
    // keeping is the one the note above already states: folding
    // collapses repetition without losing information. Losslessness is
    // asserted exactly, by `visits` and by the audits below; this line
    // only has to show the collapse happens at all.
    assert.ok(folded.rows < raw.rows,
        `folding collapsed nothing: ${raw.rows} → ${folded.rows}`);
    assert.ok(raw.rows > 1000, 'the sample was too small to mean anything');

    // Counts and extremes are integers and maxima — they must match exactly.
    assert.equal(folded.behaviour.length, raw.behaviour.length);
    for (let i = 0; i < raw.behaviour.length; i++) {
        const a = raw.behaviour[i];
        const b = folded.behaviour[i];
        assert.equal(b.role + b.state, a.role + a.state, 'the audits disagree on their rows');
        assert.equal(b.entries, a.entries, `${a.role}:${a.state} visit count changed`);
        assert.equal(b.max, a.max, `${a.role}:${a.state} longest dwell changed`);
        // Means are float sums in a different order, so compare as numbers.
        assert.ok(Math.abs(parseFloat(b.mean) - parseFloat(a.mean)) < 0.02,
            `${a.role}:${a.state} mean dwell moved: ${a.mean} → ${b.mean}`);
    }
    assert.deepEqual(folded.reasons, raw.reasons, 'the transition tally changed');

    telemetry.disable().clear();
});

test('telemetry: the audits answer when, how long, and which one', () => {
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(WAR_SECONDS / DT); i++) stepWorld(world, DT);

    // WHEN. Aggregating a whole run answers the wrong tense for half
    // the questions worth asking — a lead that is irreversible by
    // minute two is a different problem from one that arrives at ten.
    const timeline = telemetry.timeline(60);
    // One bucket per minute of the run, derived rather than copied —
    // the claim is that bucketing tracks elapsed time, not that a run
    // happens to be six minutes long.
    // Floor plus one: the run's final instant opens a bucket of its
    // own, so a 300 s run produced six and a 480 s run produces nine.
    const expectedBuckets = Math.floor(WAR_SECONDS / 60) + 1;
    assert.equal(timeline.length, expectedBuckets,
        `expected ${expectedBuckets} buckets, got ${timeline.length}`);
    assert.ok(timeline.every((b) => Math.abs(b.lead) <= 1), 'lead escaped [-1, 1]');
    assert.ok(timeline[timeline.length - 1].ore >= timeline[0].ore, 'ore went backwards');

    // HOW LONG. Spawns and kills have carried ids from the start and
    // nothing joined them, so "built 30, lost 16" was as close as the
    // report could get to whether a hull was worth building.
    const life = telemetry.lifecycle();
    assert.ok(life.length >= 3, 'not every role was seen');
    for (const row of life) {
        assert.ok(parseFloat(row.meanLife) > 0, `${row.role} has no lifetime`);
        assert.ok(row.hulls >= row.stillAlive);
    }
    assert.ok(life.some((r) => r.killedBy !== '—'), 'nothing was ever attributed to a killer');

    // WHICH ONE. An average hides a single stuck ship completely, and
    // a single stuck ship is what you are usually chasing.
    const ships = telemetry.ships(10);
    assert.ok(ships.length > 0 && ships.length <= 10);
    for (let i = 1; i < ships.length; i++) {
        assert.ok(ships[i - 1].churn >= ships[i].churn, 'ships() is not worst-first');
    }
    assert.ok(ships.every((s) => s.id > 0 && s.role), 'a ship row lost its identity');

    // Production decisions are traced, not inferred from the treasury.
    const eco = telemetry.economy();
    assert.ok(eco.every((e) => e.cycle !== undefined && e.trips >= 0));
    assert.ok(telemetry.eventRows.some((r) => r.event === 'build'), 'no build was recorded');

    telemetry.disable().clear();
});

test('telemetry: the diagnosis names a fault rather than printing a table', () => {
    // Six tables of numbers is not the same thing as knowing what is
    // wrong, and this asserts the gap is closed.
    //
    // The fault is planted rather than borrowed. An earlier version of
    // this test leaned on a real one — the mothership used to enter
    // `building` and never leave — and passed for exactly as long as
    // the bug survived, then failed the moment it was fixed. A test
    // that breaks when the code gets better is worse than no test, so
    // the dead-end state here is a synthetic one.
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(WAR_SECONDS / DT); i++) stepWorld(world, DT);

    // A state machine with no way out: entered, never left, and by now
    // long overdue. Set after the last step so no behaviour overwrites
    // it — `behaviour()` folds live ships in, which is what lets the
    // rule see a visit that has not ended.
    // Plant one if the run did not leave one alive. The subject here
    // is the *diagnosis*, not whether a particular seed happens to
    // still have a warship flying at this point — and once production
    // became posture-gated and upkeep started thinning fleets, seed
    // 4242 stopped guaranteeing one.
    let victim = world.ships.find((s) => !s.dead && s.role === 'fighter');
    if (!victim) {
        victim = makeShip(world, 'fighter', 0, world.width * 0.5, world.height * 0.5);
        world.addShip(victim);
    }
    assert.ok(victim, 'no fighter to plant the fault on');
    victim.state = 'wedged';
    victim.stateTime = 300;

    const found = telemetry.diagnose();
    assert.ok(found.length > 0, 'the diagnosis found nothing at all');
    assert.ok(found.every((f) => f.level && f.what && f.detail), 'a finding is missing its parts');
    // Ranked, so the first thing read is the worst thing found.
    const rank = { high: 0, medium: 1, note: 2 };
    for (let i = 1; i < found.length; i++) {
        assert.ok(rank[found[i - 1].level] <= rank[found[i].level], 'findings are not ranked');
    }
    assert.ok(found.some((f) => f.what === 'never leaves a state' && /wedged/.test(f.detail)),
        'the terminal-state rule missed a state machine with no exit');
    // And it does not cry wolf over states that are left all the time.
    assert.ok(!found.some((f) => f.what === 'never leaves a state' && /'work'/.test(f.detail)),
        'the terminal-state rule fired on a state that is left constantly');

    telemetry.disable().clear();
});

test('telemetry: recording can be scoped to one hull class and two streams', () => {
    // The working shape when you are building something new: record
    // the class you are adding and whatever it touches, and nothing
    // else. Two independent dials — which streams, and which ships —
    // because "record less" is two different questions.
    telemetry.disable().clear();
    telemetry.enable({ streams: 'states,events', type: 'drone,miner' });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(180 / DT); i++) stepWorld(world, DT);

    // Streams: exactly the two named, nothing else.
    assert.ok(telemetry.stateRows.length > 0, 'states were asked for and not recorded');
    assert.ok(telemetry.eventRows.length > 0, 'events were asked for and not recorded');
    assert.equal(telemetry.rows.length, 0, 'motion was not asked for');
    assert.equal(telemetry.seriesRows.length, 0, 'series was not asked for');
    assert.equal(telemetry.anomalies.length, 0, 'checks were not asked for');

    // Filter: only the named hull classes, on every stream at once.
    const kinds = new Set(telemetry.stateRows.map((r) => r.type));
    assert.deepEqual([...kinds].sort(), ['drone', 'miner'], 'the type filter leaked');
    for (const r of telemetry.eventRows) {
        if (r.type) assert.ok(r.type === 'drone' || r.type === 'miner', `event leaked a ${r.type}`);
    }
    assert.ok(!telemetry.eventRows.some((r) => r.event === 'shot'),
        'a filter that excludes every armed hull still recorded shots');

    // And it says what it left out, on both axes.
    const found = telemetry.diagnose();
    assert.ok(found.some((f) => f.what === 'recording was filtered' && /drone/.test(f.detail)));
    assert.ok(found.some((f) => f.what === 'streams switched off' && /motion/.test(f.detail)));
    assert.ok(/types/.test(telemetry.scope()), `scope() reads '${telemetry.scope()}'`);

    // One faction, by itself.
    telemetry.disable().clear();
    telemetry.enable({ streams: 'states', faction: 1 });
    for (let i = 0; i < Math.round(60 / DT); i++) stepWorld(world, DT);
    assert.ok(telemetry.stateRows.length > 0, 'the faction filter captured nothing');
    assert.ok(telemetry.stateRows.every((r) => r.faction === 1), 'the faction filter leaked');

    // Back to everything.
    telemetry.disable().clear();
    telemetry.enable();
    assert.equal(telemetry.scope(), '', 'enable() should clear a previous filter');
    telemetry.disable().clear();
});

test('telemetry: a filtered or truncated recording says so', () => {
    // The failure this guards is silent wrongness. `only('miner')`
    // records no shots, so the combat figures read as a fleet that
    // never fires — which is indistinguishable from a real bug unless
    // the tool admits what it was told to ignore.
    telemetry.disable().clear();
    telemetry.enable({ motion: false }).only('miner');

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(120 / DT); i++) stepWorld(world, DT);

    assert.ok(telemetry.diagnose().some((f) => f.what === 'recording was filtered'),
        'a filtered recording reported combat figures without a caveat');

    // And a buffer that overran says which audit lost its start.
    telemetry.disable().clear().only(null);
    telemetry.enable({ motion: false });
    telemetry.max = 40;
    for (let i = 0; i < Math.round(180 / DT); i++) stepWorld(world, DT);
    assert.ok(telemetry.diagnose().some((f) => f.what === 'log truncated'),
        'a truncated log was reported as if it were complete');
    assert.ok(/dropped/.test(String(telemetry.status().states)), 'status hid the dropped rows');

    telemetry.disable().clear();
    telemetry.max = 40000;
});

test('telemetry: the invariant scan stays quiet on a healthy run', () => {
    // Not a promise that the simulation is perfect — it is a promise
    // that the scan does not cry wolf. A watchdog with a false positive
    // is a watchdog nobody reads.
    telemetry.disable().clear();
    telemetry.enable({ motion: false });

    const world = createWorld({ seed: 4242, effects: false });
    for (let i = 0; i < Math.round(60 / DT); i++) stepWorld(world, DT);

    const noise = telemetry.anomalies.filter((a) => a.what !== 'stuck in state');
    assert.deepEqual(noise, [], 'the invariant scan fired on a healthy minute');

    telemetry.disable().clear();
});
