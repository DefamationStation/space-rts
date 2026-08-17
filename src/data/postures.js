// ============================================================
// POSTURES — THE VOCABULARY
// ============================================================
//
// What a faction can be trying to do. The *rules* that decide which
// one applies live in `sim/posture.js`; this is only the list of
// names, and it is data for the same reason `SHIP_TYPES` is data —
// it says what a thing is, not what it does.
//
// It is a separate file from the classifier so that `data/` never has
// to import from `sim/`. `data/factions.js` needs a starting posture
// and `data/production.js` gates its rules on posture, so both need
// the names; neither should have to pull in the simulation to get
// them, and a data module reaching into sim is how import cycles
// start.
//
// The same discipline as `sim/behaviors/states.js`: names live in one
// place, so a rename is a rename rather than a silent behavioural
// change in whichever module still holds the old string.

export const POSTURE = Object.freeze({
    /**
     * Economy gone — no miners at all. Warships and the home field
     * until there is one again. First in the ordering because a
     * faction with nothing to defend is not defending.
     */
    REBUILD: 'rebuild',

    /** Enemies in the yard, or the station taking fire. Everything comes home. */
    DEFEND: 'defend',

    /**
     * Decisive advantage. Commit the fleet to the enemy's station.
     *
     * The expensive posture, and the one that makes a lead cost
     * something: a besieging fleet is a long way from the miners it
     * has stopped escorting.
     */
    SIEGE: 'siege',

    /** Ahead. Push out and hunt what feeds them. */
    RAID: 'raid',

    /** The default, and where a healthy run spends most of its time. */
    EXPAND: 'expand',
});

/** Every posture name, for the guards test and the recorder. */
export const POSTURES = Object.freeze(Object.values(POSTURE));
