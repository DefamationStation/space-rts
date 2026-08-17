// ============================================================
// TURRETS — GUNS THAT AIM THEMSELVES
// ============================================================
//
// Until now every weapon in the project fired along the hull's nose,
// inside a narrow cone. That is exactly right for a fighter — its
// gun is bolted to a dart and pointing the gun *is* flying the
// aircraft, which is the whole reason attack runs look the way they
// do — and it is completely wrong for anything with mass.
//
// A frigate should not have to turn its whole hull to shoot. It
// should hold its course, indifferent, while six mounts swing
// independently and track a fighter crossing its stern. That single
// difference is most of what separates a warship from a big fighter,
// and none of it is a stat: it is entirely in what the guns do while
// the hull ignores them.
//
// ------------------------------------------------------------
// ARCS ARE THE POINT
// ------------------------------------------------------------
//
// Every mount has a rest bearing and an arc it can traverse within,
// both measured in hull-local space. A mount on the port beam simply
// cannot bear on something to starboard, so a frigate with a target
// on one side is a frigate fighting at half weight — and turning to
// bring the other broadside round is a real decision made of real
// seconds.
//
// That is where the beauty comes from. Unlimited traverse would let
// every gun engage everything, which reads as a hull surrounded by
// spinning dots. Limited arcs mean guns are *idle* much of the time,
// resting at their splay, and a ship manoeuvring to unmask them is
// legible from across the map without a single number on screen.
//
// ------------------------------------------------------------
// WHY MOUNTS CARRY THEIR OWN CADENCE
// ------------------------------------------------------------
//
// Six guns sharing the hull's single `readyAt` would fire as one
// volley forever, perfectly in lockstep, which looks mechanical in
// the bad way. Each mount owning its burst state lets them drift out
// of phase within a few seconds on their own, so a broadside becomes
// a ripple rather than a click. No jitter, no randomisation — just
// six independent clocks started at different moments.

import { EV } from '../core/events.js';
import { makeProjectile } from './entities.js';
import { WEAPON_TYPES, weaponHeft } from '../data/weapons.js';
import { THREAT_WEIGHT, RECOIL_KICK, TURRET_FIRE_CONE } from '../core/constants.js';
import { inSanctuary } from './behaviors/common.js';
import { burstFan } from './combat.js';
import { wrapAngle, turnToward, interceptPoint } from '../core/math.js';
import { isHostile } from './behaviors/common.js';

/** Scratch for the lead solve — reused, never allocated per call. */
const _lead = { x: 0, y: 0 };

/**
 * Build the live state for one hull's mounts from its class data.
 * Called by `makeShip`, so a turreted ship is turreted from birth.
 */
export function makeMounts(def) {
    if (!def.mounts) return [];
    return def.mounts.map((m) => ({
        def: m,
        /** Current bearing, hull-local. Starts at rest. */
        angle: m.rest,
        targetId: 0,
        retargetAt: 0,
        burstLeft: 0,
        nextShotAt: 0,
        readyAt: 0,
        /** 0..1 — how far this gun is from its rest bearing, for the renderer. */
        load: 0,
    }));
}

/**
 * Run every mount on a ship: pick, track, fire.
 *
 * Deliberately independent of the hull's behaviour. A ship's state
 * machine decides where it goes; its guns decide what they shoot.
 * They never argue, because they are answering different questions —
 * and that separation is why a retreating frigate still fires on the
 * things chasing it.
 */
export function stepTurrets(world, ship, dt) {
    const mounts = ship.mounts;
    if (!mounts || !mounts.length) return;

    for (let i = 0; i < mounts.length; i++) {
        const mount = mounts[i];
        const weapon = WEAPON_TYPES[mount.def.weapon];
        if (!weapon || !weapon.damage) continue;

        const target = pickForMount(world, ship, mount, weapon);

        if (!target) {
            // Idle guns return to their splay. A turret left pointing
            // wherever its last target died reads as broken; one that
            // relaxes reads as a crew standing down.
            mount.angle = turnToward(mount.angle, mount.def.rest, mount.def.traverse * dt);
            mount.load = 0;
            continue;
        }

        // Lead the target, then convert the world bearing into the
        // hull-local frame the arc is defined in.
        interceptPoint(mountX(ship, mount), mountY(ship, mount),
            target.x, target.y, target.vx, target.vy, weapon.speed, _lead);
        const want = Math.atan2(_lead.y - mountY(ship, mount), _lead.x - mountX(ship, mount));
        const local = clampToArc(wrapAngle(want - ship.angle), mount.def);

        mount.angle = turnToward(mount.angle, local, mount.def.traverse * dt);
        mount.load = Math.min(1, Math.abs(wrapAngle(mount.angle - mount.def.rest))
            / Math.max(0.001, mount.def.arc));

        // Only fire once the gun is actually on target. A turret that
        // shoots while still slewing is a turret that misses, and it
        // also loses the beat where the gun settles before it speaks.
        if (Math.abs(wrapAngle(mount.angle - local)) > TURRET_FIRE_CONE) continue;
        fireMount(world, ship, mount, weapon);
    }
}

/** World position of a mount, with the hull's rotation applied. */
export function mountX(ship, mount) {
    return ship.x + mount.def.x * Math.cos(ship.angle) - mount.def.y * Math.sin(ship.angle);
}

export function mountY(ship, mount) {
    return ship.y + mount.def.x * Math.sin(ship.angle) + mount.def.y * Math.cos(ship.angle);
}

/**
 * Hold a bearing inside the mount's arc.
 *
 * Returns the nearest legal bearing rather than giving up, so a gun
 * whose target has swung out of its arc tracks to the edge and waits
 * there — which is what makes an unmasking manoeuvre read: the guns
 * are already pressed against their stops, straining, before the hull
 * finishes turning.
 */
function clampToArc(local, def) {
    const off = wrapAngle(local - def.rest);
    if (off > def.arc) return wrapAngle(def.rest + def.arc);
    if (off < -def.arc) return wrapAngle(def.rest - def.arc);
    return local;
}

/**
 * What this gun should be shooting.
 *
 * Per mount rather than per ship, throttled on its own clock, and
 * restricted to what it can actually bear on — so the two broadsides
 * of a frigate genuinely fight different battles.
 */
function pickForMount(world, ship, mount, weapon) {
    const held = world.ship(mount.targetId);
    if (held && world.time < mount.retargetAt && inReach(ship, mount, held, weapon)) return held;

    mount.retargetAt = world.time + 0.45;

    let best = null;
    let bestScore = 0;
    const mx = mountX(ship, mount), my = mountY(ship, mount);

    world.shipGrid.queryCircle(mx, my, weapon.range, (other) => {
        if (other.dead || !isHostile(world, ship.factionId, other.factionId)) return;
        const threat = THREAT_WEIGHT[other.role] || 0;
        if (threat <= 0) return;
        // Nothing inside a no-fire bubble is a target — for a mount
        // either.
        //
        // `pickTarget` has refused these since the exchange existed,
        // but a mount picks its own target and never asked. The hulls
        // that suffer are exactly the turret-only ones — the frigate,
        // and the swarm's harvester — so what a viewer saw was the
        // swarm firing into the market and the rounds simply not
        // landing, which reads as broken collision rather than as a
        // rule being enforced. The rounds were being discarded on
        // impact; they should never have been fired.
        if (inSanctuary(world, other.x, other.y, other.radius)) return;
        // Some guns will not shoot at some classes at all. See
        // `minTargetRadius` on the torpedo — a weapon that cannot lead
        // a nimble target should not be aiming at one, and refusing
        // here is what turns a 6.5% weapon into one that connects.
        if (weapon.minTargetRadius && other.radius < weapon.minTargetRadius) return;
        if (!inReach(ship, mount, other, weapon)) return;

        const d = Math.hypot(other.x - mx, other.y - my);
        const score = threat / (d + 40);
        if (score > bestScore) { bestScore = score; best = other; }
    });

    mount.targetId = best ? best.id : 0;
    return best;
}

/** In range, and inside the arc this mount can swing to. */
function inReach(ship, mount, target, weapon) {
    const mx = mountX(ship, mount), my = mountY(ship, mount);
    const dx = target.x - mx, dy = target.y - my;
    if (dx * dx + dy * dy > weapon.range * weapon.range) return false;
    const local = wrapAngle(Math.atan2(dy, dx) - ship.angle);
    return Math.abs(wrapAngle(local - mount.def.rest)) <= mount.def.arc;
}

/** As `tryFire`, but on the mount's own clock and from the mount's own muzzle. */
function fireMount(world, ship, mount, w) {
    if (mount.burstLeft <= 0) {
        if (world.time < mount.readyAt) return;
        mount.burstLeft = w.burst;
        mount.nextShotAt = world.time;
    }
    if (world.time < mount.nextShotAt) return;

    const a = ship.angle + mount.angle + world.rng.spread(w.spread)
        + burstFan(w, mount.burstLeft);
    const mx = mountX(ship, mount) + Math.cos(a) * w.muzzleOffset * 0.5;
    const my = mountY(ship, mount) + Math.sin(a) * w.muzzleOffset * 0.5;

    // A guided round is launched *at* the thing this mount is
    // tracking, and carries that id with it. Everything else is
    // pointed and forgotten.
    world.addProjectile(makeProjectile(
        world, mx, my,
        Math.cos(a) * w.speed + ship.vx,
        Math.sin(a) * w.speed + ship.vy,
        w, ship.factionId, ship.id,
        w.kind === 'seeker' ? mount.targetId : 0,
    ));

    // A turreted hull kicks less than a fighter: the gun recoils, not
    // the ship. Enough to register, not enough to shove a frigate.
    ship.recoil = Math.max(ship.recoil, RECOIL_KICK * 0.35 * weaponHeft(w));

    mount.burstLeft--;
    if (mount.burstLeft > 0) mount.nextShotAt = world.time + w.burstGapMs / 1000;
    else mount.readyAt = world.time + w.cooldownMs / 1000;

    world.events.emit(EV.SHOT_FIRED, {
        x: mx, y: my, angle: a, faction: ship.factionId, weapon: w, id: ship.id,
    });
}
