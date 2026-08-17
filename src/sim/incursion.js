// ============================================================
// INCURSION — SOMETHING ARRIVES
// ============================================================
//
// Every so often a swarm drops out of warp in the middle of the map
// and both factions stop shooting each other to deal with it.
//
// ------------------------------------------------------------
// ARRIVAL IS SOMETHING SHIPS DO
// ------------------------------------------------------------
//
// There is no portal. Hulls drop in one after another, each already
// travelling several times faster than it can fly, and each sheds
// that speed over the next second and a half — a flash, a long
// streak because it is genuinely moving that fast, and a hard
// deceleration you can watch bleed off.
//
// This replaced a lens-shaped rift that widened, held and sealed.
// That version put all of its drama into the geometry of a hole and
// none into the ships, which is exactly backwards: what makes an
// arrival exciting is watching something come in far too fast and
// haul itself down to fighting speed, and a portal is just scenery
// that happens near where it occurs.
//
// The speed is on the velocity rather than on the renderer, which is
// why it reads: a hull overshoots slightly, settles, and only then
// starts behaving. `warpT` exists solely so the effects and the hull
// renderer know how much of that is left.
//
// ------------------------------------------------------------
// WHAT IT DOES TO THE OTHER TWO
// ------------------------------------------------------------
//
// `isHostile` stops treating the natives as enemies while a swarm is
// on the board. That is the whole truce, and it is two lines because
// every hostility check in the project already routes through that
// one function — target selection, projectile collision, the miner's
// threat scan, posture and escort assignment all learned about
// alliances without being told.

import { EV } from '../core/events.js';
import { makeShip } from './entities.js';
import { FACTIONS } from '../data/factions.js';
import {
    INCURSION_FIRST, INCURSION_EVERY, INCURSION_VARIANCE,
    INCURSION_WAVE, INCURSION_GROWTH, TRUCE_GRACE,
    INCURSION_MIN_SCALE, INCURSION_MAX_SCALE, INCURSION_MAX_GROWTH, INCURSION_RESPONSE,
    WARP_SPEED, WARP_ARREST, ARRIVAL_SPACING, ARRIVAL_WINDOW, ARRIVAL_SPREAD,
    ARRIVAL_FILE, ARRIVAL_RANK, ARRIVAL_JITTER, HARVESTER_SHARE,
    ECHELON_GAP, ECHELON_DEPTH, ECHELON_SCREEN,
} from '../core/constants.js';

/** The alien faction id, resolved once from the roster. */
const SWARM = FACTIONS.find((f) => f.alien)?.id ?? -1;

/** Fresh incursion state. Held on the world so two worlds cannot share a schedule. */
export function makeIncursion(world) {
    return {
        nextAt: INCURSION_FIRST + world.rng.range(-INCURSION_VARIANCE, INCURSION_VARIANCE),
        count: 0,
        /** The wave currently dropping in, or null. */
        arrival: null,
    };
}

/**
 * Advance the schedule, the wave in progress, and the truce.
 *
 * The truce holds for a grace period after the last alien dies, so
 * the natives do not resume shooting each other across a battlefield
 * they are still standing on — a ceasefire that ends on the same step
 * as the last kill reads as a switch being thrown.
 */
export function stepIncursion(world, dt) {
    if (SWARM < 0) return;
    const inc = world.incursion;

    let aliens = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (!s.dead && s.factionId === SWARM) aliens++;
    }
    if (aliens > 0) world.lastAlienAt = world.time;
    world.truce = aliens > 0 || (world.time - world.lastAlienAt) < TRUCE_GRACE;

    if (inc.arrival) {
        stepArrival(world, inc, dt);
    } else if (world.time >= inc.nextAt) {
        beginIncursion(world, inc);
    }

    arrestWarp(world, dt);
}

/**
 * Bleed off arrival speed.
 *
 * Exponential rather than linear, so a hull loses most of it in the
 * first half second and then eases into cruise — a linear stop reads
 * as a ship hitting a wall. Runs over every hull rather than only the
 * swarm's, because arriving under power is a *capability*, and the
 * first native reinforcement that warps in should get it free.
 */
function arrestWarp(world, dt) {
    const k = Math.exp(-WARP_ARREST * dt);
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.warpT <= 0) continue;

        // Only arrest what is *above* the hull's own cruise. Braking
        // the whole velocity would leave it drifting to a stop and
        // then accelerating again, which looks like indecision; this
        // way it slides down onto its normal speed and keeps flying.
        //
        // `warpT` is driven by the *speed still to lose*, not by a
        // timer. A timer let it reach zero while the hull was still
        // travelling at five times cruise, which handed the speed cap
        // back to `applyMotion` mid-arrival and deleted the rest of
        // the deceleration in a single step.
        const speed = Math.hypot(s.vx, s.vy);
        const cruise = s.def.speed || 1;
        if (speed <= cruise * 1.02) { s.warpT = 0; s.vx *= 0.999; s.vy *= 0.999; continue; }
        s.warpT = Math.min(1, (speed - cruise) / (cruise * (WARP_SPEED - 1)));

        const target = cruise + (speed - cruise) * k;
        const scale = target / speed;
        s.vx *= scale;
        s.vy *= scale;
    }
}

/**
 * How many hulls come through.
 *
 * Three terms, and they answer different questions. The *base* is the
 * schedule — each incursion is nominally larger than the last. The
 * *response* is what is actually on the board, so a late wave arriving
 * into two mature fleets is sized against them rather than against a
 * number decided at the start of the run. The *scatter* is what stops
 * the whole thing being predictable, and it widens over time: early
 * incursions vary a little, late ones can be a third of nominal or
 * more than twice it.
 *
 * Exported so the controls panel can show what it would send, and so
 * a manual incursion can override it outright.
 */
export function waveSize(world, index, override = 0) {
    if (override > 0) return Math.max(1, Math.round(override));

    const base = INCURSION_WAVE + (index - 1) * INCURSION_GROWTH;

    // Everything armed and mobile, both factions — the swarm is
    // everyone's enemy, so the whole board is what it must get through.
    let onBoard = 0;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId === SWARM) continue;
        if (!s.def.cost || s.def.immobile) continue;
        if (!s.weapon && !s.mounts.length) continue;
        onBoard += s.def.cost;
    }

    const hi = INCURSION_MAX_SCALE + (index - 1) * INCURSION_MAX_GROWTH;
    const scatter = world.rng.range(INCURSION_MIN_SCALE, hi);
    return Math.max(2, Math.round((base + onBoard * INCURSION_RESPONSE) * scatter));
}

/** Choose where the wave comes in, and how big it is. */
function beginIncursion(world, inc) {
    inc.count++;
    const wave = waveSize(world, inc.count);

    // Central, because the point of the thing is that it is
    // everybody's problem. A swarm arriving in a corner is one
    // faction's inconvenience.
    const x = world.width * 0.5 + world.rng.spread(world.width * 0.16);
    const y = world.height * 0.5 + world.rng.spread(world.height * 0.22);

    inc.arrival = makeArrival(world, x, y, wave, inc.count);
    world.events.emit(EV.INCURSION, {
        wave, index: inc.count, x, y, heading: inc.arrival.heading,
    });
}

/**
 * Split a wave into echelons.
 *
 * ------------------------------------------------------------
 * WHY A WAVE HAS PARTS
 * ------------------------------------------------------------
 *
 * The whole wave used to arrive as one continuous stream with the
 * heavies rolled in at random, which read as a line of ships being
 * extruded from a point. Nothing about it said *fleet*.
 *
 * A wave now comes through in groups, with a pause and a gap in
 * depth between them: a screen of light hulls first, then the heavies
 * a beat later and further back, then whatever is left. That is a
 * sequence rather than a stream — you see the escort arrive, you see
 * the thing it is escorting arrive behind it, and because
 * `squadLeader` picks the heaviest hull in the squad the screen then
 * forms up around the capitals of its own accord.
 *
 * The composition is deliberate rather than rolled. HARVESTER_SHARE
 * still decides *how many* heavies, but they now arrive together as
 * an identifiable group instead of being sprinkled through the
 * stream, which is what makes them read as the point of the wave.
 */
function planWave(world, wave) {
    const heavies = Math.min(
        Math.max(1, Math.round(wave * HARVESTER_SHARE)),
        Math.max(1, Math.floor(wave * 0.4)));
    const lights = Math.max(0, wave - heavies);

    // Most of the escort leads; the rest closes up behind the heavies.
    const screen = Math.round(lights * ECHELON_SCREEN);
    const rear = lights - screen;

    // The pause is measured from when the previous echelon *finishes*,
    // not from the start of the wave.
    //
    // As an absolute time it silently vanished on any wave big enough
    // to want it: a screen of eleven hulls takes about five seconds to
    // come through, by which point a start time of three seconds is
    // long past and the heavies followed with no pause at all. A wave
    // of six had the beat and a wave of forty did not, which is
    // exactly backwards.
    const groups = [];
    const gap = () => ECHELON_GAP + world.rng.range(0, ECHELON_GAP * 0.5);

    if (screen > 0) groups.push({ type: 'swarmer', count: screen, gapBefore: 0, along: 0 });
    if (heavies > 0) {
        groups.push({
            type: 'harvester', count: heavies,
            gapBefore: groups.length ? gap() : 0,
            along: -ECHELON_DEPTH,
        });
    }
    if (rear > 0) {
        groups.push({
            type: 'swarmer', count: rear,
            gapBefore: groups.length ? gap() : 0,
            along: -ECHELON_DEPTH * 1.7,
        });
    }
    // A wave too small to divide still arrives as one thing.
    return groups.length ? groups : [{ type: 'swarmer', count: wave, gapBefore: 0, along: 0 }];
}

function stepArrival(world, inc, dt) {
    const a = inc.arrival;
    a.t += dt;

    const group = a.groups[a.group];
    if (!group) { finishArrival(world, inc); return; }

    // Each echelon waits out its own gap, then runs at its own cadence.
    if (a.t < a.nextAt) return;

    dropIn(world, a, group);
    // The bigger the group, the tighter the gap — so a wave of eighty
    // is a torrent and a wave of five is a trickle, but each echelon
    // is over inside the same window.
    a.nextAt = a.t + Math.min(ARRIVAL_SPACING, ARRIVAL_WINDOW / Math.max(1, group.count));

    if (a.inGroup >= group.count) {
        a.group++;
        a.inGroup = 0;
        const next = a.groups[a.group];
        // The beat between echelons, counted from now.
        if (next) a.nextAt = a.t + next.gapBefore;
    }
    if (a.spawned >= a.wave || a.group >= a.groups.length) finishArrival(world, inc);
}

function finishArrival(world, inc) {
    inc.arrival = null;
    inc.nextAt = world.time + INCURSION_EVERY
        + world.rng.range(-INCURSION_VARIANCE, INCURSION_VARIANCE);
}

/**
 * One hull, arriving under way on the wave's shared bearing.
 *
 * Scattered *across* the line of travel rather than around the drop
 * point, and staggered *along* it by arrival order — so the wave
 * forms up as a broad front trailing back the way it came, instead of
 * a cloud with a ship somewhere in it. The lateral spread is what
 * makes it a formation; the along-track stagger is what stops six
 * hulls occupying the same hundred units and shoving each other apart
 * on their first step.
 */
function dropIn(world, a, group) {
    const type = group.type;
    const heading = a.heading;

    const px = Math.cos(heading), py = Math.sin(heading);

    // A block, not a queue. `perRank` grows as the square root of the
    // wave, so a wave twice the size comes in about 1.4x wider and
    // 1.4x deeper rather than twice as long — which is what keeps a
    // big incursion in the same patch of sky as a small one.
    const perRank = Math.max(3, Math.round(Math.sqrt(group.count * 2.2)));
    const rank = Math.floor(a.inGroup / perRank);
    const file = a.inGroup % perRank;

    // Centred on the bearing, so the formation grows outward from the
    // drop point in both directions instead of off to one side — and
    // jittered in both axes, because a perfect lattice is the other
    // way a fleet reads as extruded rather than flown.
    const lateral = (file - (perRank - 1) * 0.5) * ARRIVAL_FILE
        + world.rng.spread(ARRIVAL_FILE * ARRIVAL_JITTER);
    const along = -260 + group.along - rank * ARRIVAL_RANK
        + world.rng.spread(ARRIVAL_RANK * ARRIVAL_JITTER);

    const x = a.x - py * lateral + px * along;
    const y = a.y + px * lateral + py * along;

    const ship = makeShip(world, type, SWARM, x, y, heading);
    ship.homeId = 0;
    // Everything that came through together stays together. See
    // `squadLeader` — without it a swarm hull had no miner to escort
    // and no station to orbit, so `patrol` fell through to `wander`
    // and a wave dissolved into a dozen ships drifting on their own
    // errands within about fifteen seconds of arriving.
    ship.squadId = a.squad;
    // Already there. No spawn fade — a hull that materialises gently
    // is a hull that was never travelling, and the flash is the
    // arrival, not the fade.
    ship.fade = 1;
    ship.warpT = 1;

    const speed = ship.def.speed * WARP_SPEED;
    ship.vx = Math.cos(heading) * speed;
    ship.vy = Math.sin(heading) * speed;

    world.addShip(ship);
    a.spawned++;
    a.inGroup++;

    world.events.emit(EV.WARP_IN, { ship, x, y, angle: heading });
    world.events.emit(EV.SHIP_SPAWNED, { ship });
}

/**
 * Bring a wave in on demand, at a chosen place.
 *
 * Exported for the controls panel: an incursion is the most dramatic
 * thing the simulation does and it happens twice in twenty minutes,
 * which is an impossible cadence to iterate a *visual* against.
 */
export function triggerIncursion(world, x, y, wave = 0) {
    if (SWARM < 0) return 0;
    world.incursion.count++;
    // Zero means "whatever the schedule would have sent", so the panel
    // button and the real thing agree unless a size is asked for.
    const size = wave || waveSize(world, world.incursion.count);

    // Built by the same function the scheduled path uses.
    //
    // It used to assemble the arrival object itself, as a literal that
    // happened to match. That is fine until the shape gains a field:
    // waves became echelons, `beginIncursion` learned about `groups`,
    // and this — the one path a *person* can invoke, on purpose, from
    // the controls panel — kept building the old shape and crashed
    // `stepArrival` on the next step. Two constructors for one object
    // is one too many.
    world.incursion.arrival = makeArrival(world, x, y, size, world.incursion.count);
    world.events.emit(EV.INCURSION, {
        wave: size, index: world.incursion.count, x, y,
        heading: world.incursion.arrival.heading,
    });
    return size;
}

/**
 * The arrival record for one wave: where it comes in, on what bearing,
 * and the echelons it comes in as.
 *
 * The single place that shape is defined, so the scheduled incursion
 * and the manually triggered one cannot drift apart.
 */
function makeArrival(world, x, y, wave, squad) {
    return {
        x, y, wave, squad,
        // One bearing for the whole wave.
        //
        // Rolled once rather than per hull, and that is the whole
        // difference between a fleet and a coincidence. With a heading
        // per ship a wave arrived from every direction at once — six
        // hulls crossing the same patch of sky on six unrelated
        // courses, which reads as spawning rather than as an
        // incursion. On one bearing it is a formation sweeping in, and
        // both factions can see which way it came from and where it is
        // going.
        heading: world.rng.angle(),
        spawned: 0,
        nextAt: 0,
        t: 0,
        groups: planWave(world, wave),
        group: 0,
        inGroup: 0,
    };
}
