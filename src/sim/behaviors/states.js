// ============================================================
// BEHAVIOURS — THE STATE VOCABULARY
// ============================================================
//
// Every state name every behaviour can be in, in one table, with no
// imports of its own so nothing can cycle through it.
//
// It exists because state machines read each other. A drone only
// leaves its berth while its miner is *working*; a miner only sets
// sail once none of its drones are still *out*. Both of those were
// written as bare string comparisons against another module's
// private constants — `parent.state === 'work'` in drone.js,
// `s.state === 'to_rock' || s.state === 'mine'` in miner.js — which
// is a coupling that no rename can survive and no test can see. The
// day someone renames `work` to `mining`, drones stop leaving their
// berths, nothing throws, and the economy quietly halves.
//
// So the names live here and the questions live with whoever owns
// the answer: `minerIsWorking` is exported by miner.js, `droneIsOut`
// by drone.js. A behaviour asks another behaviour a question rather
// than reading its state string.
//
// `core/telemetry.js` also names states — LOITER_STATES and
// DESIGNED_CYCLES — and deliberately does *not* import this file:
// `core/` may not reach into `sim/`. `tests/guards.test.js` checks
// those lists against this table instead, so a renamed state fails a
// test rather than silently switching off a watchdog exemption.

/** Drifting cargo. It has one state because it does one thing: expire. */
export const WRECK = Object.freeze({
    DRIFTING: 'drifting',
    /**
     * The last couple of seconds, while it thins out and the ore in it
     * goes for good. A real phase rather than a state invented to
     * satisfy a guard — it is visibly different on screen, and it is
     * the window in which a hauler already on its way has lost.
     */
    FADING: 'fading',
});

/** A forward store. It holds ore and shoots; that is the whole machine. */
export const OUTPOST = Object.freeze({
    HOLDING: 'holding',
    /**
     * Taking fire, or with something hostile inside its reach.
     *
     * A shed with one state would be a state machine that can never
     * leave the state it is in, which `tests/sim.test.js` correctly
     * flags as a dead end. It is also information worth having: a
     * faction's forward store being *attacked* is the single most
     * consequential thing that can happen to its economy, and until
     * this existed it was visible only as the hull bar going down.
     */
    ALERT: 'alert',
});

/** Moves ore in bulk from a forward store to the station. */
export const HAULER = Object.freeze({
    IDLE: 'idle',
    TO_OUTPOST: 'to_outpost',
    LOAD: 'load',
    /**
     * The caravan: a run to the neutral market and back, staked with
     * metal the faction already had.
     *
     * A separate errand rather than a stop on the way home, because
     * the market is simply not on the way — measured at a median 4.17x
     * detour. The hull crosses empty and comes back laden.
     */
    TO_HUB: 'to_hub',
    TRADE: 'trade',
    TO_BASE: 'to_base',
    DELIVER: 'deliver',
});

/**
 * The neutral market. It has two states because it does two things:
 * wait, and serve somebody.
 *
 * TRADING is not decoration — it is the only outward sign that the
 * hub is *for* something, and it is what the renderer lights the
 * banner from. A structure that never changes state is a structure a
 * viewer reads as scenery.
 */
export const EXCHANGE = Object.freeze({
    OPEN: 'open',
    TRADING: 'trading',
});

/**
 * The yard. Same two states as a station and for the same reason —
 * its whole agency is choosing what to build — but its own vocabulary
 * rather than a shared one, because the two answer to different
 * policies and a renamed station state must not silently change what
 * a factory does.
 */
export const FACTORY = Object.freeze({
    IDLE: 'idle',
    BUILDING: 'building',
});

/** Static. Its whole agency is choosing what to build. */
export const MOTHERSHIP = Object.freeze({
    IDLE: 'idle',
    BUILDING: 'building',
});

/** Carries drones to ore and hauls the load home. */
export const MINER = Object.freeze({
    SEEK: 'seek',
    WORK: 'work',
    RETURN: 'return',
    DEPOSIT: 'deposit',
    FLEE: 'flee',
});

/** The workforce. Tethered to its parent miner. */
export const DRONE = Object.freeze({
    TO_ROCK: 'to_rock',
    MINE: 'mine',
    TO_PARENT: 'to_parent',
    UNLOAD: 'unload',
    STOWED: 'stowed',
    ORPHAN: 'orphan',
});

/** The escort. Flies passes rather than holding a standoff. */
export const FIGHTER = Object.freeze({
    /**
     * Waiting at the station for the rest of the wing.
     *
     * The state a hull is born into, and the only one whose exit is
     * decided by the *faction* rather than by the hull. See the long
     * note in behaviors/fighter.js.
     */
    MUSTER: 'muster',
    PATROL: 'patrol',
    /**
     * A picket or outrider gone to look at something, and on its way
     * back. Distinct from PURSUE because it is not committed: nothing
     * has been engaged yet, and the hull returns to its station rather
     * than pressing an attack.
     */
    SCOUT: 'scout',
    PURSUE: 'pursue',
    ENGAGE: 'engage',
    EXTEND: 'extend',
    REGROUP: 'regroup',
});

/**
 * Set by `simulate.js` when a behaviour throws, not by any state
 * machine. Listed because it is a state a ship can be found in, and
 * anything reading states needs to know it exists.
 */
export const QUARANTINED = 'quarantined';

/** Every state name in the project, by role. */
export const STATES = Object.freeze({
    mothership: Object.freeze(Object.values(MOTHERSHIP)),
    factory: Object.freeze(Object.values(FACTORY)),
    miner: Object.freeze(Object.values(MINER)),
    drone: Object.freeze(Object.values(DRONE)),
    fighter: Object.freeze(Object.values(FIGHTER)),
    outpost: Object.freeze(Object.values(OUTPOST)),
    hauler: Object.freeze(Object.values(HAULER)),
    exchange: Object.freeze(Object.values(EXCHANGE)),
    wreck: Object.freeze(Object.values(WRECK)),
});

/**
 * The reason a state machine's *first* transition carries.
 *
 * Every other transition in the project explains itself and this one
 * did not, so a ten-minute run contained a hundred-odd rows reading
 * `fighter -→patrol (none)`. A trace with a blank in it invites the
 * reader to assume the blank is nothing; it is a spawn.
 */
export const SPAWNED = 'spawned';
