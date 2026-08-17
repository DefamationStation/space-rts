// ============================================================
// POSTURE — WHAT A FACTION IS TRYING TO DO
// ============================================================
//
// One string per faction, recomputed once per step, that answers a
// question nothing in the simulation could previously answer: not
// "what is this ship doing" but "what is this *side* doing".
//
// ------------------------------------------------------------
// WHY THIS EXISTS BEFORE THE SHIPS THAT NEED IT
// ------------------------------------------------------------
//
// Because `PRODUCTION_POLICY` is an ordered list, and an ordered list
// can express "miners before warships" and cannot express "build
// destroyers when you are besieging".
//
// That limit was invisible with two combat classes and becomes the
// whole problem with five. A flat list has one axis — priority — so
// every new hull is another row competing for the same metal in every
// situation, and the only dial available is a population cap. Add a
// corvette, a frigate and a destroyer that way and a faction does not
// acquire a *strategy*; it acquires three more things to buy at once.
// Posture adds the missing axis. A rule can now say *when* it applies,
// so a class can belong to a situation rather than to a rank.
//
// It is also what makes a lead cost something. `SIEGE` commits the
// fleet to the enemy's doorstep, which is a long way from the miners
// it is no longer escorting — so pressing an advantage opens you to a
// counter-raid, and winning becomes a decision with a downside rather
// than a straight consequence of being ahead.
//
// ------------------------------------------------------------
// THE RULES ARE ORDERED, AND WHY
// ------------------------------------------------------------
//
// First match wins, emergencies first, in the same spirit as
// `data/production.js`. A faction with no miners is rebuilding
// whatever its fleet ratio says, and a faction with enemies in its
// yard is defending whatever it would rather be doing. Reading order
// *is* the priority, which keeps the whole policy legible as a
// paragraph rather than as a truth table.
//
// ------------------------------------------------------------
// HYSTERESIS IS NOT OPTIONAL
// ------------------------------------------------------------
//
// A posture that flips every step is strictly worse than no posture
// at all: fighters would re-anchor between the enemy station and
// their own miners several times a second and travel nowhere, which
// is the same dithering `patrol` was rewritten to remove.
//
// So there are two brakes, and they do different jobs. The *bands* —
// enter SIEGE at 2.0, leave below 1.4 — stop a faction hovering on a
// threshold from oscillating. The *dwell* stops a faction that has
// genuinely crossed a band from crossing back on the next kill.
// Emergencies (DEFEND, REBUILD) bypass the dwell, because a station
// under fire cannot wait out a timer before reacting to it.

import { EV } from '../core/events.js';
import { isHostile } from './behaviors/common.js';
import { POSTURE } from '../data/postures.js';
import { isPlayed } from '../data/factions.js';
import {
    POSTURE_DWELL, SIEGE_ENTER, SIEGE_EXIT, RAID_ENTER, RAID_EXIT,
    DEFEND_RANGE, DEFEND_MEMORY, SIEGE_COMMIT, SIEGE_COOLDOWN,
} from '../core/constants.js';

/**
 * Recompute every faction's posture. Called once per step from
 * `census()` in simulate.js, after fleet strength is known.
 */
export function updatePostures(world) {
    const factions = world.factions;
    for (let i = 0; i < factions.length; i++) {
        const faction = factions[i];
        // The swarm has no strategy. It arrives and it attacks.
        if (!isPlayed(faction)) continue;
        const next = classify(world, faction);
        if (next === faction.posture) continue;

        // Emergencies jump the queue; everything else waits out the
        // dwell so a single exchange cannot swing a whole fleet.
        const urgent = next === POSTURE.DEFEND || next === POSTURE.REBUILD;
        if (!urgent && world.time - faction.postureSince < POSTURE_DWELL) continue;

        // A siege in progress is not reconsidered until it has had
        // time to arrive. Only DEFEND may interrupt one — a station
        // under attack at home outranks an attack abroad.
        if (faction.posture === POSTURE.SIEGE && next !== POSTURE.DEFEND
            && world.time - faction.postureSince < SIEGE_COMMIT) continue;

        const from = faction.posture;
        // Stamped on the way *out* of a siege, so the cooldown counts
        // from when the fleet stopped rather than from when it
        // started. A siege that ran its full commit and one that was
        // broken off after eight seconds leave a fleet in the same
        // condition, and it is that condition the cooldown is about.
        if (from === POSTURE.SIEGE) faction.siegeEndedAt = world.time;
        faction.posture = next;
        faction.postureSince = world.time;
        // A fresh siege has not gathered yet. `behaviors/fighter.js`
        // holds the fleet at its station until it has.
        if (next === POSTURE.SIEGE) faction.siegeReady = false;
        world.events.emit(EV.POSTURE_CHANGED, { faction, from, to: next });
    }
}

/**
 * Which posture the situation calls for, ignoring the dwell.
 *
 * Ratio is strength against everyone hostile, so it generalises to
 * more than two factions without a rewrite — and a faction facing no
 * fleet at all gets `Infinity`, which lands it in SIEGE. That is the
 * correct reading: there is nothing left to fight, so go and finish it.
 */
function classify(world, faction) {
    if (!(faction.counts.miner > 0)) return POSTURE.REBUILD;
    if (threatened(world, faction)) return POSTURE.DEFEND;

    // No fleet, no offensive posture — whatever the ratio says.
    //
    // Without this the opening eight seconds of every run read
    // `expand → rebuild → siege`, because at t=0 nobody has built a
    // warship yet, so `hostileStrength` is 0, so the ratio is
    // Infinity, so both factions "commit to a siege" with nothing to
    // commit. It was harmless — there were no hulls to anchor on the
    // enemy station — and it was also the layer announcing a decision
    // that had not been made, which is worse than useless in a trace
    // whose whole job is to say what a faction is doing.
    if (faction.strength <= 0) return POSTURE.EXPAND;

    const ratio = faction.hostileStrength > 0
        ? faction.strength / faction.hostileStrength
        : Infinity;

    // Bands, not thresholds. The exit is always slacker than the
    // entry, so a faction sitting exactly on a boundary stays put.
    const held = faction.posture;
    if (held === POSTURE.SIEGE && ratio >= SIEGE_EXIT) return POSTURE.SIEGE;
    if (held === POSTURE.RAID && ratio >= RAID_EXIT) {
        const rested = world.time - faction.siegeEndedAt >= SIEGE_COOLDOWN;
        return ratio >= SIEGE_ENTER && rested ? POSTURE.SIEGE : POSTURE.RAID;
    }

    // A siege the fleet is in no state to mount becomes a raid.
    //
    // Not a refusal to act on the advantage — the advantage is real
    // and RAID spends it. It is a refusal to spend it the same way
    // twice in a row without drawing breath.
    const rested = world.time - faction.siegeEndedAt >= SIEGE_COOLDOWN;
    if (ratio >= SIEGE_ENTER && rested) return POSTURE.SIEGE;
    if (ratio >= RAID_ENTER) return POSTURE.RAID;
    return POSTURE.EXPAND;
}

/**
 * Is there fighting at this faction's own front door?
 *
 * Two tests, because they catch different halves of the same fact. A
 * station that has been hit recently is under attack even if the
 * shooter has since drifted out of range; a hostile hull sitting just
 * inside the perimeter is a threat even if it has not fired yet.
 */
function threatened(world, faction) {
    const stations = faction.motherships;
    for (let i = 0; i < stations.length; i++) {
        const station = world.ship(stations[i]);
        if (!station) continue;
        if (world.time - station.lastHitAt < DEFEND_MEMORY) return true;
        if (hostileNearStation(world, station)) return true;
    }
    return false;
}

function hostileNearStation(world, station) {
    let found = false;
    world.shipGrid.queryCircle(station.x, station.y, DEFEND_RANGE, (other) => {
        if (found || other.dead || !other.weapon) return;
        if (!isHostile(world, station.factionId, other.factionId)) return;
        const dx = other.x - station.x, dy = other.y - station.y;
        if (dx * dx + dy * dy <= DEFEND_RANGE * DEFEND_RANGE) found = true;
    });
    return found;
}
