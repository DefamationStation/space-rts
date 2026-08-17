// ============================================================
// BEHAVIOURS — SHARED HELPERS
// ============================================================
//
// Small pieces every state machine needs. Kept separate from
// `index.js` so the individual behaviour modules can import them
// without a cycle through the registry.

import { THREAT_WEIGHT } from '../../core/constants.js';
import { WEAPON_TYPES } from '../../data/weapons.js';
import { damp } from '../../core/math.js';
import { telemetry } from '../../core/telemetry.js';

/**
 * Enter a state and reset its timer.
 *
 * States are plain strings and transitions are explicit. That is a
 * deliberate choice over flags: `if (ship.mining && !ship.full &&
 * ship.hasTarget)` is unreadable after the third condition, and a
 * combination of flags can express states that were never intended.
 * A ship is in exactly one state, always, and `?debug=1` prints it.
 *
 * It is also the single funnel every behaviour change in the project
 * passes through, which is why the flight recorder is hooked here
 * rather than at each call site: the transition stream is complete by
 * construction instead of by anyone remembering to log. Off, that
 * costs one boolean read.
 *
 * `reason` is optional and free. A transition that carries one turns
 * "the miner went home" into "the miner went home *because a hostile
 * came inside the panic radius*", which is the difference between a
 * trace you can read and a trace you can only count.
 */
export function setState(ship, name, reason) {
    if (ship.state === name) return;
    if (telemetry.enabled) telemetry.transition(ship, ship.state, name, reason);
    ship.state = name;
    ship.stateTime = 0;
}

/** The ship's own mothership, or null if it has been destroyed. */
export function homeOf(world, ship) {
    const home = world.ship(ship.homeId);
    if (home) return home;
    // Fall back to any surviving mothership of the same faction, so
    // an orphan re-homes rather than idling forever.
    const faction = world.faction(ship.factionId);
    if (!faction) return null;
    for (let i = 0; i < faction.motherships.length; i++) {
        const ms = world.ship(faction.motherships[i]);
        if (ms) { ship.homeId = ms.id; return ms; }
    }
    return null;
}

/**
 * The nearest place this ship can put ore.
 *
 * A mothership or an outpost, whichever is closer — and that single
 * choice is the whole economic argument for a forward base. Once the
 * near fields are stripped, a miner's round trip is mostly travel,
 * and this turns "haul it all the way home" into "drop it at the shed
 * and get back to work". The long journey still happens; it is just
 * made once, in bulk, by something built for it.
 *
 * An outpost with no room left is skipped, so a faction whose haulers
 * have fallen behind goes back to hauling its own ore rather than
 * queueing at a full shed.
 */
export function depositPoint(world, ship, needRoom = 1) {
    let best = null;
    let bestD2 = Infinity;

    for (let i = 0; i < world.ships.length; i++) {
        const s = world.ships[i];
        if (s.dead || s.factionId !== ship.factionId) continue;
        if (s.role !== 'mothership' && s.role !== 'outpost') continue;
        // A station has unlimited room; a shed does not.
        if (s.role === 'outpost' && s.cargoMax - s.cargo < needRoom) continue;

        const d2 = (s.x - ship.x) ** 2 + (s.y - ship.y) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
}

/**
 * Are these two factions enemies?
 *
 * Today this is `a !== b` and could obviously be written inline. It
 * is a function because it is the seam that everything about
 * hostility has to pass through if there is ever to be a third
 * faction, or an alliance between two of them.
 *
 * `docs/05-ROADMAP.md` identifies the plumbing precisely: every
 * hostility check in the project is a comparison of two faction ids,
 * scattered across target selection, projectile filtering and the
 * miner's threat scan. Alliances turn each of those into a `relations`
 * lookup — which is a one-line change *here* and an archaeology
 * expedition if the comparison has been copied to a dozen call sites
 * in the meantime.
 *
 * The rule that goes with it: no new code writes `1 - factionId` to
 * mean "the enemy". That expression is not merely a shortcut, it is
 * an assertion that there are exactly two sides and that they hate
 * each other, buried somewhere nobody will think to look. Ask this
 * function, or sum over `world.factions`.
 */
export function isHostile(world, a, b) {
    if (a === b) return false;

    const fa = world.factions[a];
    const fb = world.factions[b];
    if (!fa || !fb) return true;

    // The exchange is nobody's enemy, and this is above the swarm
    // check on purpose: a neutral trader is neutral *including*
    // toward the incursion. A hazard that could level the one
    // structure both sides need would make the bubble a promise the
    // simulation does not keep.
    if (fa.neutral || fb.neutral) return false;

    // The swarm is everyone's enemy and nobody's ally.
    if (fa.alien || fb.alien) return true;

    // And while it is on the board, the natives are not enemies.
    //
    // This is the whole truce, and it is two lines because every
    // hostility check in the project — target selection, projectile
    // filtering, the miner's threat scan, posture, escort assignment —
    // already asks this one function. Nothing else has to learn that
    // alliances exist. `docs/05-ROADMAP.md` predicted the plumbing
    // would be the hard part; routing it through here first is what
    // made it not be.
    return !world.truce;
}

/**
 * Is this point inside somebody's no-fire bubble?
 *
 * The exchange's whole mechanic, and it is one predicate because
 * `pickTarget` is the one funnel every acquisition in the project
 * goes through — the same trick that made the alien truce two lines.
 * Nothing else has to learn that sanctuaries exist.
 *
 * Reads `world.sanctuaries`, which worldgen fills once. Scanning the
 * ship list here instead would have put a linear search inside a
 * broadphase callback, which is the hottest path in the simulation.
 */
export function inSanctuary(world, x, y, margin = 0) {
    const list = world.sanctuaries;
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const dx = x - s.x, dy = y - s.y;
        const r = s.r + margin;
        if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
}

/**
 * Pick something to shoot at.
 *
 * Score is `weight / distance`, so a valuable target has to be
 * meaningfully closer to beat a dangerous one, and weights come
 * from a table rather than from code (THREAT_WEIGHT in
 * constants.js). The behaviour that falls out is the one that
 * reads correctly on screen: fighters swat escorts and miners
 * first, and only commit to a mothership when nothing softer is in
 * reach.
 */
export function pickTarget(world, ship, radius, anchorX, anchorY, leash) {
    let best = null;
    let bestScore = 0;
    const leash2 = leash * leash;

    world.shipGrid.queryCircle(ship.x, ship.y, radius, (other) => {
        if (other.dead || !isHostile(world, ship.factionId, other.factionId)) return;
        const weight = THREAT_WEIGHT[other.role] || 0;
        if (weight <= 0) return;

        const dx = other.x - ship.x, dy = other.y - ship.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius * radius) return;

        // Ignore anything that would drag us off our charge.
        const ax = other.x - anchorX, ay = other.y - anchorY;
        if (ax * ax + ay * ay > leash2) return;

        // Nothing inside the bubble is a target, whoever it is and
        // whatever it has done. A hull that runs for the exchange is
        // genuinely safe there, which is the point of the place and
        // is also the one thing that could make it read as broken if
        // it were only *mostly* true.
        if (inSanctuary(world, other.x, other.y)) return;

        const score = weight / (Math.sqrt(d2) + 40);
        if (score > bestScore) { bestScore = score; best = other; }
    });

    return best;
}

/**
 * Ease a 0..1 visual gate. Beams and tethers fade in and out
 * rather than blinking on — gospel rule 5 applies to opacity as
 * much as to motion.
 */
/**
 * How far this hull can shoot, wherever its guns happen to be.
 *
 * Its nose gun's range if it has one, otherwise the longest of its
 * mounts. Two hulls — the natives' frigate and the swarm's harvester —
 * carry no centreline weapon at all, so `ship.weapon.range` is not a
 * reach, it is a crash: both quarantined the moment a behaviour asked
 * how close they had to be.
 *
 * Zero for a hull with nothing, which reads correctly at every call
 * site: an unarmed ship is never in range of anything.
 */
export function weaponReach(ship) {
    if (ship.weapon) return ship.weapon.range;
    let best = 0;
    for (let i = 0; i < ship.mounts.length; i++) {
        const w = WEAPON_TYPES[ship.mounts[i].def.weapon];
        if (w && w.range > best) best = w.range;
    }
    return best;
}

/** Muzzle velocity for lead solutions, on the same terms as `weaponReach`. */
export function weaponSpeed(ship) {
    if (ship.weapon) return ship.weapon.speed;
    for (let i = 0; i < ship.mounts.length; i++) {
        const w = WEAPON_TYPES[ship.mounts[i].def.weapon];
        if (w) return w.speed;
    }
    return 1;
}

export function gate(current, on, dt, rate = 9) {
    return damp(current, on ? 1 : 0, rate, dt);
}

/** Golden angle — successive multiples spread evenly on a circle. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Scratch result for `berth`. Callers must consume it immediately. */
const _berth = { x: 0, y: 0 };

/**
 * Where a child ship should sit while docked with a parent.
 *
 * Everything that docks needs its *own* spot. Sending two drones to
 * their miner's exact centre puts them on top of each other, where
 * mutual separation shoves them apart at near-maximum force while
 * arrival drags them back together — a limit cycle that parks the
 * pair about thirty units out, permanently just short of unloading
 * range. The economy stops and nothing looks obviously wrong.
 *
 * Berths fix it structurally: each child gets a fixed direction
 * derived from its id, so two of them are naturally far enough
 * apart that separation between them is negligible, and each has a
 * stationary point to settle onto.
 *
 * The angle is in world space, not relative to the parent's
 * heading — a berth that rotates with the parent is a berth the
 * child spends its life chasing.
 */
export function berth(child, parent, distance) {
    const a = child.id * GOLDEN_ANGLE;
    _berth.x = parent.x + Math.cos(a) * distance;
    _berth.y = parent.y + Math.sin(a) * distance;
    return _berth;
}
