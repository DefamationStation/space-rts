// ============================================================
// PRODUCTION — BUILD POLICY
// ============================================================
//
// What a mothership chooses to build, expressed as an ordered list
// of rules rather than as code. `sim/behaviors/mothership.js` walks
// this top-down; the first rule that still wants a ship and can be
// paid for wins.
//
// ------------------------------------------------------------
// WHY `blocking` EXISTS
// ------------------------------------------------------------
//
// Without it, a faction short of metal would skip its expensive
// miner rule and spend the change on a cheap fighter instead —
// every time — and so would never rebuild its economy. `blocking`
// means "if this rule still wants a ship, save up for it rather
// than falling through".
//
// The arc that falls out of the ordering is the one worth having:
// each faction opens by building its mining fleet, and only starts
// producing warships once the economy is at capacity. So a run
// begins quiet and industrial, and combat arrives as a consequence
// of prosperity rather than as the opening move.
//
// ------------------------------------------------------------
// WHY THE EMERGENCY RULE EXISTS
// ------------------------------------------------------------
//
// Because without it the simulation had no way back from a bad
// patch, and every run ended the same way.
//
// A faction being raided loses miners faster than it can replace
// them. With only the two peacetime rules, `blocking` then meant
// it spent every scrap of metal it had on *another* miner, which
// was shot on its way to the field — forever. Twelve minutes of
// observed play had the losing side field exactly zero fighters
// while its opponent camped its front door with ten. It was not
// losing; it was being held under water.
//
// So: a faction that is taking losses and has almost no escorts
// stops mining and builds warships. That single rule turns a
// terminal snowball into a tide — the raided side fights back near
// its own station, where it repairs and the attacker does not,
// pushes the raiders off, and goes back to mining.
//
// ------------------------------------------------------------
// FIELDS
// ------------------------------------------------------------
//   type      key into SHIP_TYPES
//   maxAlive  population cap for this type
//   blocking  hold metal for this rule instead of falling through
//   reserve   extra metal that must exist beyond the ship's cost
//   when      optional predicate; the rule is skipped when it is false

import { POSTURE } from './postures.js';
import { outpostSite } from '../sim/outposts.js';

/**
 * Is there anywhere worth putting a shed, and do we lack one there?
 *
 * Asks the same function that will actually place it, so the rule
 * that decides to *buy* an outpost and the code that decides where it
 * *goes* can never disagree — a faction cannot save up for a
 * structure that turns out to have nowhere to stand.
 */
function needsOutpost(faction, world) {
    if (!world) return false;
    return !!outpostSite(world, faction);
}

export const PRODUCTION_POLICY = [
    {
        // Under attack and effectively undefended: warships first.
        type: 'fighter',
        maxAlive: 26,
        blocking: true,
        reserve: 0,
        when: (faction) => faction.underThreat && (faction.counts.fighter || 0) < 3,
    },
    {
        // Defending or rebuilding: escorts before economy.
        //
        // The first rule above catches the acute case — being shot at
        // with nothing to shoot back with. This catches the standing
        // one: a faction whose posture says the fighting is at its own
        // door should not be spending its next 40 metal on a miner to
        // send out through it.
        //
        // Expressed as a posture rather than as another pile of
        // conditions on `faction`, which is the whole point of the
        // layer: the situation is named once, in sim/posture.js, and
        // every rule that cares about it says its name.
        type: 'fighter',
        maxAlive: 26,
        blocking: true,
        reserve: 0,
        when: (faction) => faction.posture === POSTURE.DEFEND
            && (faction.counts.fighter || 0) < 5,
    },
    {
        // Miners, and one more of them when the money is thin.
        //
        // "Low on resources" is a reason to widen the economy, not to
        // economise — a faction that responds to a shortfall by
        // building fewer earners is one that never recovers. The cap
        // is a function of the faction rather than a constant so that
        // this reads as a standing policy instead of a special case
        // bolted onto the rule below.
        type: 'miner',
        maxAlive: (faction) => (faction.lean ? 4 : 3),
        blocking: true,
        reserve: 0,
        // No upkeep runway. A miner pays for itself and then pays for
        // everything else; a faction that has to save up before it may
        // buy one is a faction that cannot climb out of a bad patch.
        // See the note in sim/yard.js.
        runway: 0,
        // A faction with no miners still builds miners — that is what
        // REBUILD means — but one under siege at its own station does
        // not send a fresh one out to be shot, which is the exact
        // pattern §5 measured: build in 114 s, lose in 16.
        when: (faction) => faction.posture !== POSTURE.DEFEND
            || (faction.counts.miner || 0) === 0,
    },
    {
        // The line ship, and the first rule in this file that exists
        // because of *posture* rather than in spite of it.
        //
        // A corvette costs 70 to build and 0.56/s to keep — nearly
        // three fighters on both counts — so it is only worth having
        // when the fighting is going to be sustained and in one place.
        // RAID and SIEGE are exactly that: pressing an advantage
        // against an economy, or grinding down a station. In EXPAND a
        // faction wants cheap hulls spread across its miners instead,
        // and this rule simply does not apply.
        //
        // That sentence is the whole argument for building the posture
        // layer before the ship. In a flat list the only thing a new
        // class could say was "and also build these", and the leader
        // would have added corvettes on top of a full wing of
        // fighters. Here it says *when*, and upkeep makes the answer
        // cost something.
        // The heaviest hull, and the one that answers a swarm.
        //
        // Ordered *above* the corvette because it is the specialist:
        // when a faction is being pressed at its own station or is
        // grinding one down, the fighting is close and crowded and
        // flak is what that situation wants. RAID is deliberately
        // absent — a raid is a fast strike against miners across open
        // map, which is the one job the slowest hull in the fleet is
        // worst at.
        // A forward store, once the frontier has moved out of reach.
        //
        // Blocking, and with nothing held back. Non-blocking it was
        // never built once in twenty-five minutes across four seeds:
        // at 150 metal it needs a treasury a faction paying upkeep
        // essentially never reaches, and every cheaper rule below
        // drained the savings before it got there. Same failure the
        // frigate had, same mechanism fixes it.
        //
        // Worth blocking for in a way a warship is not — a shed pays
        // for itself in miner round trips within a couple of minutes
        // and then keeps paying, so the metal is not spent so much as
        // moved into the economy. `outpostSite` decides whether there
        // is anywhere worth putting one; this rule only decides it can
        // be afforded.
        // The yard. Expensive, blocking, and deliberately late.
        //
        // Blocking for the same reason the outpost is: at 300 metal it
        // needs a treasury a faction paying upkeep rarely reaches, and
        // every cheaper rule below would drain the savings before it
        // got there. Gated on actually having an economy worth
        // defending — a faction that cannot keep two miners alive has
        // no business buying a shipyard, and the metal is better spent
        // on the escorts that would fix the underlying problem.
        //
        // Not while under attack at home. A structure that takes
        // eighteen seconds to build and cannot defend itself is the
        // wrong purchase when the enemy is already at the door.
        type: 'factory',
        maxAlive: 1,
        blocking: true,
        reserve: 0,
        when: (faction) => faction.posture !== POSTURE.DEFEND
            && faction.posture !== POSTURE.REBUILD
            && (faction.counts.miner || 0) >= 2
            && (faction.counts.outpost || 0) >= 1,
    },
    {
        type: 'outpost',
        // Room for a supply chain rather than a single depot. The
        // binding limit is `outpostSite`, which will only name a spot
        // that most of the fleet is actually commuting past and that
        // no existing shed already serves — so this is a ceiling on a
        // sprawl that the siting rule has to justify one at a time,
        // not a target.
        maxAlive: 5,
        blocking: true,
        reserve: 0,
        when: (faction, world) => faction.posture !== POSTURE.DEFEND
            && needsOutpost(faction, world),
    },
    {
        // Something to run the route. One light hauler per shed keeps
        // the ore moving; the heavy earns its cost only once a shed is
        // filling faster than the small one can empty it.
        type: 'hauler',
        maxAlive: 3,
        blocking: false,
        reserve: 20,
        when: (faction) => (faction.counts.outpost || 0) > 0
            && (faction.counts.hauler || 0) < (faction.counts.outpost || 0) + 1,
    },
    {
        type: 'freighter',
        maxAlive: 2,
        blocking: false,
        reserve: 80,
        when: (faction) => (faction.counts.outpost || 0) > 0
            && (faction.counts.freighter || 0) < (faction.counts.outpost || 0),
    },
    {
        // Blocking, and that is the whole reason a heavy hull is ever
        // built at all.
        //
        // Without it the ladder had a top nobody reached. A faction
        // sitting in SIEGE would fall through to the fighter rule the
        // moment it could not afford a frigate, spend the metal on a
        // 25-cost hull, and arrive back at the frigate rule just as
        // poor as before — measured over six seeds and ninety minutes,
        // `flak` was fired exactly zero times and the lance 294 times
        // against the pulse cannon's 3,573. Three classes existed and
        // one was in use.
        //
        // `blocking` is the mechanism this file already had for
        // precisely that failure — see the note at the top on why a
        // faction short of metal must not spend its savings on
        // whatever happens to be cheap. The emergency fighter rules
        // sit above these, so a faction that is genuinely undefended
        // still buys escorts first and never saves its way into being
        // overrun.
        type: 'frigate',
        maxAlive: 3,
        blocking: true,
        reserve: 0,
        when: (faction) => faction.posture === POSTURE.SIEGE
            || faction.posture === POSTURE.DEFEND,
    },
    {
        type: 'corvette',
        maxAlive: 6,
        blocking: true,
        // Small, because upkeep already keeps treasuries thin. The
        // reserve started at 120 — on top of the 70 cost, that meant
        // banking 190 metal, which a faction paying wages essentially
        // never does, and corvettes were unbuildable in a fifteen
        // minute run. The gate that matters here is the posture, not
        // the savings target.
        reserve: 0,
        // Pressing, grinding, or holding — the three situations where
        // the fighting is concentrated in one place for a while, which
        // is the only time a slow tough hull earns its wages. DEFEND
        // belongs here as much as the two offensive postures: a
        // besieged faction wanting something that can stand in its own
        // guns and not die is exactly the case for a corvette, and it
        // gives the class a role on both sides of a lopsided run
        // rather than only to whoever is winning.
        //
        // EXPAND is deliberately absent. A faction spreading escorts
        // thinly across miners scattered over a large map wants cheap
        // hulls in many places, not one expensive hull in one place.
        when: (faction) => faction.posture === POSTURE.RAID
            || faction.posture === POSTURE.SIEGE
            || faction.posture === POSTURE.DEFEND,
    },
    {
        // Population caps are now a *safety* ceiling, not a balance
        // dial — upkeep is what actually decides how large a fleet an
        // economy can carry, and it moves with income instead of
        // sitting in a constant. This number exists so that a runaway
        // economy cannot spawn hulls until the frame budget dies.
        type: 'fighter',
        maxAlive: 26,
        blocking: false,
        // Keep a miner's worth of metal in hand, so a miner lost
        // mid-war can be replaced immediately instead of after the
        // next full cargo run.
        reserve: 20,
    },
    {
        // Overflow. A faction that has capped its fleet and is still
        // banking metal has nothing to spend it on, and observed runs
        // had the leading side sitting on well over a thousand unused
        // metal. Widening the economy instead turns that surplus into
        // more miners — which means more exposed targets, more
        // contested ground, and more for the other side to shoot at.
        type: 'miner',
        maxAlive: 8,
        blocking: false,
        reserve: 300,
    },
];

/** Seconds after a loss during which a faction counts as under threat. */
export const THREAT_MEMORY = 20;

// ============================================================
// FACTORY POLICY — WHAT A YARD BUILDS
// ============================================================
//
// A separate list rather than a flag on the rows above, because it
// answers a different question. PRODUCTION_POLICY is "what does this
// faction need next", evaluated by a station that can build almost
// anything; this is "what is a yard *for*", and the answer is one
// class. Keeping them apart means a destroyer can never be produced
// by a faction that has not built the building, without a single rule
// in either list having to check for the other.
//
// Same row shape, same evaluator — see sim/yard.js.
export const FACTORY_POLICY = [
    {
        // Two, not one, and not a fleet.
        //
        // One destroyer is a curiosity that dies alone; a wall of them
        // is a faction that has stopped being interesting to watch and
        // started being unanswerable. Two is a *detachment* — enough
        // that losing one matters and the other has to decide whether
        // to press on.
        type: 'destroyer',
        maxAlive: 2,
        blocking: false,
        reserve: 0,
        // Only when there is a war on worth committing a capital ship
        // to. In EXPAND a faction should be spending on miners and
        // escorts, and a destroyer sitting in a quiet run is 260 metal
        // and 1.04/s of upkeep doing nothing.
        when: (faction) => faction.posture === POSTURE.RAID
            || faction.posture === POSTURE.SIEGE
            || faction.posture === POSTURE.DEFEND,
    },
];
