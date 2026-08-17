// ============================================================
// FACTIONS
// ============================================================
//
// Two for now. The array index *is* the faction id, and it also
// indexes into `theme.factions`, so the palette and the roster
// stay in step by construction.
//
// Adding a third faction means adding a row here and a matching
// entry to both themes in `data/themes.js`. Nothing else in the
// project counts factions — every loop iterates this array.
// See docs/04-COOKBOOK.md.
//
// Names are descriptive rather than fictional on purpose. A
// faction called something like "The Crimson Dominion" writes a
// tone this project is not going for; naming them after their own
// colour keeps the HUD honest and quiet.

import { POSTURE } from './postures.js';

export const FACTIONS = [
    {
        id: 0,
        name: 'sea-glass',
        /** Fraction of world width where the mothership sits. */
        homeX: 0,
        homeY: 0.5,
    },
    {
        id: 1,
        name: 'warm sand',
        homeX: 1,
        homeY: 0.5,
    },
    {
        // ------------------------------------------------------
        // THE INCURSION
        // ------------------------------------------------------
        //
        // Not a faction so much as weather. It has no station, no
        // economy, no production and no home — it arrives through a
        // rift, and everything it does is `sim/incursion.js`.
        //
        // It sits in this array anyway because *every* loop in the
        // project iterates `world.factions`, and the moment aliens
        // were special-cased in even one of them they would need
        // special-casing in all of them. A faction with `alien: true`
        // and no mothership costs nothing everywhere it is ignored,
        // and is a first-class enemy everywhere it is not.
        //
        // Its whole point is what it does to the other two. See
        // `isHostile` in sim/behaviors/common.js: while an incursion
        // is on the board the natives stop being enemies, and a run
        // that has been two sides shooting each other for ten minutes
        // becomes two fleets standing side by side. That reversal is
        // the most dramatic thing this simulation can do, and it costs
        // one branch in one function because every hostility check in
        // the project was already routed through it.
        id: 2,
        name: 'the swarm',
        alien: true,
        homeX: 0.5,
        homeY: 0.5,
    },
    {
        // ------------------------------------------------------
        // THE EXCHANGE
        // ------------------------------------------------------
        //
        // A third party that does not fight, does not mine, and does
        // not want the map. It runs one station, both sides trade at
        // it, and nobody may shoot inside its bubble.
        //
        // It is a faction for exactly the reason the swarm is one:
        // everything iterates `world.factions`, and a neutral station
        // that was *not* in that array would need special-casing in
        // every loop instead of being ignored by all of them. What it
        // costs is one branch in `isHostile` — placed above the swarm
        // check, so the exchange is safe even from the incursion.
        //
        // `neutral` and `alien` are different claims and both are
        // needed. `alien` means "is the hazard"; `neutral` means "does
        // not play the game" — no station to rebuild, no posture to
        // hold, no fleet to pay for. The swarm is both. See isPlayed().
        id: 3,
        name: 'the exchange',
        /**
         * The name on the sign.
         *
         * Separate from `name` because they answer different
         * questions: `name` is what this faction *is* and appears in
         * the HUD, `banner` is whose station it is and appears in
         * world space, lit, above the entrance. It is one line to
         * change, which is the entire point of it — this is the
         * supporter-facing hook, and it should never require touching
         * a renderer to set.
         *
         * Kept short deliberately. The sign is drawn at the station's
         * own scale, so a long name either shrinks past legibility or
         * grows wider than the structure carrying it.
         */
        banner: 'MERIDIAN',
        neutral: true,
        homeX: 0.5,
        homeY: 0.5,
    },
];

/**
 * Does this faction actually play — earn, build, and hold a strategy?
 *
 * The economy, production, posture and rebuild loops all used to ask
 * `.alien`, which happened to be right while the swarm was the only
 * non-player in the array. It is not the same question: a neutral
 * trader has no station to rebuild and no war to posture for either,
 * and would otherwise have arrived in those loops as a faction with
 * zero of everything and been quietly mistaken for a faction that
 * had *lost* everything.
 */
export function isPlayed(faction) {
    return !faction.alien && !faction.neutral;
}

/** Runtime state per faction. Rebuilt on world creation, never shared. */
export function makeFactionState(def) {
    return {
        id: def.id,
        name: def.name,
        /** True for the incursion — no station, no economy, no posture. */
        alien: !!def.alien,
        /** True for the exchange — a third party nobody is at war with. */
        neutral: !!def.neutral,
        metal: 0,
        motherships: [],   // ship ids
        // Live counts by ship type, refreshed once per step so the
        // production policy does not rescan every ship for every rule.
        counts: Object.create(null),
        // Cumulative totals, for the HUD and for the economy test.
        //
        // These close the conservation ledger. Metal enters the world
        // in exactly two ways — mined ore and the salvage trickle —
        // and leaves in exactly one, so at any instant:
        //
        //   oreExtracted + salvageTotal
        //     === cargo in transit + metal banked + metalSpent
        //
        // tests/sim.test.js asserts it.
        minedTotal: 0,
        salvageTotal: 0,
        metalSpent: 0,
        upkeepPaid: 0,
        builtTotal: 0,
        lostTotal: 0,

        /** World time this faction lost its last station; -1 while it holds one. */
        wipedAt: -1,

        /**
         * World time of the most recent ship lost, and the derived
         * flag the production policy reads. Refreshed once per step
         * in sim/simulate.js.
         */
        lastLossAt: -1e9,
        underThreat: false,

        /**
         * Fleet accounting, refreshed once per step by `census()` in
         * sim/simulate.js and read by the wing rule in
         * behaviors/fighter.js.
         *
         * Measured in **metal cost, not hull count**, and that is the
         * whole design decision. A count says a destroyer and a drone
         * are the same thing; cost is the designer's own statement of
         * what a hull is worth, already written down in
         * `data/ships.js`. So when corvettes, frigates and destroyers
         * arrive, every rule expressed in these three numbers keeps
         * meaning what it meant, with nothing to re-tune and no rule
         * that has to learn a new hull's name.
         *
         * `hostileStrength` sums over *every* faction this one is at
         * war with, via `isHostile`, rather than assuming there are
         * two sides. See the note on that function.
         */
        strength: 0,          // metal-cost of this faction's live armed hulls
        hostileStrength: 0,   // the same, summed over everyone hostile to it
        musterNeed: 0,        // strength a wing must gather before it sorties
        upkeep: 0,            // metal/s this fleet costs to keep, refreshed each step
        /**
         * True while savings are thin against wages — see the census.
         * Production leans on miners and guards while this holds, and
         * the duty roll sends more of what it builds to escort work.
         */
        lean: false,

        /**
         * War footing. `mobilised` is read by the production policy and
         * by upkeep; `barrenSince` is the clock it is derived from —
         * the world time this faction last had a warship, or -1 while
         * it has one.
         */
        mobilised: false,
        barrenSince: -1,

        /**
         * Where this faction is currently losing hulls, and when.
         *
         * The alarm. A home guard that keeps holding its post while
         * the fleet is being cut apart two thousand units away is not
         * guarding anything — it is the reason a faction can lose a
         * battle it had the hulls to win.
         */
        alarmX: 0,
        alarmY: 0,
        alarmAt: -1e9,
        alarmWeight: 0,

        /**
         * What this faction is trying to do, from `sim/posture.js`.
         * Production rules gate on it and fighters anchor by it, so it
         * is the one field that turns a list of hulls into a strategy.
         *
         * `postureSince` is what the dwell is measured against.
         */
        posture: POSTURE.EXPAND,
        postureSince: 0,
        /**
         * Whether a siege has gathered enough of the fleet to set out.
         * False from the moment SIEGE is adopted until enough strength
         * is standing at the station — see SIEGE_RALLY_SHARE.
         */
        siegeReady: false,
        /**
         * When this faction last broke off a siege. Negative until it
         * has mounted one, so an opening assault is never blocked by
         * a cooldown that has not started. See SIEGE_COOLDOWN.
         */
        siegeEndedAt: -1e9,

    };
}
