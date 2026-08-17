// ============================================================
// WORLDGEN — SETUP AND FIELD RENEWAL
// ============================================================
//
// Places the factions, their motherships, and the asteroid fields
// they will fight over. Also owns field *renewal*, because a
// simulation meant to be watched indefinitely cannot be allowed to
// mine itself to a standstill.
//
// ------------------------------------------------------------
// WHY FIELDS RATHER THAN SCATTERED ROCKS
// ------------------------------------------------------------
//
// Ore is placed in clusters, not spread evenly. Clustering is what
// creates the economic geography the whole simulation runs on:
// somewhere worth going, a reason to commit a miner to it, a
// reason for that commitment to be worth defending, and eventually
// a reason to leave. Evenly scattered ore would let every miner
// work next to its own doorstep and nothing would ever meet.
//
// ------------------------------------------------------------
// RENEWAL
// ------------------------------------------------------------
//
// An exhausted field waits, then reappears *somewhere else*. Ore
// never comes back where it was spent, so the map's centre of
// gravity keeps shifting and miners keep having to travel. Rocks
// fade in over a couple of seconds; nothing in this project pops
// into existence.

import { FACTIONS, makeFactionState, isPlayed } from '../data/factions.js';
import { makeShip, makeAsteroid } from './entities.js';
import {
    ASTEROID_FIELDS, ASTEROIDS_PER_FIELD_MIN, ASTEROIDS_PER_FIELD_MAX,
    FIELD_SCATTER, FIELD_MIN_SEPARATION, FIELD_MOTHERSHIP_CLEARANCE,
    ASTEROID_RESPAWN_DELAY, ASTEROID_RESPAWN_FADE,
    ASTEROID_ORE_MIN, ASTEROID_ORE_MAX,
    MOTHERSHIP_EDGE_INSET, START_METAL, WORLD_EDGE_MARGIN,
    FACTION_RESPAWN_DELAY,
    HOME_FIELD_RANGE, HOME_FIELD_ROCKS_MIN, HOME_FIELD_ROCKS_MAX,
    FIELD_CAPACITY_MIN, FIELD_CAPACITY_MAX,
    TRADE_HUB_INSET, SANCTUARY_RADIUS,
    ORE_GRADIENT_REACH, ORE_GRADIENT_FLOOR, ASTEROID_RESPAWN_CONTEST,
    OPENING_FLEET, OPENING_STANDOFF,
} from '../core/constants.js';
import { dist2, lerp } from '../core/math.js';

/** Build a whole world: factions, motherships, ore. */
export function generateWorld(world) {
    world.factions.length = 0;
    world.fields = [];

    for (const def of FACTIONS) {
        const state = makeFactionState(def);
        state.metal = START_METAL;
        world.factions.push(state);
    }

    for (const def of FACTIONS) {
        // The swarm has no station, no home field and no economy — it
        // arrives through a rift and leaves through nothing. Skipping
        // it here is the only place worldgen has to know it exists.
        if (!isPlayed(def)) continue;
        const ship = placeMothership(world, def);
        ship.fade = 1;              // the map's fixed points are simply there
        placeHomeField(world, ship);
        placeOpeningFleet(world, ship);
    }

    placeExchange(world);

    for (let i = 0; i < ASTEROID_FIELDS; i++) {
        const field = makeField(world.fields.length);
        if (!placeField(world, field)) continue;
        world.fields.push(field);
        spawnField(world, field);
    }
}

/**
 * A field record.
 *
 * `id` is the index into `world.fields`, and both of the simulation's
 * references to a field — `rock.fieldId` and `miner.claimId` — are
 * that index. So it has to come from the array's current length
 * rather than from a loop counter: placement can fail, a field that
 * fails is never pushed, and a run that lost one to a crowded map
 * would otherwise leave every later field answering to somebody
 * else's id. `tests/guards.test.js` asserts the invariant directly.
 *
 * `ore` and `rocks` are recomputed every step by `updateFields`, so
 * miners can compare fields without rescanning the asteroid list once
 * per miner per decision.
 *
 * Claims are stored **per faction**, indexed by faction id. A single
 * shared slot looked equivalent and was not: enemy claims are
 * deliberately ignored — see the header of `behaviors/miner.js`, it is
 * what makes two factions meet over the same rocks — so with one slot
 * each side simply overwrote the other's every step, and neither
 * side's miners could coordinate with their *own*. It measured at
 * 1,662 re-claims for 37 deliveries, and read on screen as ordinary
 * traffic.
 */
function makeField(id) {
    return {
        id,
        x: 0, y: 0,
        emptyAt: -1,       // world time the field ran dry; -1 while it holds ore
        ore: 0,
        rocks: 0,
        /**
         * Centre of mass of the rocks that are *still there*, refreshed
         * every step by `updateFields`.
         *
         * Distinct from `x`/`y`, which is where the cluster was placed
         * and never moves. A field is eaten from the middle outward, so
         * the two drift apart as it is worked — and a miner holding
         * station on the nominal centre ends up just too far from the
         * survivors to reach them. Measured: 64 of 65 stalled drones sat
         * beside a field that still held ore whose nearest rock was
         * 251-273 units away, against a MINING_RADIUS of 250.
         */
        cx: 0, cy: 0,
        claimedBy: [],     // miner id working this field, per faction id
        claimedAt: [],     // world time that claim was last renewed, per faction id
        /**
         * How large this cluster is, as a multiplier on rock count and
         * ore per rock. Rolled once when the field is placed and kept
         * through every respawn, so a rich field stays a rich field —
         * the map has landmarks rather than interchangeable dots.
         */
        capacity: 1,
        // A home field belongs to one faction and never moves. Both
        // are false/-1 for the contested fields, which are nobody's
        // and relocate every time they are stripped.
        home: false,
        factionId: -1,
    };
}

/**
 * Give a faction a small, poor field inside its own guns.
 *
 * ------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------
 *
 * Because the simulation's worst failure mode is not losing — it is
 * being held at zero, and the measurements say the binding constraint
 * is miner *survival* rather than miner cost.
 *
 * A miner launched while its faction is four hulls or more behind
 * lived a median of 18 seconds, against 284 seconds when the fleets
 * were level. That is a sixteenfold swing off a single variable, and
 * it is why funding a rebuild does not rescue anyone: a faction can
 * be handed the 40 metal and still watch the replacement die before
 * it reaches a rock. `docs/03-SIMULATION.md` §5 puts it plainly — a
 * fifth mechanism has to protect the rebuild rather than pay for it.
 *
 * So: somewhere to work that is already defended. The station's own
 * battery reaches 430, and until now the map guaranteed nothing
 * inside it — the median field sat 609 units from the nearest station
 * and only 21% fell under anybody's guns, by luck rather than design.
 * Miners were dying at a median of 471 from home, which is precisely
 * the gap between where the guns reach and where the ore was.
 *
 * ------------------------------------------------------------
 * WHY IT IS DELIBERATELY POOR
 * ------------------------------------------------------------
 *
 * Two or three rocks, placed hard against the map's edge where
 * `oreRichness` is lowest. It is a floor, not a living: a faction can
 * survive on it indefinitely and can never win from it, so the pull
 * toward the contested middle is untouched. A generous home field
 * would be a worse bug than the one it fixes — it would remove the
 * reason to leave home at all, and the reason to leave home is the
 * entire simulation.
 *
 * It is placed on the *inward* side of the station, so a miner
 * working it sits between its own guns and the enemy rather than
 * behind the station with its back to the wall.
 */
function placeHomeField(world, station) {
    const inward = world.width * 0.5 - station.x;
    const dir = inward >= 0 ? 1 : -1;
    const reach = station.weapon ? station.weapon.range : 430;

    const field = makeField(world.fields.length);
    field.home = true;
    field.factionId = station.factionId;
    field.x = station.x + dir * reach * HOME_FIELD_RANGE;
    field.y = station.y;

    world.fields.push(field);
    spawnHomeField(world, field);
    return field;
}

/** Rocks for a home field: few, poor, and always in the same place. */
function spawnHomeField(world, field) {
    const n = world.rng.int(HOME_FIELD_ROCKS_MIN, HOME_FIELD_ROCKS_MAX);
    for (let i = 0; i < n; i++) {
        const r = Math.sqrt(world.rng.next()) * FIELD_SCATTER * 0.55;
        const a = world.rng.angle();
        const rock = makeAsteroid(world, field.x + Math.cos(a) * r, field.y + Math.sin(a) * r,
            world.rng.range(ASTEROID_ORE_MIN * 0.8, ASTEROID_ORE_MIN * 1.1));
        rock.fieldId = field.id;
        world.addAsteroid(rock);
    }
    field.emptyAt = -1;
}

/** Put a faction's station at its home position and register it. */
function placeMothership(world, def) {
    const x = def.homeX < 0.5 ? MOTHERSHIP_EDGE_INSET : world.width - MOTHERSHIP_EDGE_INSET;
    const y = world.height * def.homeY;
    const ship = makeShip(world, 'mothership', def.id, x, y, def.homeX < 0.5 ? 0 : Math.PI);
    ship.homeId = ship.id;
    world.addShip(ship);
    world.factions[def.id].motherships.push(ship.id);
    return ship;
}

/**
 * Bring a wiped-out faction back after a delay.
 *
 * Without this the simulation has an absorbing state: the first
 * faction to lose its station can never build again, and the run
 * decays into one faction mining an empty map forever. Since this
 * is meant to be left running and looked at occasionally, that is
 * the worst possible ending — not dramatic, just over.
 *
 * The replacement fades in rather than appearing, and arrives with
 * a fresh stake but no fleet, so the faction that won the exchange
 * keeps a real and visible advantage for a long while afterwards.
 */
export function updateFactionRespawn(world, dt) {
    for (const def of FACTIONS) {
        const faction = world.factions[def.id];
        if (!faction || !isPlayed(def)) continue;   // no station to rebuild

        // Prune ids of stations that no longer exist. In place: this
        // runs for every faction on every step, and `filter` would
        // hand the collector a fresh array sixty times a second for a
        // list that is almost always one element long.
        const stations = faction.motherships;
        for (let i = stations.length - 1; i >= 0; i--) {
            if (!world.ship(stations[i])) stations.splice(i, 1);
        }
        if (stations.length > 0) {
            faction.wipedAt = -1;
            continue;
        }

        if (faction.wipedAt < 0) {
            faction.wipedAt = world.time;
            continue;
        }
        if (world.time - faction.wipedAt < FACTION_RESPAWN_DELAY) continue;

        placeMothership(world, def);
        faction.metal = Math.max(faction.metal, START_METAL);
        faction.wipedAt = -1;
    }
}

/**
 * Choose a centre for a contested field: inside the play area, well
 * clear of both motherships, not on top of another field, and biased
 * toward the middle of the map.
 *
 * ------------------------------------------------------------
 * WHY THE MIDDLE
 * ------------------------------------------------------------
 *
 * Because on a big map, uniform ore means the two factions never
 * meet.
 *
 * The chain the whole simulation runs on is: miners follow ore,
 * fighters follow miners, so the fighting happens where the value
 * is. That works only while the ore is *scarce enough to be worth
 * contesting*. Spread the same clusters over nine times the area and
 * each side simply works the fields on its own half — nobody has any
 * reason to cross, and a run is two economies playing solitaire.
 * Measured directly when the map was first enlarged: `fighter:patrol`
 * became a state that was entered and never left, which is
 * `tests/sim.test.js` noticing that a war had stopped happening.
 *
 * A centre bias fixes it at the root, and gives the map a shape it
 * did not have before. Ore now comes in two kinds, and they mean
 * different things:
 *
 *   home field    poor, safe, on your doorstep, under your guns
 *   contested     rich, in the middle, a long way from anybody's guns
 *
 * So expansion becomes a *choice with a risk profile* rather than a
 * formality, a beaten faction has somewhere to survive without
 * winning, and the front line forms where both sides are pulled —
 * the middle — instead of wherever the seed happened to scatter
 * things. See the home-field placement above.
 *
 * The bias itself is the sum of two uniforms, which is triangular:
 * peaked at the centre, falling linearly to zero at the edges. One
 * line, no tuning constant, and it reads on screen as "the good stuff
 * is out there" rather than as a visible band.
 *
 * Rejection sampling rather than a lattice — a lattice reads as a
 * lattice the moment there are more than about four of anything.
 * Returns false if it could not find a spot, which the caller
 * treats as "fewer fields this run" rather than as an error.
 */
function placeField(world, field) {
    const margin = WORLD_EDGE_MARGIN + FIELD_SCATTER;

    // Attempts scale with how crowded the map is being asked to be.
    // A fixed 90 was ample for seven fields and quietly delivered
    // fewer than asked for at thirty-four.
    const attempts = 60 + ASTEROID_FIELDS * 6;

    for (let attempt = 0; attempt < attempts; attempt++) {
        // Triangular on both axes: two uniforms averaged is peaked at
        // the middle and falls linearly to zero at the walls.
        //
        // Both axes, not just x, and that was not obvious. Biasing x
        // alone leaves the contested "middle" a strip the full 4,200
        // height of the map — an area so large that thirty-odd ships
        // spread across it without ever coming within a fighter's 620
        // of one another. Measured: combat in three of six seeds, and
        // barely. Pulling y in as well turns the strip into a core,
        // and gives the map a shape it can be described in: two home
        // corners, a contested heart, and quiet space at the edges.
        const tx = (world.rng.next() + world.rng.next()) * 0.5;
        const ty = (world.rng.next() + world.rng.next()) * 0.5;
        const x = lerp(margin, world.width - margin, tx);
        const y = lerp(margin, world.height - margin, ty);

        let ok = true;

        for (const ship of world.ships) {
            if (ship.role !== 'mothership') continue;
            if (dist2(x, y, ship.x, ship.y) < FIELD_MOTHERSHIP_CLEARANCE ** 2) { ok = false; break; }
        }
        if (ok) {
            for (const other of world.fields) {
                if (other === field) continue;
                if (dist2(x, y, other.x, other.y) < FIELD_MIN_SEPARATION ** 2) { ok = false; break; }
            }
        }

        if (ok) { field.x = x; field.y = y; return true; }
    }
    return false;
}

/**
 * How rich a rock at this x is, 0 at the walls and 1 at the midline.
 *
 * The ore gradient is the map's economic geography in one function.
 * Placement alone was not enough to make the two factions meet: a
 * miner scores a field as `ore / distance`, so with the same ore
 * everywhere each side works whatever is nearest and the middle of
 * the map is a place neither of them has any reason to be. Ten
 * minutes across six seeds produced 2,376 ore mined and *zero* shots
 * fired — two economies playing solitaire.
 *
 * Making the centre genuinely richer puts the pull into the term that
 * already decides where miners go. Now both sides want the same
 * rocks, and the front line forms where the value is rather than
 * where the seed happened to scatter things.
 *
 * It also does the home field's job for it. Home fields sit against
 * the wall by construction, so they come out poor without a single
 * special case — which is exactly what a floor under a broken economy
 * should be: somewhere to survive, never somewhere to win from.
 *
 * And it is legible, for free: `makeAsteroid` already scales a rock's
 * *radius* with its ore, so a richer middle simply looks like bigger
 * rocks out there. Nothing had to be drawn differently.
 */
/**
 * How rich ore is here, 0..1.
 *
 * Distance to the *nearest station*, not distance to the centre of
 * the map. Those sound like the same gradient and are not: measured
 * from the centre, the top-left corner scores as poorly as a
 * faction's own doorstep, when in fact it is a long way from anybody
 * and ought to be worth the trip. Measured from the stations, every
 * point on the board answers the question a miner is actually
 * asking — how far did I have to come for this?
 *
 * The consequence is the one worth having: the middle of the map is
 * the furthest either side can get from home, so the middle is where
 * the ore is, so the middle is what gets fought over. Territory
 * falls out of the gradient rather than being scripted on top of it.
 */
function oreRichness(world, x, y) {
    let nearest = Infinity;
    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.role !== 'mothership') continue;
        const d = Math.hypot(x - s.x, y - s.y);
        if (d < nearest) nearest = d;
    }
    // Before any station exists — worldgen places home fields as it
    // goes — fall back to the middle being richest, which is what the
    // finished map says anyway.
    if (!Number.isFinite(nearest)) {
        const dx = (x - world.width * 0.5) / (world.width * 0.5);
        const dy = (y - world.height * 0.5) / (world.height * 0.5);
        return 1 - Math.min(1, Math.hypot(dx, dy));
    }
    return Math.min(1, nearest / (world.width * ORE_GRADIENT_REACH));
}

/**
 * How long this field stays empty before it comes back.
 *
 * Scaled by the same gradient, so contested ore renews faster than
 * safe ore. That is what stops the middle being merely *richer* and
 * makes it worth *holding*: a far field you have driven the enemy
 * off is producing again in a couple of minutes, while the poor
 * cluster on your own doorstep takes twice as long to be worth
 * anything. A reason to stay somewhere, rather than only a reason to
 * go there once.
 */
function fieldRespawnDelay(world, field) {
    if (field.home) return ASTEROID_RESPAWN_DELAY;
    const richness = oreRichness(world, field.x, field.y);
    return ASTEROID_RESPAWN_DELAY * lerp(1, ASTEROID_RESPAWN_CONTEST, richness);
}

/** Scatter a fresh cluster of rocks around a field's centre. */
function spawnField(world, field) {
    if (field.capacity === 1) {
        field.capacity = world.rng.range(FIELD_CAPACITY_MIN, FIELD_CAPACITY_MAX);
    }
    // Richness drives how many rocks there are as well as how much is
    // in each, and it has to do both or it does neither.
    //
    // Ore per rock alone spans 70..155 — a 2.2x range — while a
    // field's random capacity spans 0.55..1.75, a 3.2x range that sat
    // on top of it. The gradient was real and completely invisible:
    // measured by distance from the nearest station, fields inside a
    // thousand units averaged *more* ore than those between one and
    // two thousand. Capacity is meant to make fields differ from each
    // other, not to decide the shape of the map.
    const richness = oreRichness(world, field.x, field.y);
    const n = Math.max(2, Math.round(
        world.rng.int(ASTEROIDS_PER_FIELD_MIN, ASTEROIDS_PER_FIELD_MAX)
        * field.capacity * (ORE_GRADIENT_FLOOR + richness * (1 - ORE_GRADIENT_FLOOR) * 2)));
    const peak = lerp(ASTEROID_ORE_MIN, ASTEROID_ORE_MAX, richness)
        * Math.min(1.6, field.capacity);

    for (let i = 0; i < n; i++) {
        // Square-rooted radius gives a uniform area distribution;
        // sampling radius directly bunches everything at the centre.
        const r = Math.sqrt(world.rng.next()) * FIELD_SCATTER;
        const a = world.rng.angle();
        const rock = makeAsteroid(world, field.x + Math.cos(a) * r, field.y + Math.sin(a) * r,
            world.rng.range(peak * 0.72, peak));
        rock.fieldId = field.id;
        world.addAsteroid(rock);
    }
    field.emptyAt = -1;
}

/**
 * Per-step field maintenance: notice exhaustion, then after a delay
 * relocate and refill. Called from the simulation step.
 */
export function updateFields(world, dt) {
    // One pass over the rocks gives every field its live count and
    // remaining ore, so miner decisions later in the step are lookups.
    for (const field of world.fields) {
        field.rocks = 0;
        field.ore = 0;
        field.cx = 0;
        field.cy = 0;
    }
    for (const rock of world.asteroids) {
        if (rock.dead || rock.depleting || rock.fieldId < 0) continue;
        const field = world.fields[rock.fieldId];
        if (!field) continue;
        field.rocks++;
        field.ore += rock.ore;
        field.cx += rock.x;
        field.cy += rock.y;
    }
    // One divide per field rather than a second pass over the rocks.
    // A field with nothing left keeps its nominal centre, which is
    // where a respawn will put the next cluster anyway.
    for (const field of world.fields) {
        if (field.rocks > 0) {
            field.cx /= field.rocks;
            field.cy /= field.rocks;
        } else {
            field.cx = field.x;
            field.cy = field.y;
        }
    }

    for (const field of world.fields) {
        // A claim lapses when its holder dies, so a field is never
        // locked out by a miner that was shot on the way there.
        for (let f = 0; f < field.claimedBy.length; f++) {
            if (field.claimedBy[f] && !world.ship(field.claimedBy[f])) field.claimedBy[f] = 0;
        }

        if (field.rocks > 0) {
            field.emptyAt = -1;
            continue;
        }
        field.claimedBy.length = 0;
        if (field.emptyAt < 0) {
            field.emptyAt = world.time;
            continue;
        }
        if (world.time - field.emptyAt >= fieldRespawnDelay(world, field)) {
            // A home field regrows exactly where it was. Contested ore
            // never comes back where it was spent — that is what keeps
            // the map's centre of gravity moving — but a home field is
            // a *guarantee*, and a guarantee that relocates is not one.
            // Send it through the usual rejection sampler and within a
            // few minutes every faction's floor has wandered off into
            // the middle of the map, which is the one place it must
            // never be.
            if (field.home) {
                spawnHomeField(world, field);
            } else if (placeField(world, field)) {
                spawnField(world, field);
            } else {
                field.emptyAt = world.time;    // crowded map; try again later
            }
        }
    }

    // Fade rocks in on arrival and out on exhaustion.
    for (const rock of world.asteroids) {
        if (rock.depleting) {
            rock.fade -= dt / ASTEROID_RESPAWN_FADE;
            if (rock.fade <= 0) rock.dead = true;
        } else if (rock.fade < 1) {
            rock.fade = Math.min(1, rock.fade + dt / ASTEROID_RESPAWN_FADE);
        }
    }
}

/**
 * Put the neutral market on the board, and open its bubble.
 *
 * On the perpendicular bisector of the two stations, which is where
 * "equidistant" stops being a judgement call: both homes sit on the
 * horizontal midline, so any point on x = width/2 is exactly as far
 * from one as the other, whatever the map's aspect happens to be.
 *
 * Off that midline by TRADE_HUB_INSET, and which side is a coin
 * toss from the world's own RNG. Dead centre is the one place it
 * must not go — see the measurements in constants.js — and always
 * north would make every run the same shape.
 */
function placeExchange(world) {
    const def = FACTIONS.find((f) => f.neutral);
    if (!def) return null;

    const north = world.rng.chance(0.5);
    const x = world.width * 0.5;
    const y = north
        ? world.height * TRADE_HUB_INSET
        : world.height * (1 - TRADE_HUB_INSET);

    const hub = makeShip(world, 'exchange', def.id, x, y, north ? Math.PI * 0.5 : -Math.PI * 0.5);
    hub.fade = 1;                   // a fixed point, like a station
    hub.cargo = hub.cargoMax;       // it opens for business with a float
    world.addShip(hub);

    world.sanctuaries.push({ x, y, r: SANCTUARY_RADIUS });
    return hub;
}

/**
 * The hulls a faction opens the run with.
 *
 * Two miners and two light haulers, standing off its own station.
 *
 * ------------------------------------------------------------
 * WHY START WITH ANYTHING AT ALL
 * ------------------------------------------------------------
 *
 * A faction used to begin with a station, seventy metal and nothing
 * else, so the opening minute of every run was the same shot of two
 * buildings not doing very much while the first miner was paid for.
 * Starting with a working economy skips a preamble that was never
 * interesting and was identical every time.
 *
 * The haulers are the more deliberate half. They have no forward
 * store to serve at t=0 and would ordinarily sit idle — but an idle
 * hauler with a market in reach runs a caravan, so the first thing
 * either faction does now is send freight across the map. The run
 * opens with traffic instead of with a countdown.
 *
 * Placed rather than bought, like the station and the home field: no
 * metal changes hands, so the conservation ledger is untouched.
 */
function placeOpeningFleet(world, station) {
    const inward = world.width * 0.5 - station.x;
    const dir = inward >= 0 ? 1 : -1;

    for (let i = 0; i < OPENING_FLEET.length; i++) {
        const type = OPENING_FLEET[i];
        // Fanned off the station's inward face, so they read as a
        // flotilla standing off it rather than a stack.
        const bearing = (i - (OPENING_FLEET.length - 1) * 0.5) * 0.5;
        const r = station.radius + OPENING_STANDOFF;
        const ship = makeShip(world, type, station.factionId,
            station.x + dir * Math.cos(bearing) * r,
            station.y + Math.sin(bearing) * r,
            dir > 0 ? bearing : Math.PI - bearing);
        ship.fade = 1;
        ship.homeId = station.id;
        world.addShip(ship);
    }
}
