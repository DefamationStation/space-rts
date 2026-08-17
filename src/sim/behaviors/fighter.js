// ============================================================
// BEHAVIOUR — FIGHTER
// ============================================================
//
//   PATROL ──▸ PURSUE ──▸ ENGAGE ──▸ EXTEND ──┐
//      ▲                    │          │      │
//      │                    └──────────┘      │
//      │                                      │
//      └──────────── REGROUP ◂────────────────┘
//
// The only armed thing in v1. Fighters fly high-speed strafing runs
// ("fly-bys"): diving in at full throttle, leading their shots with
// pulse cannon bursts as they close, slicing past the target on an
// offset vector, zooming past to extend separation, and looping
// back around for another pass like actual fighter aircraft.
//
// ------------------------------------------------------------
// WHY IT DOES FLY-BYS INSTEAD OF CIRCLING
// ------------------------------------------------------------
//
// A fighter's main drive is at the back of its hull, giving it strong
// forward acceleration and high speed. Slicing past targets on high-speed
// attack runs lets the fighter leverage its main engines, creates
// readable crossing passes during dogfights, and makes combat feel fast
// and physical.
//
// ------------------------------------------------------------
// WHY IT LEADS ITS SHOTS
// ------------------------------------------------------------
//
// Rounds travel, so firing at where a target *is* misses anything
// crossing. The intercept solve in core/math.js is the difference
// between combat that looks competent and combat that looks
// random — and it is what makes a *miss* meaningful, because the
// misses are then the shots the target actually dodged by
// changing course.

import { setState, homeOf, pickTarget, isHostile, depositPoint, weaponReach, weaponSpeed } from './common.js';
import { POSTURE } from '../../data/postures.js';
import { arrive, seek, orbit, separate, avoidEdges, wander, evade } from '../steering.js';
import { tryFire } from '../combat.js';
import { angleDelta, dist, interceptPoint } from '../../core/math.js';
import { FIGHTER, SPAWNED } from './states.js';
import {
    ENGAGE_RADIUS, PATROL_RADIUS, ESCORT_RADIUS, ESCORT_REFRESH, ESCORT_CROWDING,
    ESCORT_POSTS, ESCORT_FORWARD_BIAS, SCOUT_RANGE, SCOUT_TIMEOUT,
    ESCORT_EXPOSURE,
    ENGAGE_LEASH,
    FIRE_CONE, AIM_TRACK_CONE, RETREAT_HP, REJOIN_HP, HULL_REPAIR_RATE,
    FIGHTER_PASS_OFFSET, FIGHTER_POINT_BLANK, FIGHTER_BREAKOFF, FIGHTER_EXTEND,
    FIGHTER_RUN_TIMEOUT, FIGHTER_EXTEND_TIMEOUT, PURSUE_DROP, FIGHTER_RETARGET,
    MUSTER_TIMEOUT, MUSTER_ALERT_RANGE, SIEGE_STANDOFF, RAID_SHARE, SIEGE_RALLY_SHARE,
    GARRISON_SHARE, GARRISON_DWELL, GARRISON_ARRIVE, GARRISON_HOME_SHARE,
    SQUAD_LEASH, ALARM_MEMORY, GARRISON_RESPONSE,
    SQUADRON_SIZE, HUNT_COHESION, CARGO_EPSILON, LEAN_DUTY_SHIFT, ASSIST_RANGE,
} from '../../core/constants.js';

const { MUSTER, PATROL, SCOUT, PURSUE, ENGAGE, EXTEND, REGROUP } = FIGHTER;

/** Scratch object for the intercept solve — reused, never allocated per call. */
const _lead = { x: 0, y: 0 };

export function fighterBehavior(ship, world, dt) {
    if (!ship.state) {
        // Born into the wing, not into the war. See `muster` below.
        setState(ship, MUSTER, SPAWNED);
        ship.orbitDir = world.rng.chance(0.5) ? 1 : -1;
        ship.passDir = world.rng.chance(0.5) ? 1 : -1;
        // Duty for life — but only for a faction that has anything to
        // divide duties *between*. A swarm hull has no station to
        // garrison and no miners to escort, and rolling it a duty
        // anyway was quietly disastrous: a quarter of every wave came
        // out 'garrison', found no post to hold, anchored on *itself*
        // and therefore had no leash at all. They were not wandering
        // for want of orders; they were wandering because the order
        // they were given resolved to "stay near yourself".
        if (world.faction(ship.factionId)?.alien) {
            ship.duty = 'squad';
            ship.striker = false;
        } else if (world.rng.chance(dutyShare(world, ship, GARRISON_SHARE))) {
            ship.duty = 'garrison';
        } else if (world.rng.chance(dutyShare(world, ship, RAID_SHARE))) {
            ship.duty = 'striker';
            ship.striker = true;
        } else if (world.rng.chance(ship.def.escorts || 0)) {
            ship.duty = 'escort';
        } else {
            // Not an escorting class, or it rolled against it. A hull
            // that is not going to guard a miner holds the line
            // instead — which is what a corvette and a frigate are
            // for, and what everything heavier will be for.
            ship.duty = 'garrison';
        }
    }
    ship.stateTime += dt;

    // Fly nose-first unless this step's state decides otherwise.
    // Only ENGAGE overrides it, and re-clearing here means a fighter
    // that leaves combat cannot get stuck aiming at nothing.
    ship.aimAngle = null;

    // The anchor is whatever this fighter is responsible for — the
    // miner it is escorting, or failing that its own station. Every
    // targeting and pursuit decision below is bounded relative to
    // it, which is what keeps escorts escorting.
    updateAnchor(ship, world);

    separate(ship, world);
    avoidEdges(ship, world);

    // Jink, in every state including the attack run.
    //
    // Applied here rather than inside a state so that a fighter is
    // never in a posture where it has stopped caring about being
    // shot — a hull dodging while it closes and not while it fires is
    // a hull that stops dodging at the exact moment it is most aimed
    // at. It is an additive nudge on the flank jets, so it bends the
    // path without ever overriding where the ship is trying to go.
    evade(ship, world);

    // The swarm does not retreat.
    //
    // Mechanically it has nowhere to go — no station, so no repair and
    // no rally — and a hull limping toward a home that does not exist
    // is the kind of thing that reads as broken. But it is also the
    // characterisation: the natives break off, repair and come back,
    // and the thing coming through the rift simply keeps coming until
    // it is dead. Two fleets that both know how to quit, and one that
    // does not.
    const canRetreat = !world.faction(ship.factionId)?.alien;

    // Damage overrides everything except an existing retreat.
    if (canRetreat && ship.state !== REGROUP && ship.hp < ship.maxHp * RETREAT_HP) {
        ship.targetId = 0;
        setState(ship, REGROUP, 'hull-critical');
    }

    switch (ship.state) {
        case MUSTER: muster(ship, world, dt); break;
        case PATROL: patrol(ship, world, dt); break;
        case SCOUT: scout(ship, world, dt); break;
        case PURSUE: pursue(ship, world, dt); break;
        case ENGAGE: engage(ship, world, dt); break;
        case EXTEND: extend(ship, world, dt); break;
        case REGROUP: regroup(ship, world, dt); break;
    }
}

/**
 * A fight close enough to be this hull's business, or null.
 *
 * The alarm already existed and only the home guard could hear it,
 * gated on how far the fighting was from *the station* — which
 * answers "should the guard leave its post", not "is anyone nearby".
 * So a wing escorting a miner two hundred units from a brawl carried
 * on holding formation while its own side was cut apart in plain
 * sight.
 *
 * Measured from the ship instead, and offered to every duty except
 * the swarm's, because proximity is the whole claim: whoever is
 * near enough to help, helps. It costs nothing to check — `killShip`
 * already publishes where hulls are being lost, so nobody has to be
 * told there is a battle or where it is.
 */
function assistPoint(world, ship) {
    if (ship.duty === 'squad') return null;
    const faction = world.faction(ship.factionId);
    if (!faction || world.time - faction.alarmAt >= ALARM_MEMORY) return null;

    const dx = faction.alarmX - ship.x, dy = faction.alarmY - ship.y;
    if (dx * dx + dy * dy > ASSIST_RANGE * ASSIST_RANGE) return null;

    _assist.x = faction.alarmX;
    _assist.y = faction.alarmY;
    return _assist;
}

/** Scratch for the assist point — reused, never allocated per call. */
const _assist = { x: 0, y: 0 };

/**
 * A faction short of money guards what earns it.
 *
 * Both the home guard and the raiding detachment are things a fleet
 * does when it can afford to: one stands over assets that are not
 * currently under threat, the other goes looking for a fight far from
 * anything of ours. Neither protects income. So while a faction is
 * lean, both shares are cut and the hulls that would have taken them
 * fall through to escort duty — guarding the miners and the freight
 * that are the reason it is poor.
 *
 * A share rather than a switch, so a poor faction still posts *some*
 * guard. A station with nobody over it is how a bad patch becomes a
 * lost run.
 */
function dutyShare(world, ship, share) {
    return world.faction(ship.factionId)?.lean ? share * LEAN_DUTY_SHIFT : share;
}

// ------------------------------------------------------------

/**
 * Wait at the station until the wing is strong enough to be worth
 * sending, then leave with it.
 *
 * ------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ------------------------------------------------------------
 *
 * Reinforcement was serial and destruction was parallel. A faction
 * rebuilding after a bad exchange launched one fighter every three
 * and a half seconds into an intact enemy fleet, and they died one at
 * a time — a fighter launched four or more hulls behind lived a
 * median of 16.8 s and died inside twenty seconds 59% of the time,
 * against 86.4 s and 13% for one launched while ahead. Nothing was
 * wrong with the fighter, and no amount of tuning its hull, gun or
 * retreat threshold addresses arriving alone. The fleet needed a way
 * to *arrive together*, and had none.
 *
 * A mustering hull is not idle. It holds a tight ring around its
 * station, inside the defence battery's cover, and shoots anything
 * that comes into range — so the wing that is forming is also the
 * garrison, and the time is not wasted.
 *
 * ------------------------------------------------------------
 * THE THREE WAYS OUT, AND WHY THERE ARE THREE
 * ------------------------------------------------------------
 *
 * `wing-ready`   the fleet reached `faction.musterNeed`. The
 *                intended exit, and the only one that means the
 *                mechanism did its job.
 * `station-hit`  something is shooting the station. Standing in
 *                formation while the thing you are standing on is
 *                attacked is the one behaviour this must never
 *                produce.
 * `muster-timeout` the clock ran out. The backstop, and the reason
 *                this cannot deadlock: a wing that waits for a
 *                reinforcement it will never afford is a more
 *                elaborate way of doing nothing.
 *
 * Each carries its own reason string, so `telemetry.reasons()` says
 * which one is actually firing. A run where `muster-timeout`
 * dominates is one where the rule is not working — and that is a
 * different reading from the rule not existing, which is exactly the
 * distinction a bare boolean would have thrown away.
 */
function muster(ship, world, dt) {
    const faction = world.faction(ship.factionId);
    const home = homeOf(world, ship);

    // Nothing to muster at. A hull whose station just died is not
    // going to be reinforced by it.
    if (!home || !faction) {
        setState(ship, PATROL, 'no-station');
        return;
    }

    // Defend while waiting. The ring is well inside the station's own
    // battery umbrella, so a wing forming under attack is forming
    // where it is strongest.
    orbit(ship, home.x, home.y, PATROL_RADIUS * 0.55, ship.orbitDir, 0.45);
    if (ship.weapon && acquire(ship, world)) {
        setState(ship, PURSUE, 'target-in-the-yard');
        return;
    }

    if (world.time - home.lastHitAt < 1) {
        setState(ship, PATROL, 'station-hit');
        return;
    }

    // The timeout has to release the *faction*, not just the hull.
    //
    // A siege rally that times out and only sends this ship back to
    // PATROL is an infinite loop: `siegeWaiting` sees the fleet still
    // ungathered and posts it straight back here. The fleet has to
    // give up collectively — so the flag flips and everyone leaves on
    // the same step, with whatever turned up.
    if (ship.stateTime >= MUSTER_TIMEOUT) {
        if (faction.posture === POSTURE.SIEGE) faction.siegeReady = true;
        setState(ship, PATROL, 'muster-timeout');
        return;
    }
    // Two different reasons to be standing here, and they release on
    // different conditions: a newly built hull waits for a wing big
    // enough to survive arriving, a besieging fleet waits for most of
    // itself. Whichever applies, leaving is a fleet-wide event — every
    // hull evaluates the same predicate in the same step, so they go
    // together.
    if (faction.posture === POSTURE.SIEGE) {
        if (siegeRallied(world, faction, home)) {
            faction.siegeReady = true;
            setState(ship, PATROL, 'siege-ready');
        }
        return;
    }

    if (mustered(world, ship.factionId, home) >= faction.musterNeed) {
        setState(ship, PATROL, 'wing-ready');
    }
}

/**
 * The strength currently standing in the yard, in metal-cost.
 *
 * Counted by walking the faction's hulls rather than by keeping a
 * running total, because "is in MUSTER *and* still near the station"
 * is a fact that decays — a hull released last step is no longer part
 * of this wing, and a counter would have to be told. Fleets are tens
 * of hulls, this runs only for ships that are themselves mustering,
 * and the alternative is a cache that can be wrong.
 */
function mustered(world, factionId, home) {
    let total = 0;
    const r2 = MUSTER_ALERT_RANGE * MUSTER_ALERT_RANGE;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== factionId || s.state !== MUSTER) continue;
        const dx = s.x - home.x, dy = s.y - home.y;
        if (dx * dx + dy * dy > r2) continue;
        total += s.def.cost;
    }
    return total;
}

/**
 * Idle fighters escort the fleet's most exposed miner rather than
 * circling their own front door.
 *
 * This is the single decision that makes the simulation develop.
 * Fighters that patrol home only ever meet an enemy that comes to
 * them, so two factions mining opposite corners can run for many
 * minutes without exchanging a shot. Escorting instead produces
 * the chain the whole design rests on: miners follow ore, ore is
 * clustered and contested, fighters follow miners — so the
 * fighting happens where the value is, which is exactly where it
 * should be, and nobody had to be told to go looking for it.
 *
 * "Most exposed" is simply the miner furthest from home, refreshed
 * every few seconds so a fighter commits to one rather than
 * dithering between two.
 */
function patrol(ship, world, dt) {
    // The leash is checked *before* the target search, not after it.
    //
    // A fighter already outside its leash cannot legally pursue
    // anything: PURSUE drops the target on its first step and hands
    // the ship straight back here. Acquiring first produced exactly
    // that — 540 of 744 acquisitions in a ten-minute run returned
    // within one step — and because both states hand off before they
    // steer, the hull never flew home either. It sat there coasting,
    // changing its mind thirteen times a second, until something else
    // moved. Checking first turns that into what it should always
    // have been: fly back to your charge.
    // The leash gates target acquisition — except when the anchor is
    // something we are attacking rather than something we are guarding.
    //
    // `offLeash` asks "have I strayed too far from my charge", and for
    // an escort that is exactly right. For a hull crossing the map to
    // besiege a station it is nonsense: the anchor is the destination,
    // so *the entire journey* counts as off leash, and the hull cannot
    // acquire anything the whole way there. Measured over four seeds,
    // 55% of besieging hulls were in that state — unable to target a
    // fighter shooting them at point-blank range. A corvette would fly
    // through an interception, take the damage, shoot at nothing, and
    // carry on.
    //
    // A leash is a tether to something you are protecting. An
    // objective is not a tether, so it does not get one, and a hull on
    // its way to one still defends itself against whatever is in the
    // way.
    // Only a hull with a *fixed* gun goes hunting for a firing
    // solution. A turret-only ship never leaves station-keeping:
    // pointing at a target is exactly the thing its mounts exist to
    // spare it, so it holds its course and its guns do the work.
    //
    // This gate is doctrine, not safety. Every distance test below
    // goes through `weaponReach`, which answers for mounts as happily
    // as for a nose gun, so a turret-only hull that somehow found its
    // way into an attack run would fly it rather than throw. It used
    // to read `ship.weapon.range` directly and a hull with no nose gun
    // quarantined on the spot — the frigate sat inert with six
    // perfectly good turrets, which is a very quiet way for a warship
    // to fail, and it stayed quiet because quarantine is silent.
    //
    // The exception is a hull with nowhere else to be. "Never leaves
    // station-keeping" is a sensible rule for a frigate screening a
    // miner and a nonsense one for a harvester that has just warped
    // into somebody's front garden: it has no station to keep, so the
    // doctrine resolved to "do nothing in particular, forever". A
    // squad hull closes like anything else.
    const mayPursue = ship.weapon || ship.duty === 'squad';
    if (mayPursue && !leashed(ship, world) && acquire(ship, world)) {
        setState(ship, PURSUE, 'target-acquired');
        return;
    }

    // A posture that names a destination overrides escort duty, and
    // it has to override the *steering*, not merely the leash.
    //
    // The first version of this set only `anchorX/anchorY`, which
    // bounds where a fighter may fight but says nothing about where it
    // flies — so a besieging fleet was permitted to engage at the
    // enemy's station and still went and orbited its own miner. It
    // measured exactly as you would expect once looked at: across four
    // seeds and forty-eight minutes, the closest an armed hostile ever
    // came to a station was 1,275 units, against a DEFEND_RANGE of
    // 900. Nobody was ever besieged, so nobody ever defended, and two
    // of the five postures were unreachable.
    // Ordered to besiege, but the fleet has not formed yet: go and
    // stand with it instead of setting off alone.
    //
    // This is the fix for a siege that read as a queue rather than an
    // assault. MUSTER already existed and only ever fired at *spawn*,
    // so a fleet that switched into SIEGE never gathered — every hull
    // took its own bearing from wherever it was standing, and a
    // corvette intercepted halfway across had no support because there
    // was no formation, only stragglers. Reusing the state costs
    // nothing and means a wing forms the same way whether it is being
    // built or being called together.
    if (siegeWaiting(ship, world)) {
        setState(ship, MUSTER, 'siege-rally');
        return;
    }

    const forced = postureAnchor(ship, world);
    if (forced) {
        // Toward something hostile: drive at it. Around something
        // friendly: hold a ring.
        //
        // Both used to orbit, and orbiting an *enemy* was wrong in a
        // way that showed on screen. The orbit controller is a spring
        // onto a ring of a given radius, so a striker crossing the map
        // to hit a mining field spent its approach being braked to
        // orbital speed and curved around its target — it arrived
        // slow, side-on and turning, which is the worst possible
        // geometry for a hull whose entire thrust is out the back and
        // whose whole idea is the fly-by.
        //
        // `seek` is flat-out toward the anchor and nothing else, and
        // it only governs the long approach: the moment the target
        // comes inside ENGAGE_RADIUS, `acquire` above hands the ship
        // to PURSUE and then to the attack run. So a strike now reads
        // as a dive rather than as an arrival.
        //
        // The friendly case keeps its ring — DEFEND anchors on our own
        // station, and seeking that would mean flying into the hull.
        if (isHostile(world, ship.factionId, forced.factionId)) {
            seek(ship, forced.x, forced.y);
        } else {
            orbit(ship, forced.x, forced.y, PATROL_RADIUS, ship.orbitDir, 0.55);
        }
        return;
    }

    // Anyone answering the alarm flies *to* it, whatever their duty.
    if (assistPoint(world, ship)) {
        seek(ship, ship.anchorX, ship.anchorY);
        return;
    }

    // A guard answering the alarm flies *to* it.
    //
    // Setting `anchorX/anchorY` alone was not enough, and this is the
    // third time that has caught me: an anchor bounds where a hull may
    // fight, and says nothing about where it goes. A responder with no
    // post assigned fell through to orbiting its own station — still
    // circling, now with permission to shoot slightly further away.
    if (ship.duty === 'garrison' && !ship.escortId) {
        seek(ship, ship.anchorX, ship.anchorY);
        return;
    }

    const charge = world.ship(ship.escortId);

    // A hostile charge is prey. Drive at it and let `acquire` above
    // take over the moment it is in reach — station-keeping in a neat
    // wedge alongside the miner you are supposed to be killing would
    // be a memorable bug.
    if (charge && isHostile(world, ship.factionId, charge.factionId)) {
        seek(ship, charge.x, charge.y);
        return;
    }

    if (charge) {
        // Station-keeping in formation, not a permanent circle.
        //
        // Escorts used to orbit their charge and never stop, which had
        // two costs. It read wrong — an escort is a thing that travels
        // *with* what it is guarding, and endless circling reads as a
        // holding pattern rather than as protection. And it meant a
        // fighter was never once asked to slow down: ORBIT_SPEED is a
        // fixed 0.85 of cruise, so an escorting hull sat at 112 u/s
        // for its entire life and the fleet looked like it physically
        // could not stop.
        //
        // `arrive` fixes both at once, and the second one falls out for
        // free: the demand is proportional to the distance still to
        // cover, so a hull settling onto its berth eases off and holds.
        // Handing it the charge's velocity is what makes it station-
        // keeping rather than a stern chase — at the slot the desired
        // velocity *is* the charge's, so the pair fly as one.
        // A picket or outrider will break station to investigate
        // something at the edge of its awareness — the thing a close
        // guard never does, and the reason a squadron notices trouble
        // before it arrives.
        //
        // A turret-only hull sits this out, for the same reason it
        // never pursues: an investigation ends by converting the
        // contact into an attack run, and a ship whose guns all steer
        // themselves has no reason to go and point at something.
        //
        // That gate exists on PURSUE and was missed here, which is how
        // the frigate and the swarm's harvester — the two hulls
        // carrying no centreline weapon at all — went inert the first
        // time a picket went to look at something.
        if (ship.weapon && (ship.post === 'picket' || ship.post === 'outrider')
            && world.time >= ship.threatCheckAt) {
            ship.threatCheckAt = world.time + 2.5;
            const contact = distantContact(world, ship, charge);
            if (contact) {
                ship.targetId = contact.id;
                setState(ship, SCOUT, 'investigating');
                return;
            }
        }

        formationSlot(ship, charge, world, _slot);
        // A loose arrival radius on purpose. Tight and the hull snaps
        // onto a moving coordinate, which is what made the old wedge
        // look mechanical; slack, and it settles into the region and
        // breathes there.
        arrive(ship, _slot.x, _slot.y, ESCORT_RADIUS * 1.3, 0.85, charge.vx, charge.vy);
        return;
    }

    // A squad leader with nobody to follow drives at the enemy.
    //
    // This is where an incursion was quietly dying. A swarm hull has
    // no station, so the leader of a wave fell through to `wander` —
    // and once `squadLeader` started picking the *heaviest* hull, the
    // thing doing the wandering was the harvester the whole wave was
    // formed up on. Measured: harvesters spent 100% of their lives in
    // `patrol`, at cruise speed, going nowhere in particular, while
    // their mounts fired at whatever happened to drift through an arc.
    //
    // The swarm's objective is not subtle, so neither is this: head
    // for the nearest station that is not yours. Everything the wave
    // meets on the way is dealt with by the ordinary path — nose guns
    // acquire and pursue, turrets fire as targets enter their arcs —
    // and a wave that is *going somewhere* generates that contact
    // instead of waiting to be found.
    if (ship.duty === 'squad') {
        const objective = nearestHostileStation(world, ship);
        if (objective) { seek(ship, objective.x, objective.y); return; }
    }

    const home = homeOf(world, ship);
    if (home) orbit(ship, home.x, home.y, PATROL_RADIUS, ship.orbitDir, 0.5);
    else wander(ship, world, dt, 0.4);
}

/**
 * Something worth flying out to look at.
 *
 * Deliberately *outside* normal engagement range: anything inside
 * that will be acquired and attacked by the ordinary path, so
 * investigating it would add nothing. What this finds is the contact
 * a squadron would otherwise not react to until it arrived.
 */
function distantContact(world, ship, charge) {
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < world.ships.length; i++) {
        const other = world.ships[i];
        if (other.dead || !isHostile(world, ship.factionId, other.factionId)) continue;
        if (!other.weapon && !other.mounts.length) continue;

        const d2 = (other.x - charge.x) ** 2 + (other.y - charge.y) ** 2;
        if (d2 > SCOUT_RANGE * SCOUT_RANGE) continue;
        if (d2 < ENGAGE_RADIUS * ENGAGE_RADIUS) continue;   // the fleet has this
        if (d2 < bestD2) { bestD2 = d2; best = other; }
    }
    return best;
}

/**
 * Fly out, have a look, come back.
 *
 * It ends three ways and all of them are ordinary: the contact comes
 * into weapon range and this becomes a real attack run, the contact
 * is gone and there was nothing to see, or the clock runs out. In
 * every case the hull returns to its station, which is what separates
 * a picket from a fighter that wandered off.
 */
function scout(ship, world, dt) {
    const target = world.ship(ship.targetId);
    const charge = world.ship(ship.escortId);

    if (!target || !charge || ship.stateTime > SCOUT_TIMEOUT) {
        ship.targetId = 0;
        setState(ship, PATROL, !target ? 'contact-lost' : 'seen-enough');
        return;
    }

    // Close on it, and hand over to the attack run once it is in
    // reach — an investigation that finds something becomes a fight.
    seek(ship, target.x, target.y);
    if (dist(ship.x, ship.y, target.x, target.y) <= weaponReach(ship) * 1.1) {
        setState(ship, PURSUE, 'contact-hostile');
        return;
    }

    // Not worth leaving the charge undefended for.
    if (dist(ship.x, ship.y, charge.x, charge.y) > SCOUT_RANGE) {
        ship.targetId = 0;
        setState(ship, PATROL, 'too-far-out');
    }
}

/**
 * Refresh what this fighter is guarding, and cache its position.
 *
 * Re-picked on an interval rather than every step so a fighter
 * commits to one charge instead of dithering between two equally
 * distant ones.
 */
function updateAnchor(ship, world) {
    // Commit to a charge and keep it while it lives.
    //
    // Re-picking on a timer looked like the cautious choice and was
    // the expensive one. The score is distance-based, so a fighter
    // that has fallen behind its miner scores some *other* miner
    // better, switches, falls behind that one, and switches again — it
    // is the `patrol` dithering problem wearing an escort's uniform.
    // A hull that never closes the last few hundred units never enters
    // formation and never gets to throttle back, which is exactly the
    // symptom this whole change set out to remove.
    //
    // So the refresh is now a *retry* for a fighter that has no charge
    // rather than a re-evaluation for one that does. The charge only
    // changes when the miner it was guarding is gone.
    // Squadron first. A swarm hull is never a garrison or an escort,
    // and checking those before this let a mis-rolled duty win.
    if (ship.duty === 'squad') {
        if (world.time >= ship.escortAt || !world.ship(ship.escortId)) {
            ship.escortAt = world.time + ESCORT_REFRESH;
            ship.escortId = squadLeader(world, ship);
            assignSlot(world, ship);
        }
        const lead = world.ship(ship.escortId);
        ship.anchorX = lead ? lead.x : ship.x;
        ship.anchorY = lead ? lead.y : ship.y;
        return;
    }

    // A fight within reach outranks whatever this hull was doing.
    //
    // Above the duty branches on purpose: an escort near a brawl is
    // more use in the brawl than in formation, and a guard is more use
    // there than on a circuit. The leash follows the anchor, so a hull
    // that diverts is also permitted to fight when it arrives.
    const help = assistPoint(world, ship);
    if (help) {
        ship.anchorX = help.x;
        ship.anchorY = help.y;
        return;
    }

    // A garrison hull guards *places*, and it rotates between them.
    //
    // It used to orbit its station and nothing else, which is the
    // circling that made a faction's home look like a screensaver: a
    // dozen hulls on a fixed ring, forever, whatever was happening
    // elsewhere. There was nothing else to guard then. There is now —
    // a station, a home field, and one or two forward stores — so the
    // home guard patrols a *circuit* of them instead.
    //
    // That single change replaces the ring with traffic: hulls
    // crossing between assets on their own schedules, arriving,
    // holding station a while, moving on. Nothing about it is
    // decorative — a shed with a garrison hull sitting on it is
    // genuinely harder to raid than one without.
    if (ship.duty === 'garrison') {
        // A fight nearby outranks the circuit.
        //
        // This is the whole answer to a home guard circling its
        // station while the fleet is cut apart two thousand units
        // away. The alarm is raised by `killShip` at the place hulls
        // are actually being lost, so a guard does not need to be told
        // there is a battle or where it is — it responds to its own
        // side dying, which is the most legible possible trigger.
        const faction = world.faction(ship.factionId);
        if (faction && world.time - faction.alarmAt < ALARM_MEMORY) {
            const home = homeOf(world, ship);
            const reach = home
                ? dist(faction.alarmX, faction.alarmY, home.x, home.y)
                : 0;
            if (reach < GARRISON_RESPONSE) {
                ship.anchorX = faction.alarmX;
                ship.anchorY = faction.alarmY;
                ship.escortId = 0;
                return;
            }
        }

        // The dwell counts from *arrival*, not from assignment.
        //
        // It used to start the moment a post was handed out, so a hull
        // sent to a shed two thousand units away spent its whole
        // twenty-six seconds in transit and was reassigned somewhere
        // else on the step it got there. Measured: a third of garrison
        // hulls were assigned an outpost, and the upper quartiles sat
        // 1,522 and 1,879 units from the post they were assigned to.
        // They were not guarding anything — they were commuting, and
        // the circuit looked from outside like everything loitering at
        // home, because home is where the commute keeps starting.
        const held = world.ship(ship.escortId);
        const arrived = held && dist(ship.x, ship.y, held.x, held.y) < GARRISON_ARRIVE;

        if (!held) {
            ship.escortId = nextPost(world, ship);
            ship.escortAt = world.time + GARRISON_DWELL;
            assignSlot(world, ship);
        } else if (!arrived) {
            // Still on the way. Hold the clock so the journey is not
            // charged against the time on station.
            ship.escortAt = world.time + GARRISON_DWELL;
        } else if (world.time >= ship.escortAt) {
            ship.escortId = nextPost(world, ship);
            assignSlot(world, ship);
        }

        const post = world.ship(ship.escortId) || homeOf(world, ship);
        ship.anchorX = post ? post.x : ship.x;
        ship.anchorY = post ? post.y : ship.y;
        return;
    }

    if (world.time >= ship.escortAt) {
        ship.escortAt = world.time + ESCORT_REFRESH;
        // The charge only changes when the miner it was guarding is
        // gone; the berth is recomputed every tick regardless.
        //
        // Those are two different questions and tying them together
        // was a bug. A fighter's rank is its position among *the group
        // as it stands*, so it goes stale whenever anyone else joins
        // or leaves — and since each hull computed its rank only when
        // its own charge changed, two fighters that joined the same
        // miner at different moments could both come out as slot 1.
        // Observed live: one miner with two escorts on berth 1 and
        // another with two on berth 3, flying inside each other and
        // held apart only by `separate`.
        if (!world.ship(ship.escortId)) ship.escortId = pickCharge(world, ship);
        assignSlot(world, ship);
    }

    // What a fighter is responsible for depends on what its *faction*
    // is trying to do. Two postures override the default escort duty,
    // and they are the two where escorting is the wrong answer:
    //
    //   SIEGE   the fleet is committed to the enemy's station, so the
    //           anchor is that station. This is what gives a lead a
    //           price — a besieging fleet is a long way from the
    //           miners it has stopped guarding, and a counter-raid
    //           costs the leader real economy.
    //   DEFEND  the fighting is at our own door; the anchor is home
    //           whatever the miners are doing.
    //
    // Everything else keeps the escort behaviour that made the
    // simulation develop in the first place — miners follow ore,
    // fighters follow miners, so combat happens where the value is.
    const anchor = postureAnchor(ship, world)
        || world.ship(ship.escortId)
        || homeOf(world, ship);
    if (anchor) {
        ship.anchorX = anchor.x;
        ship.anchorY = anchor.y;
    } else {
        // Nothing left to guard: anchor on itself, so the leash is
        // never a cage around a position that no longer means anything.
        ship.anchorX = ship.x;
        ship.anchorY = ship.y;
    }
}

/** Scratch for the formation solve — reused, never allocated per call. */
const _slot = { x: 0, y: 0 };

/**
 * Where in the escort formation this fighter belongs.
 *
 * A trailing wedge: berths alternate left and right of the charge's
 * heading, each pair further back and wider than the last.
 *
 *            ·  ◂ slot 2
 *        ·          ◂ slot 0
 *     ▶ miner
 *        ·          ◂ slot 1
 *            ·  ◂ slot 3
 *
 * Anchored to the charge's *heading* rather than to the world, so the
 * formation turns with the ship it is guarding and a laden miner
 * coming home tows its escort round with it. When a miner is stopped
 * on a rock field its heading still means something — it is the last
 * direction it committed to — so the wedge stays put rather than
 * spinning, which is what a heading derived from velocity would do as
 * the miner's speed fell through zero.
 *
 * The wedge is deliberately *behind*. Escorts ahead of a miner would
 * screen the direction it is travelling, which sounds right and is
 * wrong here: a miner is attacked while it sits still and works, from
 * whichever side the enemy arrived, and a trailing wedge keeps the
 * escort out of the drones' working space around the rock face.
 */
function formationSlot(ship, charge, world, out) {
    const post = ESCORT_POSTS[ship.post] || ESCORT_POSTS.close;
    const slots = Math.max(1, ship.escortSlots);
    const slot = ship.escortSlot < 0 ? 0 : ship.escortSlot;

    // Spread across a forward-weighted arc rather than a fixed wedge.
    //
    // Slots map onto the arc by alternating outward from dead ahead —
    // 0, +1, -1, +2, -2 — so the first escort covers the charge's nose
    // and each additional one widens the screen symmetrically. Nothing
    // is ever posted directly astern, because nothing threatens a
    // miner from behind that has not already gone past its escort.
    const step = (Math.PI * ESCORT_FORWARD_BIAS) / Math.max(1, slots);
    const rank = Math.ceil(slot / 2) * (slot % 2 === 1 ? 1 : -1);
    const base = rank * step;

    // Its own slow breath, keyed off the hull's id so that no two in a
    // squadron drift together. This is the whole difference between a
    // formation and a diagram: the positions are *about* right, always,
    // and exactly right never.
    const phase = ship.id * 2.399963;
    const t = world.time * post.rate + phase;
    const bearing = charge.angle + base
        + Math.sin(t) * post.arc * 0.28
        + Math.sin(t * 0.41 + 1.7) * post.arc * 0.12;
    const radius = ESCORT_RADIUS * post.radius
        * (1 + Math.sin(t * 0.73 + 0.9) * post.drift);

    out.x = charge.x + Math.cos(bearing) * radius;
    out.y = charge.y + Math.sin(bearing) * radius;
}

/**
 * Hand out formation berths, deterministically and without state.
 *
 * The berth is this fighter's rank among its faction's escorts on the
 * same charge, ordered by id — so every hull computes the same answer
 * without anybody owning a roster, and ids never being reused means
 * the ordering is stable for as long as the group is.
 *
 * Recomputed only when `escortId` is refreshed, which is the same
 * few-seconds cadence that stops a fighter dithering between two
 * charges. Doing it per step would reshuffle the whole wedge every
 * time a hull died.
 */
function assignSlot(world, ship) {
    if (!ship.escortId) {
        ship.escortSlot = -1;
        ship.escortSlots = 0;
        return;
    }
    let rank = 0;
    let total = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const other = world.ships[i];
        if (other.dead || other.role !== ship.role) continue;
        if (other.factionId !== ship.factionId || other.escortId !== ship.escortId) continue;
        total++;
        if (other.id < ship.id) rank++;
    }
    ship.escortSlot = rank;
    ship.escortSlots = total;

    // A squadron is a spread of jobs, not three copies of one. The
    // first hull on a charge guards it closely, the second ranges
    // ahead as the picket, and everything after alternates outrider
    // and close — so a two-ship escort is a guard and a scout, and a
    // six-ship escort still has somebody sitting on the miner.
    ship.post = POST_ORDER[Math.min(rank, POST_ORDER.length - 1)];
}

/** Which post the nth escort on a charge takes. */
const POST_ORDER = ['close', 'picket', 'outrider', 'close', 'outrider', 'picket'];

/**
 * Who this swarm hull follows.
 *
 * The oldest surviving member of the wave it arrived with — lowest
 * id, which is stable, needs no coordination and promotes the next
 * hull automatically when the leader dies. A leader that follows
 * itself simply flies, and everything else flies formation on it, so
 * a squadron moves as one and dissolves only when it is dead.
 *
 * Squadrons are per *wave* rather than per faction: two incursions on
 * the board at once are two distinct groups crossing the map, which
 * reads far better than one enormous blob and costs nothing extra.
 */
function squadLeader(world, ship) {
    // The heaviest hull in the squad, not the oldest.
    //
    // It used to be the lowest id — whoever arrived first — which was
    // fine while a wave was one undifferentiated stream and actively
    // wrong once it started arriving in echelons: the light screen
    // comes through ahead of the capitals, so the *escorts* were the
    // leaders and the harvesters formed up around a swarmer.
    //
    // Ranked on radius because the swarm's hulls are all cost 0, and
    // tie-broken on id so a squad of identical hulls still agrees on
    // one of them and the choice is stable from step to step.
    let best = null;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== ship.factionId) continue;
        if (s.squadId !== ship.squadId || !s.def.speed) continue;
        if (!best
            || s.radius > best.radius
            || (s.radius === best.radius && s.id < best.id)) best = s;
    }
    // The leader anchors on itself; everyone else on the leader.
    return !best || best.id === ship.id ? 0 : best.id;
}

/**
 * The next place on a garrison's circuit.
 *
 * Every fixed thing the faction owns, taken in id order and stepped
 * through — so a hull that has just held the station goes to the shed
 * next, rather than re-rolling and often picking the same post twice
 * in a row. Different hulls start at different points because they
 * are built at different times, which spreads the guard across the
 * circuit without anybody coordinating it.
 */
function nextPost(world, ship) {
    const posts = [];
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== ship.factionId) continue;
        if (s.role !== 'mothership' && s.role !== 'outpost') continue;
        posts.push(s);
    }
    if (!posts.length) return 0;
    posts.sort((a, b) => a.id - b.id);

    // Whichever post is least guarded, rather than simply the next one
    // along.
    //
    // A round robin distributes hulls evenly *over time* and not at
    // any given moment, which is the only thing that matters to
    // something being raided: with everyone stepping through the same
    // ordered list on their own clocks, a shed can sit unattended
    // while three hulls hold the station. Counting what is already
    // assigned turns the circuit into a standing allocation that
    // happens to rotate, and forward stores stop being the posts
    // everybody is on their way to and away from.
    let best = null;
    let bestScore = Infinity;
    for (const p of posts) {
        if (posts.length > 1 && p.id === ship.escortId) continue;   // move on
        let guards = 0;
        for (let i = 0; i < world.ships.length; i++) {
            const g = world.ships[i];
            if (g.dead || g.id === ship.id || g.role !== 'fighter') continue;
            if (g.factionId !== ship.factionId || g.duty !== 'garrison') continue;
            if (g.escortId === p.id) guards++;
        }
        // A station can absorb more of the guard than a shed can use.
        const score = guards / (p.role === 'mothership' ? GARRISON_HOME_SHARE : 1);
        if (score < bestScore) { bestScore = score; best = p; }
    }
    return best ? best.id : posts[0].id;
}

/**
 * Should this hull be standing at the rally point rather than flying?
 *
 * True only while its faction has committed to a siege and has not
 * yet gathered enough of itself to leave. Hulls already in the fight
 * are exempt — a ship being shot at does not withdraw to form up.
 */
function siegeWaiting(ship, world) {
    const faction = world.faction(ship.factionId);
    if (!faction || faction.posture !== POSTURE.SIEGE || faction.siegeReady) return false;
    if (ship.duty === 'garrison') return false;    // not going, so not waiting
    return !acquire(ship, world);
}

/**
 * Has enough of the fleet gathered at the station to set out?
 *
 * Measured in metal-cost like every other strength figure, so a
 * corvette counts for what it is worth and a future destroyer will
 * too. Called from `muster`, which is where the waiting happens.
 */
function siegeRallied(world, faction, home) {
    if (!home) return true;                       // nowhere to gather; just go

    // Measured against the strength that is *eligible to go*, not the
    // whole fleet. The garrison is standing right there at the rally
    // point and will never leave it, so counting it on either side of
    // this comparison is wrong in a different way each time: include
    // it in the target and the rally can never complete, include it in
    // the gathered total and the wing departs the moment the home
    // guard exists.
    let expedition = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== faction.id) continue;
        if (!s.weapon && !s.mounts.length) continue;
        if (s.def.immobile || s.def.cost <= 0 || s.duty === 'garrison') continue;
        expedition += s.def.cost;
    }
    if (expedition <= 0) return true;
    return musteredExpedition(world, faction.id, home) >= expedition * SIEGE_RALLY_SHARE;
}

/** As `mustered`, counting only hulls that are actually going. */
function musteredExpedition(world, factionId, home) {
    let total = 0;
    const r2 = MUSTER_ALERT_RANGE * MUSTER_ALERT_RANGE;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== factionId || s.state !== MUSTER) continue;
        if (s.duty === 'garrison') continue;
        const dx = s.x - home.x, dy = s.y - home.y;
        if (dx * dx + dy * dy > r2) continue;
        total += s.def.cost;
    }
    return total;
}

/**
 * Is this hull's anchor an objective rather than a charge?
 *
 * The distinction the leash turns on: RAID and SIEGE point a hull at
 * something hostile, and everything else points it at something of
 * its own to protect.
 */
function onOffensive(ship, world) {
    const faction = world.faction(ship.factionId);
    if (!faction) return false;
    if (faction.posture === POSTURE.SIEGE || faction.posture === POSTURE.RAID) return true;
    // A hunting squadron is on the offensive whatever the faction's
    // posture says, and needs the same freedom to shoot what it meets
    // on the way — see the note in `acquire`.
    const charge = world.ship(ship.escortId);
    return !!charge && isHostile(world, ship.factionId, charge.factionId);
}

/**
 * The anchor a posture dictates, or null to use the ordinary escort.
 *
 * Returns a *ship* rather than a point so the caller stays one branch
 * — an enemy station is a hull like any other, and a defended home is
 * the hull the fighter would have fallen back to anyway.
 */
function postureAnchor(ship, world) {
    const faction = world.faction(ship.factionId);
    if (!faction) return null;

    // The home guard is not available to any posture. A siege takes
    // the striking half of a fleet; it does not take the last hull
    // standing over the station, which is the difference between an
    // offensive and an evacuation.
    //
    // But "not available to a posture" is not the same as "at home",
    // and reading it as the latter quietly deleted the entire garrison
    // circuit. `updateAnchor` picks a post, `nextPost` rotates it,
    // GARRISON_DWELL times it — and then this returned the station,
    // `patrol` acted on it first, and every guard orbited its own
    // mothership at exactly PATROL_RADIUS forever. Measured: garrison
    // hulls were assigned to an outpost 8,012 samples against 3,329 to
    // the station, and 97% of them were sitting at home, a median of
    // 1,575 units from the post they had been given.
    //
    // The fourth time this file has been caught by the same thing, and
    // the reason the note above `patrol`'s alarm branch exists: an
    // anchor bounds where a hull may fight and says nothing about
    // where it flies. The post *is* the garrison's anchor — which is
    // the station whenever the circuit says so, and a forward store
    // the rest of the time.
    if (ship.duty === 'garrison') {
        return world.ship(ship.escortId) || homeOf(world, ship);
    }

    if (faction.posture === POSTURE.SIEGE) {
        return faction.siegeReady ? nearestHostileStation(world, ship) : null;
    }
    if (faction.posture === POSTURE.DEFEND) return homeOf(world, ship);
    // RAID is the strike posture: go and break their economy.
    //
    // A faction that is merely ahead should not be committing to a
    // siege — that is what the much higher SIEGE_ENTER is for — but it
    // should not be sitting at home in formation either. Anchoring on
    // an enemy *miner* turns a modest advantage into pressure on the
    // thing that funds the other side, and it costs the raider the
    // escort it stopped providing, so a raid is a trade rather than a
    // free move.
    //
    // The in-and-out shape of it is already built: ENGAGE flies a
    // slicing pass and EXTEND loops back out, so a fighter that
    // arrives over a mining field strafes it repeatedly rather than
    // parking on it. And it ends by itself — kill the miners and the
    // ratio climbs into SIEGE, lose the exchange and it falls back to
    // EXPAND — which is what gives raids their come-and-go rhythm
    // without anything scheduling them.
    // Only the strike detachment raids, and only when the advantage is
    // clear. Both halves of that sentence were bought with a
    // measurement.
    //
    // The first version sent *every* fighter at the enemy's miners for
    // as long as the posture held, and RAID holds from a fairly modest
    // 1.4 ratio — so most of the time somebody's entire escort force
    // was away hunting, and both economies were being strip-mined at
    // once. Over twelve seeds it cut ore extracted by 22% and tripled
    // the ore destroyed in transit to 11% of everything mined, leaving
    // every faction in every seed ending the run on under eighty
    // metal. It read as balance — lopsidedness fell — and it was
    // really two sides equally unable to afford anything.
    //
    // A detachment keeps the disruption and gives back the economy.
    // Half the fleet presses the advantage while the other half stays
    // with the miners, which is also the shape the request described:
    // strikes *every now and then*, not a permanent evacuation of the
    // escort screen.
    // RAID used to hand strikers an enemy miner here. It no longer
    // needs to: hunting is a standing role now, so a striker already
    // *has* an enemy miner as its charge in every posture that allows
    // it. What RAID still changes is production — it is one of the
    // postures that buys corvettes — and the fact that a faction
    // pressing an advantage has more hulls to spare for the hunt.
    return null;
}

/**
 * The enemy station this fighter is closest to.
 *
 * A scan over factions rather than `1 - factionId`, so a third
 * faction — or an alliance — needs no change here. `isHostile` is the
 * one place that decides who counts.
 */
function nearestHostileStation(world, ship) {
    let best = null;
    let bestD2 = Infinity;
    for (let i = 0; i < world.factions.length; i++) {
        const other = world.factions[i];
        if (!isHostile(world, ship.factionId, other.id)) continue;
        for (let j = 0; j < other.motherships.length; j++) {
            const station = world.ship(other.motherships[j]);
            if (!station) continue;
            const d2 = (station.x - ship.x) ** 2 + (station.y - ship.y) ** 2;
            if (d2 < bestD2) { bestD2 = d2; best = station; }
        }
    }
    return best;
}

/**
 * True once a fighter has strayed further from its charge than it
 * should — and never true for a hull on the offensive.
 *
 * Every state that can abandon a fight consults this, and they have to
 * agree, because disagreeing produces a loop rather than a decision.
 * Lifting the leash in `patrol` alone did exactly that: `patrol`
 * acquired a target, `pursue` measured the same hull against its
 * anchor — an *enemy* miner it had not reached yet — found it off
 * leash and handed it straight back. Twelve thousand round trips per
 * run, in every seed, flagged by the recorder as ping-pong.
 *
 * A leash tethers you to what you are protecting. Nothing about an
 * objective tethers you to it, so a hunting party or a besieging
 * fleet has no leash at all, in any state.
 */
function offLeash(ship, world) {
    return dist(ship.x, ship.y, ship.anchorX, ship.anchorY) > leashRange(ship, world);
}

/**
 * How far this hull may operate from its anchor.
 *
 * One number for natives, a much shorter one for the swarm — see
 * SQUAD_LEASH. It is a function rather than a constant because the
 * *meaning* of the anchor differs: an escort's anchor is something it
 * is protecting and it may range widely to do that, while a swarm
 * hull's anchor is the formation it belongs to and leaving it is the
 * failure.
 */
function leashRange(ship, world) {
    return world.faction(ship.factionId)?.alien ? SQUAD_LEASH : ENGAGE_LEASH;
}

/** `offLeash`, with the offensive exemption applied. The one every state asks. */
function leashed(ship, world) {
    return !onOffensive(ship, world) && offLeash(ship, world);
}

/**
 * Which miner this fighter guards: near, and not already crowded.
 *
 * ------------------------------------------------------------
 * WHY IT IS NOT "THE MOST EXPOSED MINER"
 * ------------------------------------------------------------
 *
 * It used to be exactly that — the miner furthest from home, on the
 * reasoning that the most exposed one most needs guarding. That is
 * sound and it does not survive a large map, because *every* fighter
 * in a faction evaluates it and every one of them gets the same
 * answer. The whole escort force chased one hull, and the hull it
 * chased was by construction the most distant object on the map.
 *
 * Measured on the 7200×4200 world: the median distance from an escort
 * to its charge was **1,082 units** against an `ESCORT_RADIUS` of
 * 155, and an escort was within even twice its formation radius only
 * 11% of the time. Escorts were not escorting. They were commuting,
 * permanently, at full throttle — which is also the whole of why the
 * fleet looked like it could never slow down. A fighter more than
 * `slowRadius` from its berth is asking `arrive` for cruise speed,
 * and it was never closer than that.
 *
 * Scoring by distance *plus a crowding penalty* fixes both halves.
 * Escorts spread themselves across the miners that exist instead of
 * stacking on one, and each picks a charge it can actually reach — so
 * formations form, and a hull that has arrived is finally allowed to
 * throttle back.
 *
 * The exposure idea is not lost, just moved: `MINER_FLEE` already
 * brings an exposed miner home, and the RAID posture sends fighters
 * to the enemy's miners rather than orbiting their own.
 */
function pickCharge(world, ship) {
    const home = homeOf(world, ship);
    let best = 0;
    let bestScore = Infinity;

    // A striker's charge is somebody else's miner.
    //
    // Warships used to be escorts and nothing else — `pickCharge` only
    // ever returned a *friendly* miner, so in EXPAND, which is most of
    // a run, every hull a faction owned was tied to one of its own
    // three miners. Offence existed only as a posture: nothing ever
    // went hunting on its own initiative, and a faction with a healthy
    // economy and a full hangar simply stood over it.
    //
    // Making the hunt a standing *role* rather than a posture is what
    // produces squadrons. The crowding term below is what sizes them:
    // a handful of strikers spread across the two or three enemy
    // miners actually out working end up two or three to a target,
    // which is a raiding party rather than either a lone hull or the
    // whole fleet. Nobody specifies the number; it falls out of how
    // many hunters there are and how many things there are to hunt.
    const hunting = ship.striker && huntingAllowed(world, ship);

    for (let i = 0; i < world.ships.length; i++) {
        const miner = world.ships[i];
        if (miner.dead) continue;
        // Miners, and — when guarding rather than hunting — the
        // freight too.
        //
        // A hauler is not a miner and so was never a candidate, which
        // meant the single most valuable hull either side puts on the
        // board crossed open map alone for the entire run: measured,
        // freighters were escorted 0 times out of 683 samples. That is
        // not a tuning miss, it is a category the escort code could
        // not see. THREAT_WEIGHT has ranked a laden hauler above a
        // miner since the day freight existed; only the code that
        // assigns guards disagreed.
        //
        // Excluded when hunting, because a striker's business is the
        // enemy's *economy at work* — a raider that peels off to chase
        // freight is one that stops pressuring the mining.
        const guardable = miner.role === 'miner' || (!hunting && miner.role === 'hauler');
        if (!guardable) continue;
        if (hunting
            ? !isHostile(world, ship.factionId, miner.factionId)
            : miner.factionId !== ship.factionId) continue;

        // A parked hauler needs nobody. Freight is worth guarding when
        // it is carrying something across open space, which is exactly
        // the window in which it can be lost.
        if (miner.role === 'hauler' && miner.cargo <= CARGO_EPSILON) continue;

        // How many of our escorts have already claimed this one.
        let taken = 0;
        for (let j = 0; j < world.ships.length; j++) {
            const other = world.ships[j];
            if (other.dead || other.role !== ship.role || other.id === ship.id) continue;
            if (other.factionId === ship.factionId && other.escortId === miner.id) taken++;
        }

        // Exposure survives as a *weight* rather than as the rule.
        //
        // Dropping it entirely was an over-correction, and a measured
        // one: escorts settled onto whichever miner happened to be
        // nearest, which is usually the one working close to home, and
        // in three of twelve seeds the two sides stopped meeting
        // altogether — one fighter held `patrol` for 622 seconds and
        // both factions banked eighteen hundred metal apiece. A war
        // that has quietly stopped is not a balanced war.
        //
        // The original instinct was right and its arithmetic was not:
        // guarding the most exposed miner is correct, picking it by a
        // maximum means every fighter picks the same one. As a
        // discount against distance it pulls the screen outward into
        // contested space while the crowding term still spreads it.
        // Exposure — how far a miner is from *our* station — is a
        // reason to guard it and means nothing when hunting. A prey
        // miner is scored on reach and on how many of us are already
        // going for it.
        const exposure = hunting || !home ? 0 : dist(miner.x, miner.y, home.x, home.y);

        // Cohesion when hunting, crowding when guarding. See the note
        // on SQUADRON_SIZE — a party still short of its number pulls
        // hulls in, and one that has its number pushes them away to
        // start the next.
        const company = hunting
            ? (taken < SQUADRON_SIZE ? -taken * HUNT_COHESION
                : (taken - SQUADRON_SIZE + 1) * ESCORT_CROWDING)
            : taken * ESCORT_CROWDING;

        const score = dist(ship.x, ship.y, miner.x, miner.y)
            + company
            - exposure * ESCORT_EXPOSURE;
        if (score < bestScore) { bestScore = score; best = miner.id; }
    }

    // Nothing to hunt — the enemy has no miners out. A striker with no
    // prey falls back to escort duty rather than loitering, which also
    // means a faction that has wiped out the opposing economy quietly
    // turns its hunters back into guards.
    if (!best && hunting) {
        const wasStriker = ship.striker;
        ship.striker = false;
        best = pickCharge(world, ship);
        ship.striker = wasStriker;
    }
    return best;
}

/**
 * May this hull go hunting right now?
 *
 * Not while the faction is defending its own station or has lost its
 * economy — both are situations where every hull is needed at home,
 * and a raiding party away from the fight is worse than useless.
 */
function huntingAllowed(world, ship) {
    const faction = world.faction(ship.factionId);
    if (!faction) return false;
    return faction.posture !== POSTURE.DEFEND && faction.posture !== POSTURE.REBUILD;
}

/**
 * Vector in toward target at high speed until within attack run distance.
 */
function pursue(ship, world, dt) {
    const target = world.ship(ship.targetId);
    if (!target) { setState(ship, PATROL, 'target-gone'); return; }

    const d = dist(ship.x, ship.y, target.x, target.y);

    // Break off if the target has outrun us, or if the chase has
    // pulled us off our charge.
    const strayed = leashed(ship, world);
    if (d > ENGAGE_RADIUS * PURSUE_DROP || strayed) {
        ship.targetId = 0;
        setState(ship, PATROL, strayed ? 'off-leash' : 'outrun');
        return;
    }

    // Enter attack run when closing within range
    if (d <= weaponReach(ship) * 1.1) {
        setState(ship, ENGAGE, 'in-range');
        return;
    }

    seek(ship, target.x, target.y);
    acquire(ship, world);
}

/**
 * High-speed fly-by attack pass.
 *
 * Accelerates flat-out on an intercept course toward an offset pass point,
 * aims lead shots while in weapon range, and zooms past the target.
 */
function engage(ship, world, dt) {
    const target = world.ship(ship.targetId);
    if (!target) { setState(ship, PATROL, 'target-destroyed'); return; }

    if (leashed(ship, world)) {
        ship.targetId = 0;
        setState(ship, PATROL, 'off-leash');
        return;
    }

    const d = dist(ship.x, ship.y, target.x, target.y);
    if (d > ENGAGE_RADIUS * PURSUE_DROP) { setState(ship, PURSUE, 'target-opened'); return; }

    // 1. Calculate lead intercept point
    interceptPoint(ship.x, ship.y, target.x, target.y, target.vx, target.vy, weaponSpeed(ship), _lead);

    // 2. Calculate fly-by pass point offset laterally from the target
    const dx = _lead.x - ship.x;
    const dy = _lead.y - ship.y;
    const leadDist = Math.hypot(dx, dy) || 1;
    const px = -dy / leadDist;
    const py = dx / leadDist;
    const offset = target.radius + FIGHTER_PASS_OFFSET;
    const passDir = ship.passDir || 1;
    const passX = _lead.x + px * offset * passDir;
    const passY = _lead.y + py * offset * passDir;

    // 3. Accelerate flat out along the attack vector
    seek(ship, passX, passY);

    // 4. Track the lead solution while it is trackable, and fire.
    //
    // The nose is only pinned to the solution while the hull could
    // plausibly get there — see AIM_TRACK_CONE. Beyond that the demand
    // exceeds the turn rate, saturates it, and reverses as the target
    // crosses the bow, which is exactly the snapping this state used
    // to produce. Releasing the aim lets the hull fly nose-first
    // through the pass instead, which is both smooth and the thing a
    // fly-by is supposed to look like.
    const aim = Math.atan2(_lead.y - ship.y, _lead.x - ship.x);
    const off = Math.abs(angleDelta(ship.angle, aim));
    ship.aimAngle = off < AIM_TRACK_CONE ? aim : null;

    if (d <= weaponReach(ship) && off < FIRE_CONE) {
        tryFire(world, ship, aim);
    }

    // 5. Detect fly-by completion: relative opening velocity or close pass
    const rx = ship.x - target.x, ry = ship.y - target.y;
    const rvx = ship.vx - target.vx, rvy = ship.vy - target.vy;
    const opening = rx * rvx + ry * rvy;

    const timedOut = ship.stateTime > FIGHTER_RUN_TIMEOUT;
    const pointBlank = d <= target.radius + FIGHTER_POINT_BLANK;
    const passed = (opening > 0 && d < weaponReach(ship) * FIGHTER_BREAKOFF)
        || pointBlank || timedOut;

    if (passed) {
        // Which of the three conditions ended the run is the whole
        // question when passes start looking wrong: a timeout means
        // the fighter never actually got there.
        setState(ship, EXTEND, timedOut ? 'run-timed-out'
            : pointBlank ? 'point-blank' : 'flew-past');
    }

    acquire(ship, world);
}

/**
 * Break away and zoom past the target to gain separation before re-engaging.
 *
 * The distance is a fraction of this fighter's *own* weapon range and
 * has to exceed the fraction that ended the run, or the state is a
 * formality: arrive already past the threshold, leave on the same
 * step, and the "loop back round" is a turn on the spot. It was
 * exactly that — 72% of extensions lasted one step — for as long as
 * the two numbers were unrelated. See FIGHTER_EXTEND in constants.js.
 */
function extend(ship, world, dt) {
    const target = world.ship(ship.targetId);

    // Let nose trail flight path with main engines burning forward
    ship.aimAngle = null;

    // Carry forward momentum and boost outward
    const speed = Math.hypot(ship.vx, ship.vy) || 1;
    seek(ship, ship.x + (ship.vx / speed) * 200, ship.y + (ship.vy / speed) * 200);

    const d = target ? dist(ship.x, ship.y, target.x, target.y) : Infinity;

    // Once sufficient extension separation is achieved (or timed out), turn back for next pass
    if (d >= weaponReach(ship) * FIGHTER_EXTEND || ship.stateTime >= FIGHTER_EXTEND_TIMEOUT || !target) {
        // Alternate pass side for next run
        ship.passDir = -(ship.passDir || 1);

        if (!target || leashed(ship, world)) {
            ship.targetId = 0;
            setState(ship, PATROL, target ? 'off-leash' : 'target-gone');
        } else {
            // Re-engage for next fly-by pass
            setState(ship, ENGAGE, 'next-pass');
        }
    }
}

/**
 * Break off, go home, and repair.
 *
 * Repair only happens while docked, so a damaged fighter has to
 * actually leave. Whether that thins an attacking wave depends on
 * `RETREAT_HP` landing on a hull value a fighter can survive at, and
 * for a long time it did not: the threshold sat between two rungs of
 * the damage quantum, so hulls arrived here with less left than one
 * more round and 65% of retreats ended in death inside half a second.
 * The long note on RETREAT_HP in core/constants.js has the arithmetic.
 *
 * It does not shoot back or evade, and that is not the gap it looks
 * like. Retreats that begin with hull to spare already succeed — 57%
 * for fighters leaving above 18% — and the ones that fail mostly fail
 * before a weapon could have helped.
 */
function regroup(ship, world, dt) {
    // Patch up at the nearest friendly structure, not only at home.
    //
    // A damaged hull used to have exactly one place to go, and on a
    // 7,200-unit map that made retreating usually fatal: over 1,300
    // seconds on one seed, thirty-five fighters entered REGROUP and
    // *one* came out. The rest were caught crossing open space at a
    // third of their hull. The mechanism was not failing to fire — it
    // was firing into a journey nobody survives.
    //
    // A forward store cannot repair itself, but it can certainly
    // service a fighter, and it is already sitting where the fighting
    // is. That shortens the retreat from a map crossing to a short hop
    // and gives the outpost a third job worth defending it for.
    const home = depositPoint(world, ship, 0) || homeOf(world, ship);
    if (!home) {
        // Nowhere to run to. Fight on.
        wander(ship, world, dt, 0.4);
        if (ship.weapon && acquire(ship, world)) setState(ship, PURSUE, 'nowhere-to-regroup');
        return;
    }

    const d = dist(ship.x, ship.y, home.x, home.y);
    const dock = home.radius + 70;

    if (d > dock) {
        arrive(ship, home.x, home.y, 220);
        return;
    }

    orbit(ship, home.x, home.y, dock, ship.orbitDir, 0.35);
    ship.hp = Math.min(ship.maxHp, ship.hp + HULL_REPAIR_RATE * dt);

    if (ship.hp >= ship.maxHp * REJOIN_HP) setState(ship, PATROL, 'repaired');
}

// ------------------------------------------------------------

/**
 * Refresh the current target on an interval.
 *
 * Throttled rather than run every step for two reasons: it is a
 * broadphase query per fighter, and a fighter that re-picks every
 * frame flip-flops between two equally-scored targets and never
 * commits to either.
 */
function acquire(ship, world) {
    const current = world.ship(ship.targetId);
    if (current && world.time < ship.retargetAt) return true;

    ship.retargetAt = world.time + FIGHTER_RETARGET;

    // The leash bounds the *search*, not just the decision to search,
    // and that is the gate that actually blinded besiegers.
    //
    // `pickTarget` discards any candidate further than `leash` from the
    // anchor, so a hull whose anchor is an enemy station rejected
    // everything it met on the way there — a fighter shooting it from
    // fifty units away was, correctly by the arithmetic and absurdly
    // in fact, "too far from the objective to be worth engaging". 78%
    // of besiegers with an enemy inside weapon range held no target at
    // all. Lifting the earlier `offLeash` check alone changed nothing,
    // because this is where the filtering happens.
    //
    // On the offensive the hull anchors the search on *itself*: what I
    // can see, I may shoot. There is nothing to be dragged away from —
    // the objective is a destination, and the fight in front of you is
    // on the way to it.
    const offensive = onOffensive(ship, world);
    const found = offensive
        ? pickTarget(world, ship, ENGAGE_RADIUS, ship.x, ship.y, ENGAGE_RADIUS)
        : pickTarget(world, ship, ENGAGE_RADIUS,
            ship.anchorX, ship.anchorY, leashRange(ship, world));
    ship.targetId = found ? found.id : 0;
    return !!found;
}
