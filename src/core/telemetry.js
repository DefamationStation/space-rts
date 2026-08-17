// ============================================================
// TELEMETRY — THE FLIGHT RECORDER
// ============================================================
//
// A switchable recorder for what ships are actually doing, step by
// step. It exists because motion bugs are the hardest class to see
// and the easiest class to argue about: "it wiggles a bit at the
// end" is a completely fair report and completely un-actionable
// until someone can point at the frame where the nose moves and
// say what the ship was being asked to do at the time.
//
// It records four streams, because "what is this ship doing" turns
// out to be four different questions:
//
//   motion   per-step physics — where a hull is, what it was asked
//            for, and what its engines actually delivered
//   states   every behaviour transition, with how long the previous
//            state lasted and why it ended
//   events   the simulation's own announcements — shots, hits,
//            kills, deposits, spawns, depletions
//   series   world scalars sampled on an interval — treasuries,
//            populations, ore in flight
//
// Motion answers "is the flight model right". The other three
// answer "is the *behaviour* right", which is the question you
// cannot get at by staring at a tab.
//
// ------------------------------------------------------------
// THE RULES IT PLAYS BY
// ------------------------------------------------------------
//
//   · Off by default, and off costs one boolean read per step and
//     one per state transition.
//   · It never touches `world.rng`, never writes simulation state,
//     and never allocates while disabled — so a recorded run and an
//     unrecorded one stay bit-identical. There is a test.
//   · No DOM, no browser APIs, and no `node:fs`, at import time or
//     any other time. It returns strings; callers write files. That
//     is what lets it work exactly the same under `node --test`, in
//     a tab, and in `tools/sim.mjs`.
//
// ------------------------------------------------------------
// USING IT
// ------------------------------------------------------------
//
// In a browser, `?telemetry=1` turns it on and puts it on
// `window.telemetry`. From there:
//
//   telemetry.diagnose()       the audits read for you — start here
//   telemetry.behaviour()      where each role's time goes
//   telemetry.economy()        throughput, round trips, accuracy
//   telemetry.lifecycle()      how long hulls live and what kills them
//   telemetry.ships(20)        one row per hull, worst first
//   telemetry.timeline(60)     the run on a time axis
//   telemetry.flight()         the motion audit
//   telemetry.table(40)        last N motion rows, as a console table
//   telemetry.save('run.csv')  write to .captures/ via the dev server
//
// Headless, import it and call `telemetry.enable()` before stepping,
// or use `tools/sim.mjs`, which does all of this and prints a report.
//
// ------------------------------------------------------------
// RECORDING LESS
// ------------------------------------------------------------
//
// Two independent dials, because "record less" is two different
// questions. **Streams** decide what kind of thing is recorded;
// **filters** decide which ships it is recorded for. Building one hull
// class usually wants both — the cheap streams, and only the hulls
// involved:
//
//   telemetry.enable({ streams: 'states,events', type: 'gunship' })
//   telemetry.only({ role: 'fighter', faction: 0 })
//   telemetry.watch([42, 43])
//   telemetry.status()         what is on, and what has been dropped
//
// A `streams` list is exclusive: anything unnamed is off. Filters are
// ANDed. `only()` replaces the filter rather than adding to it.
//
// Whatever is narrowed, `diagnose()` says so — a miners-only capture
// reports zero shots, which is indistinguishable from a fleet that
// never fires unless the tool admits what it was told to ignore.

import { TAU } from './math.js';
import { EV } from './events.js';
import { MINING_RADIUS } from './constants.js';

/** Rows are dropped from the front past this, so a long run cannot eat memory. */
const DEFAULT_MAX = 40000;

/** Steps between world-scalar samples. 60 = one row per simulated second. */
const DEFAULT_SERIES_EVERY = 60;

/** Steps between invariant scans. A violation does not appear and vanish inside half a second. */
const CHECK_EVERY = 30;

/**
 * A ship sitting in one state longer than this is stuck, not busy.
 *
 * Deliberately generous, because this check runs live and knows
 * nothing about what is normal for the state it is looking at. At 45s
 * it flagged miners doing an ordinary long shift at a rich field,
 * whose honest maximum is around 50. The two detectors divide the work
 * instead: this one catches gross hangs on an absolute threshold, and
 * `diagnose()`'s intermittent-stall rule — which has the whole
 * distribution and fires at eight times a state's own mean — catches
 * the shorter outliers that no fixed number could separate from work.
 */
const STUCK_SECONDS = 90;

/**
 * States with no natural end, which the stuck check must therefore
 * not report.
 *
 * A fighter with nothing in reach loiters around its charge for as
 * long as that stays true, and on a quiet map that is minutes. The
 * first sweep flagged 456 of those against 13 real findings, which is
 * the classic way a watchdog stops being read at all — so the
 * exemption is a list of states that are *designed* to be open-ended
 * rather than a threshold nudged upward until the noise goes away.
 */
const LOITER_STATES = new Set(['patrol', 'idle', 'orphan', 'stowed', 'muster']);

/**
 * Two-state cycles that are the design rather than a fault.
 *
 * A fighter's attack run *is* engage → extend → engage: dive, slice
 * past, loop back round. The ping-pong rule cannot tell that apart
 * from a state machine changing its mind, and it should not try —
 * guessing at intent from dwell times would either miss real thrash
 * or start excusing it. So the exception is declared, in the same
 * spirit as `LOITER_STATES`: a designed loop is written down here, and
 * anything not written down is a finding.
 */
const DESIGNED_CYCLES = new Set(['fighter:engage>extend']);

/** The individual states of a designed cycle — short visits there are the point. */
const CYCLE_STATES = new Set(
    [...DESIGNED_CYCLES].flatMap((k) => {
        const [role, pair] = k.split(':');
        return pair.split('>').map((s) => role + ':' + s);
    }),
);

/**
 * States whose duration is bounded by the design, so a short mean is
 * the mechanism working rather than a hull changing its mind.
 *
 * The third and last exemption, and the same shape as the other two:
 * a written-down list, not a threshold nudged until the noise stops.
 *
 * `drone:unload` is a transfer of `DRONE_CARGO` at `DRONE_UNLOAD_RATE`
 * — 8 ore at 10 ore/s. Its longest possible visit is 0.8 s, measured
 * max 0.8 s, and the thrashing rule fires below 0.5 s. So the rule was
 * reporting a state that *cannot* exceed its threshold by much, on 6
 * of 10 seeds, every run, forever: `drone enters 'unload' 517× at
 * 0.48s each`. Those 517 visits are 517 deliveries.
 *
 * The bar for adding one: the state's maximum duration must follow
 * from a constant, not from how things happen to go. If a state is
 * short because the ship keeps giving up on it, that is the finding.
 */
const BRIEF_STATES = new Set(['drone:unload']);

/**
 * Events that describe a continuing condition rather than an
 * incident, and are therefore collapsed into one row per run.
 *
 * `deposit` fires per transfer, which is per step while a miner is
 * docked: seven thousand rows for seventy deliveries, and a log that
 * is ninety-nine percent one event is a log nobody reads. Collapsed,
 * one row *is* one delivery — with `amount` the total moved, `n` the
 * raw emissions and `dur` how long the docking took. The de-bloat and
 * the better number are the same change.
 *
 * Discrete events are never collapsed. Three rounds in a burst are
 * three rounds, and merging them would destroy the cadence the fire
 * control test exists to protect.
 */
const COALESCE = new Set(['deposit', 'blocked']);

/** Ticks of slack when deciding whether two emissions are the same run. */
const COALESCE_GAP = 6;

/**
 * A hull repeating the same transition faster than this is bursting,
 * not working, and the repeats fold into one row carrying a count and
 * a window.
 *
 * The threshold is what keeps a trace a trace. One drone docks with
 * its miner eighty-five times in a ten-minute run — that is eighty-five
 * separate deliveries spread over ten minutes and every one of them is
 * a fact worth keeping. The same drone flipping between two states
 * twice a second is one fact repeated, and it is also, reliably, the
 * condition that turns the log into ten thousand lines exactly when
 * you have opened it to find out what went wrong. Measured on a
 * healthy run this folds 44% of transitions; on the fighter ping-pong
 * it would have folded 3,900 rows into two.
 *
 * Nothing is lost to it. The folded row carries `n`, the window
 * (`t`→`lastT`), the total dwell and the longest single dwell, so
 * every audit reads the same numbers it would have from the rows.
 */
const STATE_BURST_GAP = 1.5;

/** How far back per hull to look for the repeat — enough for a cycle of four states. */
const STATE_CYCLE_DEPTH = 4;

/** Rows a table prints before it starts saying "+N more" instead. */
const TABLE_LIMIT = 40;

/** The switchable streams, in the order they are reported. */
const STREAMS = ['motion', 'states', 'events', 'series', 'checks'];

/** Signed angle from `from` to `to`, in (-PI, PI]. Local copy: no imports for one line. */
function delta(from, to) {
    let d = (to - from) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    return d;
}

const COLUMNS = [
    'tick', 't', 'id', 'type', 'role', 'faction', 'state', 'stateTime',
    'x', 'y', 'vx', 'vy', 'speed',
    'angle', 'noseOff',
    'wantMag', 'wantOff',
    'throttle', 'rcsLat', 'rcsRetro',
    'hp', 'cargo',
    // The behavioural pointers. All of them already live on the ship
    // and every one of them is the answer to a question the motion
    // columns cannot reach: who is it shooting at, whose drone is it,
    // which field does it think it owns, what is it cutting.
    'targetId', 'parentId', 'claimId', 'beamTargetId', 'escortId',
];

const STATE_COLUMNS = [
    'tick', 't', 'id', 'type', 'role', 'faction', 'from', 'to', 'dwell', 'reason',
    // Only meaningful when a burst folded: how many transitions this
    // row stands for, when the last of them happened, and the dwell
    // totalled and peaked across all of them. `dwell` keeps its
    // original meaning — the first occurrence — so a row with n=1
    // reads exactly as it always did.
    'n', 'lastT', 'dwellSum', 'maxDwell',
];

const EVENT_COLUMNS = [
    'tick', 't', 'event', 'id', 'type', 'role', 'faction',
    // The other party — the killer of a kill, the parent of a spawn,
    // the station of a deposit — resolved at emit time. Resolving it
    // later means scanning back through the log for the last row that
    // mentioned the id, which is both slow and a guess.
    'otherId', 'otherRole', 'otherFaction',
    'x', 'y', 'amount',
    // Only meaningful for collapsed events: how many raw emissions the
    // row stands for, and how long the run lasted.
    'n', 'dur', 'detail',
];

const SERIES_COLUMNS = [
    'tick', 't', 'stepMs', 'ships', 'rocks', 'shots', 'fx', 'fieldOre',
    'oreExtracted', 'oreLost', 'oreInTransit', 'hash',
    // Per faction, flattened: the CSV wants a fixed header and two
    // factions is the roster. See `_series` for the widening rule.
    'f0_metal', 'f0_miner', 'f0_drone', 'f0_fighter', 'f0_built', 'f0_lost',
    'f1_metal', 'f1_miner', 'f1_drone', 'f1_fighter', 'f1_built', 'f1_lost',
];

/** Worlds already wired to the event bus. Weak, so a discarded world is collectable. */
const ATTACHED = new WeakSet();

/**
 * Whether an audit prints as well as returns.
 *
 * Printing is a convenience for a devtools console, where an audit is
 * something you type and want to see. Everywhere else — a test, a
 * report with its own printer, one audit calling another — it is
 * output in the middle of somebody else's output. `telemetry.quiet`
 * turns it off, which is what a caller wanting the rows should say,
 * rather than reaching over and replacing `console.table`.
 */
let QUIET = false;

class Telemetry {
    constructor() {
        this.enabled = false;

        /** Per-step physics. The original stream. */
        this.rows = [];
        /** Behaviour transitions. One row per `setState` that actually changed something. */
        this.stateRows = [];
        /** Simulation events, straight off the bus. */
        this.eventRows = [];
        /** World scalars, sampled on an interval. */
        this.seriesRows = [];
        /** Invariant violations, first occurrence of each, in order. */
        this.anomalies = [];

        this.max = DEFAULT_MAX;
        this.every = 1;              // record one motion row in N steps
        this.seriesEvery = DEFAULT_SERIES_EVERY;
        this.lastStepMs = 0;

        // ----- filters --------------------------------------
        // null means "no restriction on this axis". All four are ANDed,
        // so a filter narrows rather than widens. See `only`.
        this.watchIds = null;        // Set of ship ids
        this.roles = null;           // Set of role names
        this.types = null;           // Set of ship type ids
        this.factionId = null;       // number

        // ----- streams --------------------------------------
        // Motion is the expensive one — a row per ship per step, over a
        // million for a ten-minute run — so long sessions turn it off
        // and keep the cheap three, which are the ones that answer
        // behavioural questions anyway.
        this.streams = { motion: true, states: true, events: true, series: true, checks: true };
        // Seconds; 0 turns burst folding off and writes every
        // transition as its own row. A tool should let you switch off
        // its own cleverness — when the folding is the thing under
        // suspicion, or when you want the unabridged trace, this is
        // the switch. There is a test that the two agree.
        this.burstGap = STATE_BURST_GAP;

        this._intent = new Map();    // id → [wantX, wantY], captured pre-integration
        // Per stream, not one shared total. A truncated buffer skews
        // whichever audit reads it, and a single number cannot say
        // which audit to stop trusting.
        this._dropped = { motion: 0, states: 0, events: 0, series: 0 };
        this._open = new Map();      // event key → the row currently being collapsed into
        this._recent = new Map();    // ship id → its last few transition rows, for folding bursts
        // The world currently being stepped. `setState` has no access to
        // one — it takes a ship and a name — so the step hands it over
        // on the way in rather than every call site growing an argument.
        this._world = null;
        this._seen = new Map();      // anomaly key → its row, so recurrence is counted
    }

    // --------------------------------------------------------
    // CONTROL
    // --------------------------------------------------------

    /**
     * Switch the recorder on, optionally scoped.
     *
     * Two independent dials, because "record less" is two different
     * questions. **Streams** decide what kind of thing is recorded;
     * **filters** decide which ships it is recorded for. Working on one
     * hull class usually wants both: the behavioural streams only, and
     * only the hulls involved.
     *
     *   telemetry.enable()                              everything
     *   telemetry.enable({ motion: false })             skip the expensive stream
     *   telemetry.enable({ streams: 'states,events' })  exactly those two
     *   telemetry.enable({ type: 'gunship' })           one hull class
     *   telemetry.enable({ role: ['gunship', 'fighter'], faction: 0 })
     *
     * @param streams  a comma list — anything not named is off. Omit for all.
     * @param motion/states/events/series/checks  individual overrides.
     * @param role/type/faction/watch  the filter; see `only`.
     */
    enable({
        every = 1, max = DEFAULT_MAX, seriesEvery = DEFAULT_SERIES_EVERY,
        burstGap = STATE_BURST_GAP,
        streams = null, motion, states, events, series, checks,
        role = null, type = null, faction = null, watch = 0,
    } = {}) {
        this.burstGap = burstGap;
        this.every = Math.max(1, every | 0);
        this.max = max;
        this.seriesEvery = Math.max(1, seriesEvery | 0);

        // A `streams` list is exclusive — naming one turns the rest
        // off. Individual flags then override, so `{streams:'states',
        // series:true}` reads the way it looks.
        const named = streams ? new Set(String(streams).split(/[,\s]+/).filter(Boolean)) : null;
        for (const s of STREAMS) this.streams[s] = named ? named.has(s) : true;
        const explicit = { motion, states, events, series, checks };
        for (const s of STREAMS) if (explicit[s] !== undefined) this.streams[s] = !!explicit[s];

        this.only({ role, type, faction, id: watch });
        this.enabled = true;
        return this;
    }

    disable() { this.enabled = false; return this; }

    /** True to make the audits return their rows without printing them. */
    get quiet() { return QUIET; }

    set quiet(v) { QUIET = !!v; }

    clear() {
        this.rows.length = 0;
        this.stateRows.length = 0;
        this.eventRows.length = 0;
        this.seriesRows.length = 0;
        this.anomalies.length = 0;
        this.lastStepMs = 0;
        this._intent.clear();
        this._seen.clear();
        this._open.clear();
        this._recent.clear();
        this._dropped = { motion: 0, states: 0, events: 0, series: 0 };
        return this;
    }

    recordStepDuration(ms) {
        this.lastStepMs = ms;
    }

    /** Follow specific ships. Pass a ship, an id, a list of either, or 0 for all. */
    watch(ships) {
        this.watchIds = toSet(ships, idOf);
        return this;
    }

    /**
     * Narrow what gets recorded to the hulls you care about.
     *
     *   only('miner')                      one role
     *   only('gunship,fighter')            or several
     *   only({ type: 'gunship' })          one hull class, whatever its role
     *   only({ role: 'fighter', faction: 0 })
     *   only(null)                         everything again
     *
     * `type` matters as much as `role` because the architecture
     * encourages a new hull class to *reuse* an existing behaviour —
     * a second warship is likely to be `role: 'fighter'`, and a role
     * filter would sweep up the old one with it.
     *
     * A call replaces the whole filter rather than adding to it, which
     * is what "only" should mean. Filters scope every stream and the
     * per-ship invariant checks; world-level checks — fields, rocks —
     * always run, because a field does not belong to a role.
     */
    only(spec) {
        const f = spec === null || spec === undefined ? {}
            : (typeof spec === 'string' || Array.isArray(spec)) ? { role: spec } : spec;
        this.roles = toSet(f.role);
        this.types = toSet(f.type);
        this.factionId = f.faction === null || f.faction === undefined ? null : (f.faction | 0);
        this.watchIds = toSet(f.id, idOf);
        return this;
    }

    /** A one-line description of the current filter, or '' for unfiltered. */
    scope() {
        const parts = [];
        if (this.watchIds) parts.push('ships ' + [...this.watchIds].join(','));
        if (this.roles) parts.push('roles ' + [...this.roles].join(','));
        if (this.types) parts.push('types ' + [...this.types].join(','));
        if (this.factionId !== null) parts.push('faction ' + this.factionId);
        return parts.join(' · ');
    }

    // --------------------------------------------------------
    // WIRING
    // --------------------------------------------------------

    /**
     * Subscribe to a world's event bus.
     *
     * Called unconditionally when a world is built, because the
     * recorder may be switched on later and a subscription made after
     * the fact has already missed everything. The handlers cost a
     * closure each and read one boolean when the recorder is off.
     *
     * Payloads are reused between emits — see the note on
     * `EventBus.emit` — so every handler copies what it needs and
     * retains nothing.
     */
    attach(world) {
        if (!world || ATTACHED.has(world)) return world;
        ATTACHED.add(world);
        const bus = world.events;

        const on = (type, kind, pick) => bus.on(type, (e) => {
            if (!this.enabled) return;               // before any work at all
            pick(e, kind);
        });

        on(EV.SHOT_FIRED, 'shot', (e, k) => this._event(world, k, e.id, 0, e.x, e.y, ''));
        on(EV.SHOT_HIT, 'hit', (e, k) =>
            this._event(world, k, e.ownerId, e.target ? e.target.id : 0, e.x, e.y, ''));
        on(EV.SHOT_EXPIRED, 'miss', (e, k) => this._event(world, k, 0, 0, e.x, e.y, '', e.faction));
        on(EV.SHIP_SPAWNED, 'spawn', (e, k) =>
            this._event(world, k, e.ship.id, e.ship.parentId, e.ship.x, e.ship.y, ''));
        on(EV.SHIP_DIED, 'kill', (e, k) =>
            this._event(world, k, e.ship.id, e.killerId || 0, e.ship.x, e.ship.y, ''));
        on(EV.ORE_DEPLETED, 'depleted', (e, k) =>
            this._event(world, k, e.asteroid.id, 0, e.asteroid.x, e.asteroid.y, ''));
        on(EV.DEPOSIT, 'deposit', (e, k) =>
            this._event(world, k, e.ship.id, e.ship.homeId, e.ship.x, e.ship.y, e.amount));
        on(EV.BUILD_STARTED, 'build', (e, k) =>
            this._event(world, k, e.ship.id, 0, e.ship.x, e.ship.y, '', undefined, e.type));
        on(EV.BUILD_BLOCKED, 'blocked', (e, k) =>
            this._event(world, k, e.ship.id, 0, e.ship.x, e.ship.y, '', undefined, e.reason));
        on(EV.CLAIM_TAKEN, 'claim', (e, k) =>
            this._event(world, k, e.ship.id, 0, e.field.x, e.field.y, '', undefined, 'field' + e.field.id));
        on(EV.CLAIM_RELEASED, 'unclaim', (e, k) =>
            this._event(world, k, e.ship.id, 0, e.field.x, e.field.y, '', undefined, 'field' + e.field.id));
        // A faction changing strategy is the highest-level decision in
        // the simulation and draws nothing at all, which is exactly the
        // case core/events.js argues is still worth announcing. Without
        // it, posture is a layer that can only be verified by reading
        // the code that implements it.
        on(EV.POSTURE_CHANGED, 'posture', (e, k) =>
            this._event(world, k, 0, 0, 0, 0, '', e.faction.id, e.from + '→' + e.to));
        on(EV.SHIP_ERROR, 'error', (e, k) => {
            this._event(world, k, e.ship.id, 0, e.ship.x, e.ship.y, '', undefined, e.ship.quarantineError);
            const key = 'quarantine:' + e.ship.id;
            if (!this._seen.has(key) && this.anomalies.length < 500) {
                const row = {
                    t: round(world.time, 2),
                    what: 'ship quarantined',
                    id: e.ship.id,
                    detail: `${e.ship.type} ${e.ship.role} threw: ${e.ship.quarantineError}`,
                    count: 1,
                    lastT: round(world.time, 2),
                };
                this._seen.set(key, row);
                this.anomalies.push(row);
            }
        });

        return world;
    }

    /**
     * Called at the top of a step, before anything decides anything.
     * Hands over the world for the step, samples the scalars, and runs
     * the invariant scan.
     */
    begin(world) {
        if (!this.enabled) return;
        this._world = world;
        if (this.streams.series && world.tick % this.seriesEvery === 0) this._series(world);
        if (this.streams.checks && world.tick % CHECK_EVERY === 0) this._check(world);
    }

    // --------------------------------------------------------
    // CAPTURE — MOTION
    // --------------------------------------------------------
    //
    // Two hooks, because the interesting part of a steering bug is
    // the gap between what a ship *asked* for and what its engines
    // could actually do about it. The request only exists between
    // the behaviours running and `applyMotion` consuming it, so it
    // has to be caught on the way past.

    /** Called after behaviours, before integration. Records the raw request. */
    intent(world) {
        if (!this.enabled || !this.streams.motion || world.tick % this.every) return;
        const ships = world.ships;
        for (let i = 0; i < ships.length; i++) {
            const s = ships[i];
            if (s.dead || !this._wanted(s)) continue;
            this._intent.set(s.id, [s.ax, s.ay]);
        }
    }

    /** Called after integration. Records the result, and emits the row. */
    motionStep(world) {
        if (!this.enabled || !this.streams.motion || world.tick % this.every) return;
        const ships = world.ships;

        for (let i = 0; i < ships.length; i++) {
            const s = ships[i];
            if (s.dead || !this._wanted(s)) continue;

            const speed = Math.hypot(s.vx, s.vy);
            const travel = speed > 1e-6 ? Math.atan2(s.vy, s.vx) : s.angle;
            const want = this._intent.get(s.id);
            const wantMag = want ? Math.hypot(want[0], want[1]) : 0;

            this._push(this.rows, {
                tick: world.tick,
                t: round(world.time, 3),
                id: s.id,
                type: s.type,
                role: s.role,
                faction: s.factionId,
                state: s.state,
                stateTime: round(s.stateTime, 2),
                x: round(s.x, 2), y: round(s.y, 2),
                vx: round(s.vx, 2), vy: round(s.vy, 2),
                speed: round(speed, 2),
                angle: round(deg(s.angle), 1),
                // The number that matters for this whole class of bug:
                // how far the hull is pointing off the way it is going.
                noseOff: round(deg(delta(travel, s.angle)), 1),
                wantMag: round(wantMag, 1),
                wantOff: wantMag > 1e-6
                    ? round(deg(delta(travel, Math.atan2(want[1], want[0]))), 1) : '',
                throttle: round(s.throttle, 3),
                rcsLat: round(s.rcsLat, 3),
                rcsRetro: round(s.rcsRetro, 3),
                hp: round(s.hp, 1),
                cargo: round(s.cargo, 2),
                targetId: s.targetId,
                parentId: s.parentId,
                claimId: s.claimId,
                beamTargetId: s.beamTargetId,
                escortId: s.escortId,
            }, 'motion');
        }
        this._intent.clear();
    }

    // --------------------------------------------------------
    // CAPTURE — BEHAVIOUR
    // --------------------------------------------------------

    /**
     * One behaviour transition. Called from `setState`, which is the
     * single funnel every state change in the project passes through
     * — so this stream is complete by construction rather than by
     * anyone remembering to log.
     *
     * `dwell` is how long the state being left actually lasted, which
     * is the number the motion stream can never give you: a state that
     * lives for three frames is invisible to a sampled recorder and
     * perfectly visible here.
     */
    transition(ship, from, to, reason) {
        if (!this.enabled || !this.streams.states || !this._wanted(ship)) return;
        const world = this._world;
        const time = world ? world.time : 0;
        const dwell = round(ship.stateTime, 3);
        const key = (from || '-') + '>' + to + '|' + (reason || '');

        // Fold a repeat this hull has just made. Scanned over its last
        // few transitions rather than only the previous one, because a
        // burst is a *cycle* — A→B, B→A, A→B — and the row to fold into
        // is never the one immediately before.
        let recent = this.burstGap > 0 ? this._recent.get(ship.id) : null;
        if (recent) {
            for (let i = 0; i < recent.length; i++) {
                const row = recent[i];
                if (row._key !== key || time - row.lastT > this.burstGap) continue;
                row.n++;
                row.lastT = round(time, 3);
                row.dwellSum = round(row.dwellSum + dwell, 3);
                row.maxDwell = Math.max(row.maxDwell, dwell);
                return;
            }
        } else if (this.burstGap > 0) {
            if (this._recent.size > 4096) this._recent.clear();
            this._recent.set(ship.id, recent = []);
        }

        const row = {
            tick: world ? world.tick : 0,
            t: round(time, 3),
            id: ship.id,
            type: ship.type,
            role: ship.role,
            faction: ship.factionId,
            from: from || '-',
            to,
            dwell,
            reason: reason || '',
            n: 1,
            lastT: round(time, 3),
            dwellSum: dwell,
            maxDwell: dwell,
            _key: key,
        };
        this._push(this.stateRows, row, 'states');
        if (recent) {
            recent.push(row);
            if (recent.length > STATE_CYCLE_DEPTH) recent.shift();
        }
    }

    // --------------------------------------------------------
    // CAPTURE — EVENTS AND SERIES
    // --------------------------------------------------------

    _event(world, kind, id, otherId, x, y, amount, factionHint, detail) {
        if (!this.streams.events) return;
        const subject = id ? world.byId.get(id) : null;
        // Events are world facts, not ship facts, so the ship filters
        // apply only when the event actually has a ship to filter on.
        if (subject && subject.def && !this._wanted(subject)) return;

        // Collapse a continuing condition into the row that opened it.
        // Keyed per subject rather than "was it the previous row",
        // because two miners unloading at once interleave and a
        // previous-row check would collapse neither.
        if (COALESCE.has(kind)) {
            // Everything that identifies the row except where and when,
            // so only rows that are otherwise identical ever merge.
            const key = kind + ':' + id + ':' + (otherId || 0) + ':' + (detail || '');
            const open = this._open.get(key);
            if (open && world.tick - open._tick <= COALESCE_GAP) {
                open.n++;
                open._tick = world.tick;
                open.dur = round(world.time - open._t0, 2);
                if (typeof amount === 'number') open.amount = round(open.amount + amount, 3);
                open.x = round(x, 1);
                open.y = round(y, 1);
                return;
            }
        }

        const other = otherId ? world.byId.get(otherId) : null;
        const row = {
            tick: world.tick,
            t: round(world.time, 3),
            event: kind,
            id: id || 0,
            type: subject ? (subject.type || '') : '',
            role: subject ? (subject.role || '') : '',
            faction: subject && subject.factionId !== undefined
                ? subject.factionId
                : (factionHint === undefined ? '' : factionHint),
            otherId: otherId || 0,
            otherRole: other ? (other.role || '') : '',
            otherFaction: other && other.factionId !== undefined ? other.factionId : '',
            x: round(x, 1), y: round(y, 1),
            amount: typeof amount === 'number' ? round(amount, 3) : '',
            n: 1,
            dur: 0,
            detail: detail || '',
            _t0: world.time,
            _tick: world.tick,
        };
        this._push(this.eventRows, row, 'events');

        if (COALESCE.has(kind)) {
            // Unbounded ids mean an unbounded map. A run long enough to
            // fill it has long since stopped caring about the oldest
            // entries, and dropping them costs one uncollapsed row.
            if (this._open.size > 4096) this._open.clear();
            this._open.set(kind + ':' + id + ':' + (otherId || 0) + ':' + (detail || ''), row);
        }
    }

    _series(world) {
        const row = {
            tick: world.tick,
            t: round(world.time, 2),
            stepMs: round(world.lastStepMs ?? (this.lastStepMs ?? 0), 3),
            ships: world.ships.length,
            rocks: world.asteroids.length,
            shots: world.projectiles.length,
            fx: world.particles.length,
            fieldOre: round(world.fields.reduce((s, f) => s + f.ore, 0), 1),
            oreExtracted: round(world.oreExtracted, 2),
            oreLost: round(world.oreLost, 2),
            oreInTransit: round(world.ships.reduce((s, sh) => s + sh.cargo, 0), 2),
            hash: world.hash(),
        };
        // Widened per faction. The CSV header is fixed at two because
        // the roster is two; a third faction adds a column pair here
        // and in SERIES_COLUMNS, and nothing else notices.
        for (let i = 0; i < world.factions.length; i++) {
            const f = world.factions[i];
            row['f' + i + '_metal'] = round(f.metal, 1);
            row['f' + i + '_miner'] = f.counts.miner || 0;
            // Drones are the most numerous thing in the world and were
            // the one class the HUD never counted, so they were the one
            // class nothing counted.
            row['f' + i + '_drone'] = f.counts.drone || 0;
            row['f' + i + '_fighter'] = f.counts.fighter || 0;
            row['f' + i + '_built'] = f.builtTotal;
            row['f' + i + '_lost'] = f.lostTotal;
        }
        this._push(this.seriesRows, row, 'series');
    }

    // --------------------------------------------------------
    // INVARIANTS
    // --------------------------------------------------------
    //
    // The test suite asserts end states. A run that misbehaves for
    // forty seconds at minute three and recovers passes every one of
    // them. This is the continuous version: cheap predicates, scanned
    // on an interval, each recorded the first time it fires with the
    // tick it fired on — so "it looked wrong for a bit" becomes a
    // timestamp and an entity id.

    _check(world) {
        // Recorded once per key, but counted every time. A fault that
        // recurs is a different animal from one that happened, and a
        // plain de-duplicated list cannot tell you which you have.
        const flag = (key, what, id, detail) => {
            const seen = this._seen.get(key);
            if (seen) { seen.count++; seen.lastT = round(world.time, 2); return; }
            if (this.anomalies.length >= 500) return;
            const row = {
                t: round(world.time, 2), what, id, detail, count: 1, lastT: round(world.time, 2),
            };
            this._seen.set(key, row);
            this.anomalies.push(row);
        };

        for (const s of world.ships) {
            if (s.dead || !this._wanted(s)) continue;

            if (s.quarantined) {
                flag('quarantine:' + s.id, 'ship quarantined', s.id,
                    `${s.type} ${s.role} threw: ${s.quarantineError}`);
            }

            for (const k of ['x', 'y', 'vx', 'vy', 'angle', 'hp']) {
                if (!Number.isFinite(s[k])) flag('nan:' + s.id + k, 'non-finite ' + k, s.id, s.type);
            }
            if (s.x < -200 || s.y < -200 || s.x > world.width + 200 || s.y > world.height + 200) {
                flag('oob:' + s.id, 'left the world', s.id, `${s.type} at ${s.x | 0},${s.y | 0}`);
            }
            if (s.cargo < -1e-6 || s.cargo > s.cargoMax + 1e-6) {
                flag('cargo:' + s.id, 'cargo out of range', s.id, `${round(s.cargo, 2)}/${s.cargoMax}`);
            }
            // A state nothing ever leaves is the signature of every
            // behavioural deadlock this project has had.
            if (s.stateTime > STUCK_SECONDS && s.role !== 'mothership'
                && !LOITER_STATES.has(s.state)) {
                flag('stuck:' + s.id + ':' + s.state, 'stuck in state', s.id,
                    `${s.role} in '${s.state}' for ${s.stateTime | 0}s`);
            }
            // The tether is the whole reason a miner is a place. A drone
            // outside it is either lost or being led away rock by rock.
            if (s.role === 'drone' && (s.state === 'to_rock' || s.state === 'mine')) {
                const parent = world.byId.get(s.parentId);
                if (parent && !parent.dead) {
                    const d = Math.hypot(s.x - parent.x, s.y - parent.y);
                    if (d > MINING_RADIUS * 1.6) {
                        flag('tether:' + s.id, 'drone off its tether', s.id, `${d | 0}u from parent`);
                    }
                }
            }
        }

        for (const f of world.fields) {
            for (let i = 0; i < f.claimedBy.length; i++) {
                const id = f.claimedBy[i];
                if (!id) continue;
                const holder = world.byId.get(id);
                if (!holder || holder.dead) {
                    flag('claim:' + f.id + ':' + id, 'field claimed by a dead miner', f.id, 'faction ' + i);
                } else if (holder.factionId !== i) {
                    flag('claimslot:' + f.id + ':' + id, 'claim in the wrong faction slot', f.id,
                        `${holder.factionId} in slot ${i}`);
                }
            }
        }

        for (const r of world.asteroids) {
            if (r.ore < -1e-6 || r.ore > r.oreMax + 1e-6) {
                flag('rock:' + r.id, 'rock ore out of range', r.id, `${round(r.ore, 2)}/${round(r.oreMax, 2)}`);
            }
        }

        // Cross-references that should never point where they point.
        // Each of these is a class of bug that keeps running: a ship
        // aiming at a friend simply never fires, and a drone adopted by
        // the wrong faction quietly mines for the enemy.
        for (const s of world.ships) {
            if (s.dead || !this._wanted(s)) continue;
            const target = s.targetId && world.byId.get(s.targetId);
            if (target && !target.dead && target.factionId === s.factionId) {
                flag('friendly:' + s.id, 'targeting a friendly', s.id, s.role);
            }
            const parent = s.parentId && world.byId.get(s.parentId);
            if (parent && !parent.dead && parent.factionId !== s.factionId) {
                flag('adopted:' + s.id, 'parented across factions', s.id, s.role);
            }
        }
    }

    // --------------------------------------------------------

    _wanted(s) {
        if (this.watchIds && !this.watchIds.has(s.id)) return false;
        if (this.roles && !this.roles.has(s.role)) return false;
        if (this.types && !this.types.has(s.type)) return false;
        if (this.factionId !== null && s.factionId !== this.factionId) return false;
        return true;
    }

    _push(buffer, row, kind) {
        // Trim in blocks, never one at a time.
        //
        // `shift()` per insert is the obvious way to bound a buffer
        // and it is quadratic: every drop re-indexes the whole array,
        // so a busy run does tens of billions of moves and the tab
        // stops responding. Found exactly that way — the recorder
        // hung the browser on a three-minute capture while the
        // headless tests, which record far less, never noticed.
        //
        // Dropping a tenth at a time makes it amortised O(1) at the
        // cost of the buffer holding 90–100% of `max` rather than
        // exactly `max`, which no caller cares about.
        if (buffer.length >= this.max) {
            const drop = Math.max(1, Math.floor(this.max * 0.1));
            buffer.splice(0, drop);
            this._dropped[kind] += drop;
            // Anything folding into a dropped row must start a new one,
            // or the counts keep accumulating into a row that is no
            // longer in the buffer.
            if (kind === 'events') this._open.clear();
            if (kind === 'states') this._recent.clear();
        }
        buffer.push(row);
    }

    // --------------------------------------------------------
    // READING IT BACK
    // --------------------------------------------------------

    /** The last `n` motion rows, as a console table. */
    table(n = 30, columns = null) {
        return show(this.rows.slice(-n), columns);
    }

    /** The last `n` behaviour transitions. */
    states(n = 30) { return show(this.stateRows.slice(-n)); }

    /** The last `n` simulation events. */
    events(n = 30) { return show(this.eventRows.slice(-n)); }

    /** The world scalar series. */
    series(n = 30) { return show(this.seriesRows.slice(-n)); }

    /** One of the four streams, as CSV. */
    csv(kind = 'motion') {
        const { cols, rows } = this._stream(kind);
        const head = cols.join(',');
        const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n');
        return head + '\n' + body + '\n';
    }

    _stream(kind) {
        switch (kind) {
            case 'states': return { cols: STATE_COLUMNS, rows: this.stateRows };
            case 'events': return { cols: EVENT_COLUMNS, rows: this.eventRows };
            case 'series': return { cols: SERIES_COLUMNS, rows: this.seriesRows };
            default: return { cols: COLUMNS, rows: this.rows };
        }
    }

    /**
     * Write a stream out. Under `npm run dev` this POSTs to the dev
     * server's capture sink and lands in `.captures/`; anywhere else
     * it falls back to a download, and headless it just hands back the
     * body for the caller to write — this module never touches a
     * filesystem.
     */
    async save(name = 'telemetry.csv', kind = 'motion') {
        const body = this.csv(kind);
        if (typeof fetch === 'function' && typeof location !== 'undefined') {
            try {
                await fetch('/__shot/' + name, { method: 'POST', body });
                return `.captures/${name}  (${this._stream(kind).rows.length} rows)`;
            } catch { /* fall through to a download */ }
        }
        if (typeof document !== 'undefined') {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
            a.download = name;
            a.click();
            return `downloaded ${name}`;
        }
        return body;
    }

    // --------------------------------------------------------
    // THE MOTION AUDIT
    // --------------------------------------------------------

    /**
     * Per-role flight diagnostics over everything recorded.
     *
     * Each column is a question this project has had to ask about
     * its own flight model at least once, which is why they are
     * here rather than in a scratch file that gets rewritten from
     * memory every time something looks wrong:
     *
     *   flipped     decelerating with the nose past 90° — the ship
     *               is burning its main drive against its own travel
     *               instead of using the bow thruster
     *   noseOff     mean nose-off-flight-path while decelerating.
     *               A ship braking in a straight line should read
     *               near zero; a steady non-zero mean means the
     *               facing rule is saturating somewhere
     *   wobble      the nose crossing its flight path back and forth
     *               while slowing — oscillation rather than a turn
     *   lyingPlume  main plume lit while the ship is slowing down,
     *               i.e. art claiming thrust the physics never made
     */
    flight() {
        const byRole = new Map();
        const last = new Map();

        for (const r of this.rows) {
            const prev = last.get(r.id);
            last.set(r.id, r);
            if (!prev || r.speed < 12) continue;
            // Real deceleration only, beyond what damping alone does.
            if (r.speed >= prev.speed - 0.12) continue;

            let a = byRole.get(r.role);
            if (!a) byRole.set(r.role, a = {
                role: r.role, n: 0, flipped: 0, sumOff: 0, maxOff: 0, wobble: 0, lying: 0,
            });

            const off = Math.abs(r.noseOff);
            a.n++;
            a.sumOff += off;
            a.maxOff = Math.max(a.maxOff, off);
            if (off > 90) a.flipped++;
            if (r.throttle > 0.2) a.lying++;
            if (Math.sign(prev.noseOff) !== Math.sign(r.noseOff)
                && Math.abs(prev.noseOff) > 7 && off > 7) a.wobble++;
        }

        return show([...byRole.values()].map((a) => ({
            role: a.role,
            decelSteps: a.n,
            flipped: pct(a.flipped, a.n),
            noseOff: round(a.sumOff / a.n, 1) + '°',
            worstOff: round(a.maxOff, 0) + '°',
            wobble: pct(a.wobble, a.n),
            lyingPlume: pct(a.lying, a.n),
        })));
    }

    // --------------------------------------------------------
    // THE BEHAVIOUR AUDIT
    // --------------------------------------------------------

    /**
     * Where each role's time actually goes, per state.
     *
     * The one to read first. A miner spending sixty percent of a run
     * in `seek` is a routing problem; a drone entering `to_rock`
     * forty times a minute with a mean dwell under a second is
     * thrashing between rocks. Both look, on screen, like ships
     * flying around busily.
     *
     *   share    fraction of that role's recorded state-time
     *   entries  how many times the state was entered
     *   mean     mean dwell, seconds
     *   max      longest single visit — the stuck detector's raw form
     */
    behaviour() {
        const agg = new Map();
        const total = new Map();

        // Takes an already-aggregated visit, because a state row may
        // stand for a folded burst — see STATE_BURST_GAP. A row with
        // n=1 passes its own dwell through unchanged, so the figures
        // are identical whether or not anything folded.
        const add = (role, state, dwellSum, visits, longest) => {
            if (!state || state === '-') return;
            const key = role + ' ' + state;
            let a = agg.get(key);
            if (!a) agg.set(key, a = { role, state, n: 0, sum: 0, max: 0 });
            a.n += visits;
            a.sum += dwellSum;
            a.max = Math.max(a.max, longest);
            total.set(role, (total.get(role) || 0) + dwellSum);
        };

        // A transition row records the state being *left*, so a stream
        // of them describes only the visits that ended. Read alone it
        // silently omits every ship's current state — and the longer a
        // state lasts the likelier it is to be somebody's current one,
        // so the omission lands hardest on exactly the states worth
        // knowing about. The first sweep reported the mothership as
        // spending its whole life in `idle`, on the strength of two
        // closed visits, while it had in fact been sitting in
        // `building` for ten minutes.
        for (const r of this.stateRows) add(r.role, r.from, r.dwellSum, r.n, r.maxDwell);
        const world = this._world;
        if (world) {
            for (const s of world.ships) {
                if (!s.dead && this._wanted(s)) add(s.role, s.state, s.stateTime, 1, s.stateTime);
            }
        }

        const out = [...agg.values()]
            .sort((a, b) => (a.role === b.role ? b.sum - a.sum : a.role < b.role ? -1 : 1))
            .map((a) => ({
                role: a.role,
                state: a.state,
                share: pct(a.sum, total.get(a.role) || 0),
                entries: a.n,
                mean: round(a.sum / a.n, 2) + 's',
                max: round(a.max, 1) + 's',
            }));
        return show(out);
    }

    /**
     * Why states ended, for the transitions that carry a reason.
     * Blank reasons are folded into one row rather than hidden, so an
     * unlabelled transition is visible as a gap to fill.
     */
    reasons() {
        const agg = new Map();
        for (const r of this.stateRows) {
            const key = r.role + ' ' + r.from + '→' + r.to + ' ' + (r.reason || '(unlabelled)');
            agg.set(key, (agg.get(key) || 0) + r.n);
        }
        return show([...agg.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([transition, count]) => ({ transition, count })));
    }

    // --------------------------------------------------------
    // THE ECONOMY AND COMBAT AUDIT
    // --------------------------------------------------------

    /**
     * Throughput and marksmanship, from the event stream.
     *
     *   trips / ore       deliveries, and what they carried. One
     *                     collapsed deposit row *is* one delivery, so
     *                     `perTrip` is measured rather than inferred
     *   cycle             mean seconds between one miner's deliveries
     *                     — the round trip, which is the number every
     *                     mining tuning change is really aiming at
     *   accuracy          hits over shots that resolved. The tell for
     *                     whether the intercept solve is earning its
     *                     keep, and impossible to judge by eye
     *
     * The first version of this guessed at trips by looking for gaps
     * of more than four seconds between deposit events, because
     * deposits arrived per step. Collapsing the stream removed both
     * the noise and the guess at once.
     */
    economy() {
        const perFaction = new Map();
        const lastDelivery = new Map();
        const cycle = new Map();

        const bucket = (f) => {
            let a = perFaction.get(f);
            if (!a) perFaction.set(f, a = {
                faction: f, trips: 0, ore: 0, shots: 0, hits: 0, misses: 0,
                kills: 0, losses: 0, built: 0, blocked: '', claims: 0,
            });
            return a;
        };

        for (const r of this.eventRows) {
            const f = r.faction === '' ? -1 : r.faction;
            const a = bucket(f);
            switch (r.event) {
                case 'deposit': {
                    a.trips++;
                    a.ore += r.amount || 0;
                    const prev = lastDelivery.get(r.id);
                    if (prev !== undefined) {
                        let c = cycle.get(f);
                        if (!c) cycle.set(f, c = { sum: 0, n: 0 });
                        c.sum += r.t - prev;
                        c.n++;
                    }
                    lastDelivery.set(r.id, r.t);
                    break;
                }
                case 'shot': a.shots++; break;
                case 'hit': a.hits++; break;
                case 'miss': a.misses++; break;
                case 'build': a.built++; break;
                case 'claim': a.claims++; break;
                // The last thing production said about itself. A
                // treasury alone cannot tell a faction that is saving
                // up from one that has everything it wants.
                case 'blocked': a.blocked = r.detail; break;
                case 'kill': {
                    a.losses++;                       // the faction that lost the hull
                    if (r.otherFaction !== '') bucket(r.otherFaction).kills++;
                    break;
                }
            }
        }

        return show([...perFaction.values()]
            .filter((a) => a.faction >= 0)
            .sort((a, b) => a.faction - b.faction)
            .map((a) => ({
                faction: a.faction,
                trips: a.trips,
                ore: round(a.ore, 1),
                perTrip: a.trips ? round(a.ore / a.trips, 1) : 0,
                cycle: cycle.get(a.faction)
                    ? round(cycle.get(a.faction).sum / cycle.get(a.faction).n, 1) + 's' : '—',
                claims: a.claims,
                shots: a.shots,
                accuracy: a.hits + a.misses > 0 ? pct(a.hits, a.hits + a.misses) : '—',
                kills: a.kills,
                losses: a.losses,
                built: a.built,
                stalledOn: a.blocked || '—',
            })));
    }

    // --------------------------------------------------------
    // THE TIME AXIS
    // --------------------------------------------------------

    /**
     * The world scalars, rolled into buckets.
     *
     * Every other audit here answers "what happened over the run",
     * which is the wrong tense for half the questions worth asking.
     * Whether one faction pulls ahead is not interesting; *when* it
     * becomes irreversible is. The series stream has had that answer
     * from the start and nothing was reading it.
     *
     * `lead` is the treasury split as a signed fraction: 0 is even,
     * +1 is faction 0 holding everything.
     */
    timeline(bucketSeconds = 60) {
        const out = [];
        let bucket = null;

        for (const r of this.seriesRows) {
            const at = Math.floor(r.t / bucketSeconds) * bucketSeconds;
            if (!bucket || bucket._at !== at) {
                out.push(bucket = { _at: at, at: '', _n: 0 });
            }
            bucket._n++;
            // Last value wins for levels, which is what a snapshot is —
            // and the label is the sample it was actually taken at, not
            // the bucket boundary, so a short final bucket says so.
            bucket.at = Math.round(r.t) + 's';
            bucket.ships = r.ships;
            bucket.ore = Math.round(r.oreExtracted);
            bucket.inTransit = Math.round(r.oreInTransit);
            bucket.f0 = Math.round(r.f0_metal);
            bucket.f1 = Math.round(r.f1_metal);
            bucket.fleet = `${r.f0_miner}m ${r.f0_fighter}f / ${r.f1_miner}m ${r.f1_fighter}f`;
            const total = r.f0_metal + r.f1_metal;
            bucket.lead = total > 0 ? round((r.f0_metal - r.f1_metal) / total, 2) : 0;
        }
        return show(out);
    }

    // --------------------------------------------------------
    // LIFECYCLE
    // --------------------------------------------------------

    /**
     * How long hulls live, and what ends them.
     *
     * Spawns and kills have both been in the event stream from the
     * start, carrying ids, and nothing joined them — so "we built 59
     * and lost 32" was as close as the report could get to the
     * question actually being asked, which is whether a fighter is
     * worth building.
     *
     * `neverFired` is the one to watch: a warship that dies without
     * ever shooting is a production decision that bought nothing.
     */
    lifecycle(endTime) {
        const born = new Map();
        const fired = new Set();
        const end = endTime ?? (this._world ? this._world.time : 0);
        const agg = new Map();

        // Which roles carry a gun at all, learned from the log rather
        // than from the ship table — a miner that "never fired" is a
        // miner, not a finding, and a column that says so of every
        // unarmed hull is a column you stop reading.
        const armed = new Set();

        for (const r of this.eventRows) {
            if (r.event === 'spawn') born.set(r.id, r);
            else if (r.event === 'shot' || r.event === 'hit') { fired.add(r.id); armed.add(r.role); }
            else if (r.event === 'kill') {
                const b = born.get(r.id);
                add(r.role, b ? r.t - b.t : null, r.otherRole || 'nothing', fired.has(r.id));
                born.delete(r.id);
            }
        }
        // Whatever is still alive at the end is a censored observation,
        // not a missing one — leaving survivors out would make every
        // lifetime an average of the unlucky.
        for (const [, b] of born) add(b.role, end - b.t, 'alive', fired.has(b.id));

        function add(role, life, by, everFired) {
            if (!role) return;
            let a = agg.get(role);
            if (!a) agg.set(role, a = { role, n: 0, sum: 0, max: 0, alive: 0, silent: 0, by: new Map() });
            a.n++;
            if (life !== null) { a.sum += life; a.max = Math.max(a.max, life); }
            if (by === 'alive') a.alive++;
            else {
                a.by.set(by, (a.by.get(by) || 0) + 1);
                if (!everFired) a.silent++;
            }
        }

        return show([...agg.values()].map((a) => ({
            role: a.role,
            hulls: a.n,
            meanLife: round(a.sum / a.n, 1) + 's',
            longest: round(a.max, 0) + 's',
            stillAlive: a.alive,
            killedBy: [...a.by.entries()]
                .filter(([k]) => k !== 'alive')
                .sort((x, y) => y[1] - x[1])
                .map(([k, v]) => `${k}×${v}`).join(' ') || '—',
            neverFired: armed.has(a.role) && a.n - a.alive > 0
                ? pct(a.silent, a.n - a.alive) : '—',
        })));
    }

    // --------------------------------------------------------
    // PER SHIP
    // --------------------------------------------------------

    /**
     * One row per hull, sorted worst-first.
     *
     * Everything else here aggregates by role or faction, which is the
     * right altitude for "is this class behaving" and exactly the
     * wrong one for "which one of them is broken". An average hides a
     * single stuck miner completely, and a single stuck miner is what
     * you are usually chasing.
     *
     * `churn` is transitions per minute of life — the thrash score.
     */
    ships(limit = 20, sortBy = 'churn') {
        const agg = new Map();
        const get = (id, role, faction) => {
            let a = agg.get(id);
            if (!a) agg.set(id, a = {
                id, role: role || '', faction: faction === undefined ? '' : faction,
                born: null, died: null, moves: 0, ore: 0, shots: 0, hits: 0, longest: 0, worstState: '',
            });
            if (role && !a.role) a.role = role;
            return a;
        };

        for (const r of this.stateRows) {
            const a = get(r.id, r.role, r.faction);
            a.moves += r.n;
            if (r.maxDwell > a.longest) { a.longest = r.maxDwell; a.worstState = r.from; }
        }
        for (const r of this.eventRows) {
            if (!r.id) continue;
            const a = get(r.id, r.role, r.faction);
            if (r.event === 'spawn') a.born = r.t;
            else if (r.event === 'kill') a.died = r.t;
            else if (r.event === 'deposit') a.ore += r.amount || 0;
            else if (r.event === 'shot') a.shots += r.n || 1;
            else if (r.event === 'hit') a.hits += r.n || 1;
        }

        const end = this._world ? this._world.time : 0;
        const rows = [...agg.values()].map((a) => {
            const life = Math.max(1, (a.died ?? end) - (a.born ?? 0));
            return {
                id: a.id,
                role: a.role,
                faction: a.faction,
                life: round(life, 0) + 's',
                fate: a.died === null ? 'alive' : 'lost',
                churn: round((a.moves / life) * 60, 1),
                longest: round(a.longest, 1) + 's',
                stuckIn: a.worstState || '—',
                ore: round(a.ore, 1),
                accuracy: a.shots ? pct(a.hits, a.shots) : '—',
                _sort: sortBy === 'churn' ? (a.moves / life) : a.longest,
            };
        });
        rows.sort((x, y) => y._sort - x._sort);
        return show(rows.slice(0, limit));
    }

    // --------------------------------------------------------
    // THE DIAGNOSIS
    // --------------------------------------------------------

    /**
     * The audits, read for you.
     *
     * Six tables of numbers is not the same thing as knowing what is
     * wrong, and the gap between them is where a diagnostic stops
     * being used. Every rule below is a shape that has actually
     * indicated a bug in this project at least once, stated generally
     * enough to catch the next instance rather than the last one.
     *
     * Findings are ranked, and each carries the number it fired on so
     * the claim can be checked rather than believed.
     */
    diagnose() {
        const out = [];
        const say = (severity, what, detail) => out.push({ severity, what, detail });

        const behaviour = quietly(() => this.behaviour());
        const reasons = quietly(() => this.reasons());
        const economy = quietly(() => this.economy());
        const lifecycle = quietly(() => this.lifecycle());

        // A state entered and never left. The mothership sat in
        // `building` for an entire ten-minute run this way, and both
        // the debug overlay and every occupancy figure agreed with it.
        const closed = new Set(this.stateRows.map((r) => r.role + ':' + r.from));
        for (const b of behaviour) {
            const secs = parseFloat(b.max);
            const key = b.role + ':' + b.state;
            // A loiter state that never ends is a quiet map, not a bug.
            if (LOITER_STATES.has(b.state)) continue;
            if (!closed.has(key) && secs > 60) {
                say(1, 'never leaves a state', `${b.role} enters '${b.state}' and stays — ${b.max}`);
            }
        }

        for (const b of behaviour) {
            const secs = parseFloat(b.max);
            const mean = parseFloat(b.mean);
            if (LOITER_STATES.has(b.state)) continue;
            // A long tail against a short mean is an intermittent
            // stall: it usually works, and sometimes it does not, which
            // is the hardest thing to catch by watching.
            if (secs > STUCK_SECONDS && mean > 0 && secs > mean * 8) {
                say(1, 'intermittent stall',
                    `${b.role} '${b.state}' usually ${b.mean}, worst ${b.max}`);
            }
            // Sub-half-second visits, hundreds of times over. The ship
            // is deciding, not doing — unless the brevity is the design,
            // as it is for each leg of a fly-by, or for a transfer whose
            // ceiling is a cargo divided by a rate.
            const key = b.role + ':' + b.state;
            if (mean < 0.5 && b.entries > 100 && !CYCLE_STATES.has(key) && !BRIEF_STATES.has(key)) {
                say(2, 'thrashing', `${b.role} enters '${b.state}' ${b.entries}× at ${b.mean} each`);
            }
        }

        // Two states trading places. Generic, so it catches the next
        // pair rather than the one that prompted it — which was
        // fighters acquiring a target and dropping it off-leash.
        const counts = new Map();
        for (const r of reasons) {
            const m = /^(\S+) (\S+)→(\S+) /.exec(r.transition);
            if (m) counts.set(m[1] + ':' + m[2] + '>' + m[3], (counts.get(m[1] + ':' + m[2] + '>' + m[3]) || 0) + r.count);
        }
        for (const [key, n] of counts) {
            const [role, pair] = key.split(':');
            const [a, b] = pair.split('>');
            const backKey = role + ':' + b + '>' + a;
            const back = counts.get(backKey) || 0;
            if (n > 200 && back > n * 0.7 && a < b && !DESIGNED_CYCLES.has(role + ':' + a + '>' + b)) {
                say(1, 'ping-pong', `${role} ${a}⇄${b} — ${n} out, ${back} straight back`);
            }
        }

        for (const e of economy) {
            const acc = parseFloat(e.accuracy);
            if (e.shots > 50 && acc < 45) {
                say(2, 'poor accuracy', `faction ${e.faction} hits ${e.accuracy} of ${e.shots} shots`);
            }
            // `policy-satisfied` means the faction has everything the
            // policy asks for, which is production working rather than
            // production stalling. Reporting it made the healthy case
            // indistinguishable from the broke one on every run.
            if (e.stalledOn !== '—' && e.stalledOn && e.stalledOn !== 'policy-satisfied') {
                say(3, 'production stalled', `faction ${e.faction} last blocked: ${e.stalledOn}`);
            }
            // A miner claims a field and works it for half a minute, so
            // claims should be rare. Thousands of them means claims are
            // being taken and lost rather than held — on screen that is
            // ordinary-looking traffic.
            if (e.trips > 0 && e.claims > e.trips * 20) {
                say(2, 'claim churn',
                    `faction ${e.faction} re-claimed ${e.claims}× for ${e.trips} deliveries`);
            }
        }

        for (const l of lifecycle) {
            const silent = parseFloat(l.neverFired);
            if (l.role === 'fighter' && silent > 30) {
                say(2, 'warships die unused', `${l.neverFired} of lost fighters never fired`);
            }
        }

        // The economy's own leak, as a fraction rather than a count.
        const world = this._world;
        if (world && world.oreExtracted > 0) {
            const leak = world.oreLost / world.oreExtracted;
            if (leak > 0.03) {
                say(2, 'cargo destroyed in transit',
                    `${(leak * 100).toFixed(1)}% of everything mined died in a hold`);
            }
            const metal = world.factions.map((f) => f.metal);
            const total = metal.reduce((s, v) => s + v, 0);
            if (total > 100) {
                const spread = Math.abs(metal[0] - metal[1]) / total;
                if (spread > 0.6) {
                    say(2, 'runaway leader',
                        `treasuries split ${(spread * 100).toFixed(0)}% at ${round(world.time, 0)}s`);
                }
            }
        }

        for (const a of this.anomalies) {
            const when = a.count > 1 ? `${a.t}s→${a.lastT}s ×${a.count}` : `at ${a.t}s`;
            say(1, a.what, `${a.detail || 'id ' + a.id} — ${when}`);
        }

        if (this.seriesRows.length >= 10) {
            const validRows = this.seriesRows.filter((r) => typeof r.stepMs === 'number' && r.stepMs > 0);
            if (validRows.length >= 10) {
                const quarter = Math.floor(validRows.length / 4);
                const early = validRows.slice(0, quarter);
                const late = validRows.slice(-quarter);
                const earlyMean = early.reduce((s, r) => s + r.stepMs, 0) / early.length;
                const lateMean = late.reduce((s, r) => s + r.stepMs, 0) / late.length;

                // Fire when late run step time is > 2.0x early run AND exceeds noise floor (1.0ms)
                if (earlyMean > 0.05 && lateMean > earlyMean * 2.0 && lateMean > 1.0) {
                    const growth = Math.round(((lateMean - earlyMean) / earlyMean) * 100);
                    const severity = lateMean > earlyMean * 3.0 ? 1 : 2;
                    say(severity, 'step time degradation',
                        `step duration grew from ${earlyMean.toFixed(2)}ms to ${lateMean.toFixed(2)}ms (+${growth}%) over the run`);
                }
            }
        }

        // A filtered recording makes some of the above meaningless
        // rather than merely narrow, so it says so instead of quietly
        // reporting zero shots for a miners-only capture.
        const scope = this.scope();
        if (scope) {
            say(3, 'recording was filtered',
                `only ${scope} was captured — figures about anything else are partial`);
        }
        // The same courtesy for a stream that was switched off. A run
        // with `events` off reports no kills at all, which reads as a
        // peaceful ten minutes rather than as a missing stream. One
        // finding naming all of them, because the report merges
        // findings by name and several would collapse into the first.
        const off = STREAMS.filter((s) => !this.streams[s]);
        if (off.length) {
            say(3, 'streams switched off', `nothing recorded for: ${off.join(', ')}`);
        }
        for (const kind of Object.keys(this._dropped)) {
            if (this._dropped[kind] > 0) {
                say(2, 'log truncated',
                    `${this._dropped[kind]} ${kind} rows dropped — that audit is missing its start`);
            }
        }

        out.sort((a, b) => a.severity - b.severity);
        return show(out.map((r) => ({
            level: ['', 'high', 'medium', 'note'][r.severity],
            what: r.what,
            detail: r.detail,
        })));
    }

    /** What is on, what is in the buffers, and what has been lost from them. */
    status() {
        const size = (n, kind) => (this.streams[kind]
            ? n + dropNote(this._dropped[kind])
            : 'off');
        return {
            enabled: this.enabled,
            motion: size(this.rows.length, 'motion'),
            states: size(this.stateRows.length, 'states'),
            events: size(this.eventRows.length, 'events'),
            series: size(this.seriesRows.length, 'series'),
            checks: this.streams.checks ? this.anomalies.length + ' anomalies' : 'off',
            every: this.every,
            scope: this.scope() || 'everything',
        };
    }
}

const idOf = (v) => (v && typeof v === 'object' ? v.id : v) | 0;

/**
 * A filter axis as a Set, or null for "no restriction".
 *
 * Accepts a single value, an array, or a comma list, so the same
 * function serves `only('miner')`, `only(['a','b'])` and a URL's
 * `?role=miner,drone`. Zero and empty string mean "unset" rather than
 * "match nothing", because `watch(0)` has always meant every ship.
 */
function toSet(v, map) {
    if (v === null || v === undefined || v === '' || v === 0) return null;
    const list = Array.isArray(v) ? v
        // A bare object is a ship, not something to split on commas.
        : typeof v === 'object' ? [v]
            : String(v).split(/[,\s]+/).filter(Boolean);
    const out = new Set(list.map((x) => (map ? map(x) : x)));
    return out.size ? out : null;
}
const deg = (r) => (r * 180) / Math.PI;
const round = (v, dp) => {
    const k = 10 ** dp;
    return Math.round(v * k) / k;
};
const pct = (n, total) => (total ? ((n / total) * 100).toFixed(1) : '0.0') + '%';
/** A buffer that has dropped rows says so wherever its size is quoted. */
const dropNote = (n) => (n ? ` (+${n} dropped)` : '');

/**
 * Print if there is a console.table to print with, and hand the rows
 * back either way.
 *
 * Underscore-prefixed keys are working state — sort keys, bucket
 * boundaries, coalescing cursors — and are stripped on the way out.
 * They are how a row remembers what it is doing; they are not part of
 * what it has to say, and a table showing both is a table nobody
 * reads twice.
 */
function show(rows, columns) {
    const clean = rows.map((r) => {
        let hidden = false;
        for (const k in r) if (k[0] === '_') { hidden = true; break; }
        if (!hidden) return r;
        const out = {};
        for (const k in r) if (k[0] !== '_') out[k] = r[k];
        return out;
    });
    if (!QUIET && typeof console.table === 'function') {
        let display = clean.slice(0, TABLE_LIMIT);
        if (clean.length > TABLE_LIMIT) {
            // The overflow note goes *in* the table rather than beside
            // it, so that muting `console.table` mutes the whole audit.
            // A note printed through `console.log` escapes the mute and
            // turns up in the middle of somebody else's report.
            const first = Object.keys(clean[0])[0];
            display = display.concat([{ [first]: `… ${clean.length - TABLE_LIMIT} more` }]);
        }
        console.table(display, columns || undefined);
    }
    return clean;
}

/** Run an audit without letting it print. Audits that call audits use this. */
function quietly(fn) {
    const was = QUIET;
    QUIET = true;
    try { return fn(); } finally { QUIET = was; }
}

/** Quote a cell only when it needs it. State names and reasons are bare words today; they may not stay that way. */
function csvCell(v) {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** The one recorder. Shared by the sim, the page and the tests. */
export const telemetry = new Telemetry();
